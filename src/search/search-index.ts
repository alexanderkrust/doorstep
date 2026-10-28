import { existsSync, statSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../import/index-writer.js';
import { boundingBox, distanceKm, gridCellsInBox } from './geo.js';
import { nameForms, normalizeTokens } from './normalize.js';
import {
  inTextColumns,
  queryVariants,
  withinCells,
  withoutHousenumbers,
  withoutSingleLetters,
} from './query.js';
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
  district: string | null;
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
  p.housenumber, p.postcode, p.city, p.district, p.state, p.country, p.lat, p.lon`;

/** Spaltengewichte für bm25: name, street, housenumber, postcode, city, cell. */
const BM25 = 'bm25(places_fts, 4.0, 2.0, 1.0, 1.0, 1.0, 0.0)';
/**
 * So viele Kandidaten gehen je Abfrage ins Ranking. Die IDs sind nach Wichtigkeit
 * vergeben und FTS5 liefert in ID-Reihenfolge: Die ersten Treffer sind also die
 * wichtigsten, ohne dass alle Treffer bewertet werden müssen.
 */
const CANDIDATES = 200;
/** Umkreis für die zusätzlichen Kandidaten bei gesetztem Standort. */
const LOCAL_RADIUS_KM = 25;
/** Mehr Rasterzellen (nur in Polnähe) machen die Anfrage teurer als eine Prüfung aller Treffer. */
const MAX_LOCAL_CELLS = 64;
/**
 * Ab so vielen globalen Kandidaten im Umkreis wird ohne Rasterzellen gesucht: Bei
 * 10 von 200 sind 200 nahe Treffer nach etwa 4.000 geprüften erreicht.
 */
const LOCAL_DENSE_HITS = 10;
/** Gleichnamige Treffer (z. B. Abschnitte einer Straße) in diesem Abstand werden zusammengefasst. */
const DEDUPE_RADIUS_KM = 2;

/** Gleiche Treffer haben denselben Typ, Namen und dieselbe Adresse. */
const dedupeKey = (row: PlaceRow) =>
  [row.type, row.name, row.name_de, row.name_en, row.street, row.housenumber]
    .map((v) => v?.toLowerCase() ?? '')
    .join('|');

/** Startradius der Umkreissuche; wird verdoppelt, bis genug Treffer da sind. */
const REVERSE_START_RADIUS_KM = 0.05;

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

/** Identität einer Datei: Ein atomarer Tausch per rename liefert eine neue Inode. */
function fileIdentity(path: string): string | null {
  try {
    const s = statSync(path);
    return `${String(s.dev)}:${String(s.ino)}:${String(s.size)}:${String(s.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** Eine geöffnete Indexdatei mit vorbereiteten Abfragen. */
interface OpenIndex {
  db: DatabaseSync;
  identity: string | null;
  meta: Record<string, string>;
  search: StatementSync;
  searchLocal: StatementSync;
  box: StatementSync;
}

/** Öffnet und prüft eine Indexdatei. Wirft `IndexUnavailableError` bei falschem Schema. */
function openIndexFile(path: string): OpenIndex {
  // Identität vor dem Öffnen lesen: Wird die Datei dazwischen getauscht,
  // fällt das beim nächsten Vergleich auf und sie wird erneut geladen.
  const identity = fileIdentity(path);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    throw new IndexUnavailableError(`Index ${path} lässt sich nicht öffnen: ${String(err)}`);
  }
  try {
    let meta: Record<string, string>;
    try {
      const rows = db.prepare('SELECT key, value FROM meta').all() as unknown as {
        key: string;
        value: string;
      }[];
      meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    } catch (err) {
      throw new IndexUnavailableError(`Index ${path} ist nicht lesbar: ${String(err)}`);
    }
    const version = meta['schema_version'];
    if (version !== String(SCHEMA_VERSION)) {
      throw new IndexUnavailableError(
        `Index hat Schema-Version ${version ?? 'unbekannt'}, erwartet wird ${String(SCHEMA_VERSION)}. ` +
          'Bitte neu importieren.',
      );
    }
    return {
      db,
      identity,
      meta,
      search: db.prepare(`SELECT p.id, ${COLUMNS}, p.importance, f.bm25
        FROM (SELECT rowid AS id, ${BM25} AS bm25 FROM places_fts
               WHERE places_fts MATCH ? LIMIT ${String(CANDIDATES)}) f
        JOIN places p ON p.id = f.id`),
      // Alle Treffer im Umkreis, nicht nur die wichtigsten: Nahe Adressen haben die
      // niedrigste Wichtigkeit und stehen in FTS-Reihenfolge ganz hinten. Die Anfrage
      // enthält die Rasterzellen der Box, FTS5 verschneidet dann die Trefferlisten.
      searchLocal: db.prepare(`SELECT p.id, ${COLUMNS}, p.importance, ${BM25} AS bm25
        FROM places_fts JOIN places p ON p.id = places_fts.rowid
        WHERE places_fts MATCH ?
          AND p.lat BETWEEN ? AND ? AND p.lon BETWEEN ? AND ?
        LIMIT ${String(CANDIDATES)}`),
      box: db.prepare(`SELECT ${COLUMNS} FROM places_rtree r JOIN places p ON p.id = r.id
        WHERE r.max_lat >= ? AND r.min_lat <= ? AND r.max_lon >= ? AND r.min_lon <= ?`),
    };
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Lesender Zugriff auf `index.sqlite`. Die Datei wird beim ersten Zugriff
 * geöffnet, damit die API auch startet, bevor ein Import gelaufen ist.
 *
 * Updates ersetzen die Datei per atomarem rename. Die geöffnete alte Datei
 * bleibt bis zum Neuladen lesbar (unter Unix lebt sie, solange sie offen ist);
 * `reloadIfChanged()` wechselt dann ohne Unterbrechung auf die neue.
 */
export class SearchIndex {
  private current: OpenIndex | null = null;

  constructor(readonly path: string) {}

  /**
   * Öffnet den Index, falls vorhanden; `false`, wenn noch keiner existiert.
   * Wirft `IndexUnavailableError`, wenn die Datei ein anderes Schema hat.
   */
  open(): boolean {
    if (this.current) return true;
    if (!existsSync(this.path)) return false;
    this.current = openIndexFile(this.path);
    return true;
  }

  /**
   * Lädt den Index neu, wenn unter `path` inzwischen eine andere Datei liegt.
   * Liefert `true` nach einem Wechsel. Ist die neue Datei unbrauchbar, bleibt der
   * alte Index aktiv und es wird `IndexUnavailableError` geworfen. Ist noch kein
   * Index geöffnet, passiert nichts (das übernimmt der nächste Zugriff).
   */
  reloadIfChanged(): boolean {
    const old = this.current;
    if (!old) return false;
    const identity = fileIdentity(this.path);
    if (identity === null || identity === old.identity) return false;

    let next: OpenIndex;
    try {
      next = openIndexFile(this.path);
    } catch (err) {
      // Nicht bei jedem Aufruf erneut versuchen, erst wenn sich die Datei wieder ändert.
      old.identity = identity;
      throw err;
    }
    // Abfragen laufen synchron: Zwischen diesen Zeilen kann keine Anfrage dazwischenkommen.
    this.current = next;
    old.db.close();
    return true;
  }

  /** Metadaten des geöffneten Index (`places`, `imported_at`, `source`, …); sonst `null`. */
  meta(): Readonly<Record<string, string>> | null {
    return this.current?.meta ?? null;
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  /**
   * Autosuggest; `null`, wenn kein Index vorhanden ist.
   *
   * Reihenfolge, die erste mit Treffern gewinnt:
   * 1. die Anfrage wie eingegeben, sonst ohne einzelne Buchstaben ("Frankfurt a.M."),
   *    jeweils mit Hausnummer und sonst auf Straßenebene (Hausnummer fehlt in OSM);
   * 2. dasselbe mit Tippfehler-Toleranz am letzten Wort.
   * Die Straße im genannten Ort geht so vor einer Hausnummer in einem ähnlich
   * geschriebenen Ort ("… 1 Bonn" findet nicht "… 1 Bönen").
   */
  search(options: SearchOptions): PlaceRow[] | null {
    if (!this.open()) return null;
    const tokens = normalizeTokens(options.q);
    const tokenSets = [tokens];
    const withoutLetters = withoutSingleLetters(tokens);
    if (withoutLetters) tokenSets.push(withoutLetters);

    for (const typos of [false, true]) {
      for (const set of tokenSets) {
        const hits = this.rankedSearch(set, options, typos);
        if (hits.length > 0) return hits.slice(0, options.limit);

        const streetTokens = withoutHousenumbers(set);
        if (!streetTokens) continue;
        const streets = this.rankedSearch(streetTokens, options, typos).filter(
          (row) => row.type !== 'house',
        );
        if (streets.length > 0) return streets.slice(0, options.limit);
      }
    }
    return [];
  }

  /**
   * Erste Query-Variante mit Treffern, gerankt. Ohne `typos` nur die Anfrage selbst,
   * mit `typos` nur die Varianten mit gekürztem letztem Wort.
   */
  private rankedSearch(
    tokens: readonly string[],
    options: SearchOptions,
    typos: boolean,
  ): RankedRow[] {
    const { lat, lon } = options;
    const hasLocation = lat !== undefined && lon !== undefined;
    const [exact, ...trimmed] = queryVariants(tokens);
    const variants = typos ? trimmed : exact === undefined ? [] : [exact];
    for (const match of variants) {
      const rows = (this.current?.search.all(inTextColumns(match)) ??
        []) as unknown as CandidateRow[];
      // Weniger als CANDIDATES Treffer: Alle sind schon dabei, auch die nahen.
      if (hasLocation && rows.length >= CANDIDATES) {
        // Treffer in der Nähe, die es global nicht unter die ersten Kandidaten schaffen.
        const seen = new Set(rows.map((r) => r.id));
        for (const row of this.localCandidates(match, lat, lon, rows)) {
          if (!seen.has(row.id)) rows.push(row);
        }
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

  /**
   * Die wichtigsten Treffer im Umkreis. Über die Rasterzellen der Box muss FTS5 nur
   * Treffer in der Nähe liefern; die Dauer hängt so von der Dichte im Umkreis ab,
   * nicht von der Zahl der Treffer im ganzen Index. Liegen schon unter den globalen
   * Kandidaten viele im Umkreis, sind die nahen Treffer auch ohne Zellen schnell
   * gefunden, und das Zählen der Zellen für bm25 entfällt. Beide Wege liefern
   * dieselben Zeilen.
   */
  private localCandidates(
    match: string,
    lat: number,
    lon: number,
    globalRows: readonly CandidateRow[],
  ): CandidateRow[] {
    const box = boundingBox(lat, lon, LOCAL_RADIUS_KM);
    const [minLat, maxLat, minLon, maxLon] = box;
    const inBox = globalRows.filter(
      (r) => r.lat >= minLat && r.lat <= maxLat && r.lon >= minLon && r.lon <= maxLon,
    ).length;
    const cells = gridCellsInBox(box);
    const useCells = inBox < LOCAL_DENSE_HITS && cells.length <= MAX_LOCAL_CELLS;
    const query = useCells ? withinCells(match, cells) : inTextColumns(match);
    return (this.current?.searchLocal.all(query, ...box) ?? []) as unknown as CandidateRow[];
  }

  /** Nächste Objekte zum Punkt über den R*Tree; `null`, wenn kein Index vorhanden ist. */
  reverse(options: ReverseOptions): PlaceRow[] | null {
    if (!this.open()) return null;
    const { lat, lon, limit, radiusKm } = options;
    let radius = Math.min(REVERSE_START_RADIUS_KM, radiusKm);
    for (;;) {
      const candidates = (this.current?.box.all(...boundingBox(lat, lon, radius)) ??
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
    this.current?.db.close();
    this.current = null;
  }
}
