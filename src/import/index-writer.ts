import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { ATTRIBUTION } from '../api/attribution.js';
import type { Place } from './place.js';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE places (
  id          INTEGER PRIMARY KEY,
  osm_type    TEXT    NOT NULL CHECK (osm_type IN ('N', 'W', 'R')),
  osm_id      INTEGER NOT NULL,
  type        TEXT    NOT NULL,
  name        TEXT,
  street      TEXT,
  housenumber TEXT,
  postcode    TEXT,
  city        TEXT,
  state       TEXT,
  country     TEXT,
  lat         REAL    NOT NULL,
  lon         REAL    NOT NULL,
  importance  REAL    NOT NULL,
  UNIQUE (osm_type, osm_id)
);

-- Volltextindex über places (external content); Präfix-Index für Autosuggest.
CREATE VIRTUAL TABLE places_fts USING fts5(
  name, street, housenumber, postcode, city,
  content = 'places',
  content_rowid = 'id',
  prefix = '2 3 4',
  tokenize = 'unicode61 remove_diacritics 0'
);

-- Punkte als entartete Rechtecke; id = places.id.
CREATE VIRTUAL TABLE places_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const BATCH_SIZE = 10_000;

/** Schreibt einen neuen Index; FTS und R*Tree werden am Ende in einem Schritt aufgebaut. */
export class IndexWriter {
  private readonly db: DatabaseSync;
  private readonly insert: StatementSync;
  private pending = 0;
  private count = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // Import schreibt in eine frische Datei, die bei Fehlern verworfen wird.
    this.db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
    this.db.exec(SCHEMA);
    // Doppelte OSM-Objekte (osmium exportiert manche geschlossenen Wege als Linie
    // und als Fläche) werden ignoriert; der erste Eintrag gewinnt.
    this.insert = this.db.prepare(`
      INSERT OR IGNORE INTO places
        (osm_type, osm_id, type, name, street, housenumber, postcode, city, state, country, lat, lon, importance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.exec('BEGIN');
  }

  add(place: Place): void {
    const result = this.insert.run(
      place.osmType,
      place.osmId,
      place.type,
      place.name,
      place.street,
      place.housenumber,
      place.postcode,
      place.city,
      place.state,
      place.country,
      place.lat,
      place.lon,
      place.importance,
    );
    this.count += Number(result.changes);
    if (++this.pending >= BATCH_SIZE) {
      this.db.exec('COMMIT; BEGIN');
      this.pending = 0;
    }
  }

  /** Baut FTS und R*Tree auf, schreibt Metadaten und schließt die Datei. Liefert die Zeilenzahl. */
  finish(meta: Record<string, string>): number {
    this.db.exec('COMMIT');
    this.db.exec(`
      INSERT INTO places_fts(places_fts) VALUES ('rebuild');
      INSERT INTO places_fts(places_fts) VALUES ('optimize');
      INSERT INTO places_rtree (id, min_lat, max_lat, min_lon, max_lon)
        SELECT id, lat, lat, lon, lon FROM places;
    `);
    const setMeta = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    const entries: Record<string, string> = {
      schema_version: String(SCHEMA_VERSION),
      attribution: ATTRIBUTION,
      license: 'ODbL-1.0',
      imported_at: new Date().toISOString(),
      places: String(this.count),
      ...meta,
    };
    for (const [key, value] of Object.entries(entries)) setMeta.run(key, value);
    this.db.exec('ANALYZE; PRAGMA journal_mode = DELETE;');
    this.db.close();
    return this.count;
  }

  /** Bricht ab, ohne die Datei aufzuräumen (das macht der Aufrufer). */
  abort(): void {
    if (this.db.isOpen) this.db.close();
  }
}
