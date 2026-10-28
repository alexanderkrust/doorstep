import { existsSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { queryVariants, tokenize } from './query.js';

/** Eine Zeile aus `places`, wie sie die API ausliefert. */
export interface PlaceRow {
  osm_type: 'N' | 'W' | 'R';
  osm_id: number;
  type: string;
  name: string | null;
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
  /** Optionaler Standort; bei gleichem Typ gewinnen nahe Treffer. */
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

const COLUMNS = `p.osm_type, p.osm_id, p.type, p.name, p.street, p.housenumber, p.postcode,
  p.city, p.state, p.country, p.lat, p.lon`;

const KM_PER_DEGREE_LAT = 111.32;
const EARTH_RADIUS_KM = 6371.0088;
/** Startradius der Umkreissuche; wird verdoppelt, bis genug Treffer da sind. */
const REVERSE_START_RADIUS_KM = 0.05;

/** Großkreisentfernung in Kilometern. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Lesender Zugriff auf `index.sqlite`. Die Datei wird beim ersten Zugriff
 * geöffnet, damit die API auch startet, bevor ein Import gelaufen ist.
 */
export class SearchIndex {
  private db: DatabaseSync | null = null;
  private searchStmt: StatementSync | null = null;
  private searchNearStmt: StatementSync | null = null;
  private boxStmt: StatementSync | null = null;

  constructor(readonly path: string) {}

  /** Öffnet den Index, falls vorhanden; `false`, wenn noch keiner existiert. */
  open(): boolean {
    if (this.db) return true;
    if (!existsSync(this.path)) return false;
    const db = new DatabaseSync(this.path, { readOnly: true });
    // Rangfolge: Typ-Wichtigkeit, dann (optional) Nähe, dann FTS-Relevanz.
    // Das eigentliche Ranking kommt in Phase 4.
    const base = `SELECT ${COLUMNS} FROM places_fts f JOIN places p ON p.id = f.rowid
                   WHERE places_fts MATCH ?`;
    this.searchStmt = db.prepare(`${base} ORDER BY p.importance DESC, bm25(places_fts) LIMIT ?`);
    // Abstand in Grad², Längengrade mit cos(lat) skaliert; reicht für die Reihenfolge.
    this.searchNearStmt = db.prepare(`${base}
      ORDER BY p.importance DESC,
               (p.lat - ?) * (p.lat - ?) + (p.lon - ?) * (p.lon - ?) * ?,
               bm25(places_fts)
      LIMIT ?`);
    this.boxStmt = db.prepare(`SELECT ${COLUMNS} FROM places_rtree r JOIN places p ON p.id = r.id
      WHERE r.max_lat >= ? AND r.min_lat <= ? AND r.max_lon >= ? AND r.min_lon <= ?`);
    this.db = db;
    return true;
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  /** Autosuggest; `null`, wenn kein Index vorhanden ist. */
  search(options: SearchOptions): PlaceRow[] | null {
    if (!this.open()) return null;
    const { limit, lat, lon } = options;
    for (const match of queryVariants(tokenize(options.q))) {
      const rows =
        lat !== undefined && lon !== undefined
          ? this.searchNearStmt?.all(match, lat, lat, lon, lon, cosSquared(lat), limit)
          : this.searchStmt?.all(match, limit);
      if (rows && rows.length > 0) return rows as unknown as PlaceRow[];
    }
    return [];
  }

  /** Nächste Objekte zum Punkt über den R*Tree; `null`, wenn kein Index vorhanden ist. */
  reverse(options: ReverseOptions): PlaceRow[] | null {
    if (!this.open()) return null;
    const { lat, lon, limit, radiusKm } = options;
    let radius = Math.min(REVERSE_START_RADIUS_KM, radiusKm);
    for (;;) {
      // Box, die den Kreis mit `radius` sicher enthält.
      const dLat = radius / KM_PER_DEGREE_LAT;
      const dLon = Math.min(180, radius / (KM_PER_DEGREE_LAT * Math.max(0.01, cosDeg(lat))));
      const candidates = (this.boxStmt?.all(lat - dLat, lat + dLat, lon - dLon, lon + dLon) ??
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
    this.searchNearStmt = null;
    this.boxStmt = null;
  }
}

function cosDeg(deg: number): number {
  return Math.cos((deg * Math.PI) / 180);
}

function cosSquared(lat: number): number {
  return cosDeg(lat) ** 2;
}
