import { rmSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { ATTRIBUTION } from '../api/attribution.js';
import { boundingBox, distanceKm } from '../search/geo.js';
import { indexText } from '../search/normalize.js';
import type { Place } from './place.js';

/** 2: name_de/name_en, normalisierter Volltextindex, IDs nach Wichtigkeit (Phase 4). */
export const SCHEMA_VERSION = 2;

const PLACE_COLUMNS = `osm_type, osm_id, type, name, name_de, name_en, street, housenumber,
  postcode, city, state, country, lat, lon, importance`;

/** Zwischentabelle in einer eigenen Datei; am Ende sortiert nach places kopiert. */
const STAGING_SCHEMA = `
CREATE TABLE staging.places (
  osm_type    TEXT    NOT NULL,
  osm_id      INTEGER NOT NULL,
  type        TEXT    NOT NULL,
  name        TEXT,
  name_de     TEXT,
  name_en     TEXT,
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
`;

const SCHEMA = `
-- id steigt mit fallender importance (Städte zuerst, Hausnummern zuletzt).
CREATE TABLE places (
  id          INTEGER PRIMARY KEY,
  osm_type    TEXT    NOT NULL CHECK (osm_type IN ('N', 'W', 'R')),
  osm_id      INTEGER NOT NULL,
  type        TEXT    NOT NULL,
  name        TEXT,
  name_de     TEXT,
  name_en     TEXT,
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

-- Volltextindex mit normalisiertem Text (siehe src/search/normalize.ts), rowid = places.id.
-- Ohne eigenen Inhalt (contentless): angezeigt wird immer die Zeile aus places.
-- Spalte name enthält name, name:de und name:en. Treffer kommen in rowid-Reihenfolge,
-- also nach Wichtigkeit. Präfix 1 für einstellige Hausnummern ("Hauptstraße 1").
CREATE VIRTUAL TABLE places_fts USING fts5(
  name, street, housenumber, postcode, city,
  content = '',
  prefix = '1 2 3 4',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Punkte als entartete Rechtecke; id = places.id.
CREATE VIRTUAL TABLE places_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const BATCH_SIZE = 10_000;

/**
 * Umkreise, in denen für eine Straße nach Adressen an derselben Straße gesucht
 * wird. Der Punkt einer Straße liegt in der Mitte des Abschnitts; lange Abschnitte
 * haben ihre Hausnummern oft weiter entfernt.
 */
const STREET_ADDRESS_RADII_KM = [0.5, 2];

interface AddressRow {
  city: string | null;
  postcode: string | null;
  lat: number;
  lon: number;
}

/**
 * Schreibt einen neuen Index. Zeilen landen erst in einer Zwischendatei, am Ende
 * werden sie nach Wichtigkeit sortiert übernommen und FTS und R*Tree aufgebaut.
 */
export class IndexWriter {
  private readonly db: DatabaseSync;
  private readonly insert: StatementSync;
  private readonly stagingPath: string;
  private pending = 0;
  private count = 0;

  constructor(path: string) {
    this.stagingPath = `${path}.staging`;
    rmSync(this.stagingPath, { force: true });
    this.db = new DatabaseSync(path);
    // Import schreibt in frische Dateien, die bei Fehlern verworfen werden.
    this.db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
    this.db.exec(SCHEMA);
    this.db.prepare('ATTACH DATABASE ? AS staging').run(this.stagingPath);
    this.db.exec('PRAGMA staging.journal_mode = OFF; PRAGMA staging.synchronous = OFF;');
    this.db.exec(STAGING_SCHEMA);
    // Doppelte OSM-Objekte (osmium exportiert manche geschlossenen Wege als Linie
    // und als Fläche) werden ignoriert; der erste Eintrag gewinnt.
    this.insert = this.db.prepare(`
      INSERT OR IGNORE INTO staging.places (${PLACE_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // Normalisierung in JS, damit Import und Suche dieselbe Funktion nutzen.
    this.db.function('index_text', { varargs: true, deterministic: true }, (...values) =>
      indexText(values.map((v) => (typeof v === 'string' ? v : null))),
    );
    this.db.exec('BEGIN');
  }

  add(place: Place): void {
    const result = this.insert.run(
      place.osmType,
      place.osmId,
      place.type,
      place.name,
      place.nameDe,
      place.nameEn,
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
      BEGIN;
      INSERT INTO places (${PLACE_COLUMNS})
        SELECT ${PLACE_COLUMNS} FROM staging.places ORDER BY importance DESC, rowid;
      COMMIT;
      DETACH DATABASE staging;
    `);
    rmSync(this.stagingPath, { force: true });
    this.assignStreetAddresses();
    this.db.exec(`
      INSERT INTO places_fts (rowid, name, street, housenumber, postcode, city)
        SELECT id, index_text(name, name_de, name_en), index_text(street),
               index_text(housenumber), postcode, index_text(city)
          FROM places;
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

  /**
   * Straßen tragen in OSM selten `addr:city` oder `addr:postcode`. Sie übernehmen
   * Ort und PLZ von der nächsten Adresse, deren `addr:street` dem Straßennamen
   * entspricht. So lässt sich "Hauptstraße Musterstadt" finden, und gleichnamige
   * Straßen sind in den Ergebnissen unterscheidbar.
   */
  private assignStreetAddresses(): void {
    // Nur für diesen Schritt: Adressen einer Straße in einem Breitenband finden.
    this.db.exec(`
      BEGIN;
      CREATE INDEX places_street_lat ON places (street, lat)
        WHERE street IS NOT NULL AND (city IS NOT NULL OR postcode IS NOT NULL);
      CREATE TEMP TABLE street_address (id INTEGER PRIMARY KEY, city TEXT, postcode TEXT);
    `);
    const streets = this.db.prepare(`
      SELECT id, name, lat, lon FROM places
       WHERE type = 'street' AND name IS NOT NULL AND (city IS NULL OR postcode IS NULL)`);
    const addresses = this.db.prepare(`
      SELECT city, postcode, lat, lon FROM places INDEXED BY places_street_lat
       WHERE street = ? AND (city IS NOT NULL OR postcode IS NOT NULL)
         AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`);
    const save = this.db.prepare(
      'INSERT INTO temp.street_address (id, city, postcode) VALUES (?, ?, ?)',
    );

    for (const row of streets.iterate()) {
      const street = row as { id: number; name: string; lat: number; lon: number };
      let city: AddressRow | null = null;
      let postcode: AddressRow | null = null;
      let cityKm = Infinity;
      let postcodeKm = Infinity;
      for (const radiusKm of STREET_ADDRESS_RADII_KM) {
        const [minLat, maxLat, minLon, maxLon] = boundingBox(street.lat, street.lon, radiusKm);
        const found = addresses.all(
          street.name,
          minLat,
          maxLat,
          minLon,
          maxLon,
        ) as unknown as AddressRow[];
        for (const address of found) {
          const km = distanceKm(street.lat, street.lon, address.lat, address.lon);
          if (address.city !== null && km < cityKm) [city, cityKm] = [address, km];
          if (address.postcode !== null && km < postcodeKm) [postcode, postcodeKm] = [address, km];
        }
        if (city && postcode) break;
      }
      if (city || postcode) save.run(street.id, city?.city ?? null, postcode?.postcode ?? null);
    }

    this.db.exec(`
      UPDATE places
         SET city = coalesce(places.city, a.city), postcode = coalesce(places.postcode, a.postcode)
        FROM temp.street_address a
       WHERE places.id = a.id;
      DROP TABLE temp.street_address;
      DROP INDEX places_street_lat;
      COMMIT;
    `);
  }

  /** Bricht ab und löscht die Zwischendatei; die Indexdatei räumt der Aufrufer auf. */
  abort(): void {
    if (this.db.isOpen) this.db.close();
    rmSync(this.stagingPath, { force: true });
  }
}
