import { existsSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../import/index-writer.js';
import { distanceKm } from './geo.js';
import { nameForms, normalizeTokens } from './normalize.js';
import { queryVariants, withoutHousenumbers } from './query.js';
import { dedupeNearby, rank, type Candidate } from './ranking.js';

export { distanceKm };

/** Eine Zeile aus `places`, wie sie die API ausliefert. */
export interface PlaceRow {
  osm_type: 'N' | 'W' | 'R';
  osm_id: number;
  type: string;
  name: string | null;
  name_de: string | null;
  name_en: string | null;
  street: string | null;
  housenumber: string | null;
  postcode: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  lat: number;
  lon: number;
}

export interface SearchOptions {
  q: string;
  limit: number;
  /** Optionaler Standort (Location Bias): Treffer in der Nähe werden angehoben. */
  lat?: number;
  lon?: number;
}

export interface ReverseOptions {
  lat: number;
  lon: number;
  limit: number;
  /** Suchradius in Kilometern. */
  radiusKm: number;
}

interface CandidateRow extends PlaceRow {
  id: number;
  importance: number;
  bm25: number;
}

type RankedRow = CandidateRow & Candidate;

const COLUMNS = `p.osm_type, p.osm_id, p.type, p.name, p.name_de, p.name_en, p.street,
  p.housenumber, p.postcode, p.city, p.state, p.country, p.lat, p.lon`;

/** Spaltengewichte für bm25: name, street, housenumber, postcode, city. */
const BM25 = 'bm25(places_fts, 4.0, 2.0, 1.0, 1.0, 1.0)';
/**
 * So viele Kandidaten gehen je Abfrage ins Ranking. Die IDs sind nach Wichtigkeit
 * vergeben und FTS5 liefert in ID-Reihenfolge: Die ersten Treffer sind also die
 * wichtigsten, ohne dass alle Treffer bewertet werden müssen.
 */
const CANDIDATES = 200;
/** So viele Treffer werden bei gesetztem Standort höchstens nach nahen durchsucht. */
const LOCAL_SCAN = 20_000;
/** Umkreis für die zusätzlichen Kandidaten bei gesetztem Standort. */
const LOCAL_RADIUS_KM = 25;
/** Gleichnamige Treffer (z. B. Abschnitte einer Straße) in diesem Abstand werden zusammengefasst. */
const DEDUPE_RADIUS_KM = 2;

/** Gleiche Treffer haben denselben Typ, Namen und dieselbe Adresse. */
const dedupeKey = (row: PlaceRow) =>
  [row.type, row.name, row.name_de, row.name_en, row.street, row.housenumber]
    .map((v) => v?.toLowerCase() ?? '')
    .join('|');

const KM_PER_DEGREE_LAT = 111.32;
/** Startradius der Umkreissuche; wird verdoppelt, bis genug Treffer da sind. */
const REVERSE_START_RADIUS_KM = 0.05;

/** Box, die einen Kreis um den Punkt sicher enthält: [minLat, maxLat, minLon, maxLon]. */
function boundingBox(lat: number, lon: number, radiusKm: number): [number, number, number, number] {
  const dLat = radiusKm / KM_PER_DEGREE_LAT;
  const dLon = Math.min(180, radiusKm / (KM_PER_DEGREE_LAT * Math.max(0.01, cosDeg(lat))));
  return [lat - dLat, lat + dLat, lon - dLon, lon + dLon];
}

/** Namen, mit denen die Anfrage im Ranking verglichen wird. */
function candidateNames(row: PlaceRow): string[] {
  const names = [row.name, row.name_de, row.name_en].flatMap(nameForms);
  if (row.street && row.housenumber) names.push(...nameForms(`${row.street} ${row.housenumber}`));
  return names;
}

/** Der Index ist da, aber nicht nutzbar (z. B. altes Schema). */
export class IndexUnavailableError extends Error {
  override name = 'IndexUnavailableError';
}

/**
 * Lesender Zugriff auf `index.sqlite`. Die Datei wird beim ersten Zugriff
 * geöffnet, damit die API auch startet, bevor ein Import gelaufen ist.
 */
export class SearchIndex {
  private db: DatabaseSync | null = null;
  private searchStmt: StatementSync | null = null;
  private searchLocalStmt: StatementSync | null = null;
  private boxStmt: StatementSync | null = null;

  constructor(readonly path: string) {}

  /**
   * Öffnet den Index, falls vorhanden; `false`, wenn noch keiner existiert.
   * Wirft `IndexUnavailableError`, wenn die Datei ein anderes Schema hat.
   */
  open(): boolean {
    if (this.db) return true;
    if (!existsSync(this.path)) return false;
    const db = new DatabaseSync(this.path, { readOnly: true });
    try {
      const version = (
        db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
          { value: string } | undefined
      )?.value;
      if (version !== String(SCHEMA_VERSION)) {
        throw new IndexUnavailableError(
          `Index hat Schema-Version ${version ?? 'unbekannt'}, erwartet wird ${String(SCHEMA_VERSION)}. ` +
            'Bitte neu importieren.',
        );
      }
      const matches = (limit: number) => `SELECT p.id, ${COLUMNS}, p.importance, f.bm25
        FROM (SELECT rowid AS id, ${BM25} AS bm25 FROM places_fts
               WHERE places_fts MATCH ? LIMIT ${String(limit)}) f
        JOIN places p ON p.id = f.id`;
      this.searchStmt = db.prepare(matches(CANDIDATES));
      this.searchLocalStmt = db.prepare(`${matches(LOCAL_SCAN)}
        WHERE p.lat BETWEEN ? AND ? AND p.lon BETWEEN ? AND ?
        LIMIT ${String(CANDIDATES)}`);
      this.boxStmt = db.prepare(`SELECT ${COLUMNS} FROM places_rtree r JOIN places p ON p.id = r.id
        WHERE r.max_lat >= ? AND r.min_lat <= ? AND r.max_lon >= ? AND r.min_lon <= ?`);
    } catch (err) {
      db.close();
      throw err;
    }
    this.db = db;
    return true;
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  /** Autosuggest; `null`, wenn kein Index vorhanden ist. */
  search(options: SearchOptions): PlaceRow[] | null {
    if (!this.open()) return null;
    const tokens = normalizeTokens(options.q);
    const hits = this.rankedSearch(tokens, options);
    if (hits.length > 0) return hits.slice(0, options.limit);

    // Hausnummer fehlt in OSM: Treffer auf Straßenebene zurückgeben.
    const streetTokens = withoutHousenumbers(tokens);
    if (!streetTokens) return [];
    return this.rankedSearch(streetTokens, options)
      .filter((row) => row.type !== 'house')
      .slice(0, options.limit);
  }

  /** Erste Query-Variante mit Treffern, gerankt. */
  private rankedSearch(tokens: readonly string[], options: SearchOptions): RankedRow[] {
    const { lat, lon } = options;
    const hasLocation = lat !== undefined && lon !== undefined;
    for (const match of queryVariants(tokens)) {
      const rows = (this.searchStmt?.all(match) ?? []) as unknown as CandidateRow[];
      if (hasLocation) {
        // Treffer in der Nähe, die es global nicht unter die ersten Kandidaten schaffen.
        const box = boundingBox(lat, lon, LOCAL_RADIUS_KM);
        const local = (this.searchLocalStmt?.all(match, ...box) ?? []) as unknown as CandidateRow[];
        const seen = new Set(rows.map((r) => r.id));
        for (const row of local) if (!seen.has(row.id)) rows.push(row);
      }
      if (rows.length === 0) continue;

      const candidates: RankedRow[] = rows.map((row) => ({
        ...row,
        names: candidateNames(row),
        ...(hasLocation ? { distanceKm: distanceKm(lat, lon, row.lat, row.lon) } : {}),
      }));
      return dedupeNearby(rank(candidates, tokens), dedupeKey, DEDUPE_RADIUS_KM);
    }
    return [];
  }

  /** Nächste Objekte zum Punkt über den R*Tree; `null`, wenn kein Index vorhanden ist. */
  reverse(options: ReverseOptions): PlaceRow[] | null {
    if (!this.open()) return null;
    const { lat, lon, limit, radiusKm } = options;
    let radius = Math.min(REVERSE_START_RADIUS_KM, radiusKm);
    for (;;) {
      const candidates = (this.boxStmt?.all(...boundingBox(lat, lon, radius)) ??
        []) as unknown as PlaceRow[];
      // Nur Treffer innerhalb des Kreises sind sicher die nächsten.
      const inCircle = candidates
        .map((row) => ({ row, d: distanceKm(lat, lon, row.lat, row.lon) }))
        .filter((c) => c.d <= radius)
        .sort((a, b) => a.d - b.d);
      if (inCircle.length >= limit || radius >= radiusKm) {
        return inCircle.slice(0, limit).map((c) => c.row);
      }
      radius = Math.min(radius * 2, radiusKm);
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.searchStmt = null;
    this.searchLocalStmt = null;
    this.boxStmt = null;
  }
}

function cosDeg(deg: number): number {
  return Math.cos((deg * Math.PI) / 180);
}
