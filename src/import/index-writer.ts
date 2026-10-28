import { rmSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { ATTRIBUTION } from '../api/attribution.js';
import { boundingBox, distanceKm, gridCell } from '../search/geo.js';
import { housenumberText, indexText } from '../search/normalize.js';
import { withLocation, type Place, type PlaceLocation } from './place.js';

/**
 * 2: name_de/name_en, normalisierter Volltextindex, IDs nach Wichtigkeit (Phase 4).
 * 3: Rasterzellen für die Umkreissuche.
 * 4: Ortsteil (`district`), "St." = "Sankt", "sss" → "ss", Hausnummer "12 a" auch als "12a".
 * 5: Land und Bundesland aus Verwaltungsgrenzen statt nur aus `addr:country`/`addr:state`.
 * 6: Wortstatistik (`terms`, `prefixes`, Meta `fts_tokens`) für bm25 in JS und die
 *    Zerlegung langer Präfixe (src/search/bm25.ts, `expandPrefix`).
 */
export const SCHEMA_VERSION = 6;

const PLACE_COLUMNS = `osm_type, osm_id, type, name, name_de, name_en, street, housenumber,
  postcode, city, district, state, country, lat, lon, importance`;

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
  district    TEXT,
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
  district    TEXT,
  state       TEXT,
  country     TEXT,
  lat         REAL    NOT NULL,
  lon         REAL    NOT NULL,
  importance  REAL    NOT NULL,
  UNIQUE (osm_type, osm_id)
);

-- Volltextindex mit normalisiertem Text (siehe src/search/normalize.ts), rowid = places.id.
-- Ohne eigenen Inhalt (contentless): angezeigt wird immer die Zeile aus places.
-- Spalte name enthält name, name:de und name:en, Spalte city auch den Ortsteil. Treffer kommen in rowid-Reihenfolge,
-- also nach Wichtigkeit. Präfix 1 für einstellige Hausnummern ("Hauptstraße 1").
-- Spalte cell: Rasterzelle des Punkts (src/search/geo.ts) für die Umkreissuche.
CREATE VIRTUAL TABLE places_fts USING fts5(
  name, street, housenumber, postcode, city, cell,
  content = '',
  prefix = '1 2 3 4',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Punkte als entartete Rechtecke; id = places.id.
CREATE VIRTUAL TABLE places_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon);

-- Wortstatistik des Volltextindex ohne Rasterzellen: Dokumente je Wort und je
-- Präfix bis 4 Zeichen (Summe über die Wörter). Ersetzt das Zählen in bm25().
CREATE TABLE terms (term TEXT PRIMARY KEY, docs INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE prefixes (prefix TEXT PRIMARY KEY, docs INTEGER NOT NULL) WITHOUT ROWID;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const BATCH_SIZE = 10_000;
/**
 * FTS und R*Tree werden in Blöcken dieser Größe aufgebaut. Node gibt den Speicher
 * der JS-Funktionen (index_text, …) erst nach dem Ende eines Statements frei; in
 * einem einzigen Statement über ganz Deutschland (25 Mio. Zeilen) läuft der Heap voll.
 */
const DEFAULT_INDEX_BATCH_SIZE = 250_000;

export interface IndexWriterOptions {
  /** Zeilen je Statement beim Aufbau von FTS und R*Tree; kleiner nur für Tests. */
  indexBatchSize?: number;
  /**
   * Land und Bundesland eines Punkts aus den Verwaltungsgrenzen (`BoundaryIndex.locate`).
   * Ohne: Werte aus `addr:country`/`addr:state`.
   */
  locate?: (lat: number, lon: number) => PlaceLocation;
}

/**
 * Umkreise, in denen für eine Straße nach Adressen an derselben Straße gesucht
 * wird. Der Punkt einer Straße liegt in der Mitte des Abschnitts; lange Abschnitte
 * haben ihre Hausnummern oft weiter entfernt.
 */
const STREET_ADDRESS_RADII_KM = [0.5, 2];

interface AddressRow {
  city: string | null;
  district: string | null;
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
  private readonly indexBatchSize: number;
  private readonly locate: ((lat: number, lon: number) => PlaceLocation) | undefined;
  private pending = 0;
  private count = 0;

  constructor(path: string, options: IndexWriterOptions = {}) {
    this.indexBatchSize = options.indexBatchSize ?? DEFAULT_INDEX_BATCH_SIZE;
    this.locate = options.locate;
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // Normalisierung in JS, damit Import und Suche dieselbe Funktion nutzen.
    this.db.function('index_text', { varargs: true, deterministic: true }, (...values) =>
      indexText(values.map((v) => (typeof v === 'string' ? v : null))),
    );
    this.db.function('housenumber_text', { deterministic: true }, (value) =>
      housenumberText(typeof value === 'string' ? value : null),
    );
    this.db.function('grid_cell', { deterministic: true }, (lat, lon) =>
      gridCell(Number(lat), Number(lon)),
    );
    this.db.exec('BEGIN');
  }

  add(input: Place): void {
    // Beim Einfügen statt in einem eigenen Durchlauf über alle Zeilen: Die Grenzen liegen
    // im Speicher, und so gibt es kein zusätzliches UPDATE über 25 Mio. Zeilen.
    const place = this.locate ? withLocation(input, this.locate(input.lat, input.lon)) : input;
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
      place.district,
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
    this.buildSearchIndexes();
    const ftsTokens = this.buildTermStats();
    const setMeta = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    const entries: Record<string, string> = {
      schema_version: String(SCHEMA_VERSION),
      attribution: ATTRIBUTION,
      license: 'ODbL-1.0',
      imported_at: new Date().toISOString(),
      places: String(this.count),
      fts_tokens: String(ftsTokens),
      ...meta,
    };
    for (const [key, value] of Object.entries(entries)) setMeta.run(key, value);
    this.db.exec('ANALYZE; PRAGMA journal_mode = DELETE;');
    this.db.close();
    return this.count;
  }

  /** Füllt FTS und R*Tree blockweise nach id (siehe `DEFAULT_INDEX_BATCH_SIZE`). */
  private buildSearchIndexes(): void {
    const fts = this.db.prepare(`
      INSERT INTO places_fts (rowid, name, street, housenumber, postcode, city, cell)
        SELECT id, index_text(name, name_de, name_en), index_text(street),
               housenumber_text(housenumber), postcode, index_text(city, district),
               grid_cell(lat, lon)
          FROM places WHERE id > ? AND id <= ?`);
    const rtree = this.db.prepare(`
      INSERT INTO places_rtree (id, min_lat, max_lat, min_lon, max_lon)
        SELECT id, lat, lat, lon, lon FROM places WHERE id > ? AND id <= ?`);
    const { maxId } = this.db.prepare('SELECT coalesce(max(id), 0) AS maxId FROM places').get() as {
      maxId: number;
    };
    this.db.exec('BEGIN');
    for (let from = 0; from < maxId; from += this.indexBatchSize) {
      fts.run(from, from + this.indexBatchSize);
      rtree.run(from, from + this.indexBatchSize);
    }
    this.db.exec(`COMMIT; INSERT INTO places_fts(places_fts) VALUES ('optimize');`);
  }

  /**
   * Füllt `terms` und `prefixes` aus dem fertigen Volltextindex. Liefert die Zahl
   * aller Wörter im Index (mit Rasterzellen), für die mittlere Dokumentlänge in bm25.
   */
  private buildTermStats(): number {
    this.db.exec(`
      CREATE VIRTUAL TABLE temp.fts_vocab USING fts5vocab(main, places_fts, row);
      CREATE TEMP TABLE vocab AS SELECT term, doc, cnt FROM temp.fts_vocab;
      DROP TABLE temp.fts_vocab;
      BEGIN;
      INSERT INTO terms (term, docs)
        SELECT term, doc FROM temp.vocab WHERE term NOT GLOB 'g[0-9]*x[0-9]*';
      INSERT INTO prefixes (prefix, docs)
        SELECT prefix, sum(docs) FROM (
          SELECT substr(term, 1, n.len) AS prefix, docs
            FROM terms, (SELECT 1 AS len UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4) n
           WHERE length(term) >= n.len)
         GROUP BY prefix;
      COMMIT;
    `);
    const { tokens } = this.db
      .prepare('SELECT coalesce(sum(cnt), 0) AS tokens FROM temp.vocab')
      .get() as {
      tokens: number;
    };
    this.db.exec('DROP TABLE temp.vocab');
    return tokens;
  }

  /**
   * Straßen tragen in OSM selten `addr:city` oder `addr:postcode`. Sie übernehmen
   * Ort, Ortsteil und PLZ von der nächsten Adresse, deren `addr:street` dem
   * Straßennamen entspricht. So lässt sich "Hauptstraße Musterstadt" finden, und gleichnamige
   * Straßen sind in den Ergebnissen unterscheidbar.
   */
  private assignStreetAddresses(): void {
    this.db.exec('BEGIN');
    try {
      this.assignStreetAddressesInTransaction();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private assignStreetAddressesInTransaction(): void {
    // Nur für diesen Schritt: Adressen einer Straße in einem Breitenband finden.
    this.db.exec(`
      CREATE INDEX places_street_lat ON places (street, lat)
        WHERE street IS NOT NULL AND (city IS NOT NULL OR postcode IS NOT NULL);
      CREATE TEMP TABLE street_address (
        id INTEGER PRIMARY KEY, city TEXT, district TEXT, postcode TEXT);
    `);
    const streets = this.db.prepare(`
      SELECT id, name, city, district, postcode, lat, lon FROM places
       WHERE type = 'street' AND name IS NOT NULL AND (city IS NULL OR postcode IS NULL)`);
    const addresses = this.db.prepare(`
      SELECT city, district, postcode, lat, lon FROM places INDEXED BY places_street_lat
       WHERE street = ? AND (city IS NOT NULL OR postcode IS NOT NULL)
         AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`);
    const save = this.db.prepare(
      'INSERT INTO temp.street_address (id, city, district, postcode) VALUES (?, ?, ?, ?)',
    );

    for (const row of streets.iterate()) {
      const street = row as unknown as AddressRow & { id: number; name: string };
      // Nur suchen, was der Straße noch fehlt.
      const needsCity = street.city === null;
      const needsPostcode = street.postcode === null;
      // Ortsteile gibt es nicht überall: Sie werden mitgenommen, aber nicht eigens gesucht.
      const needsDistrict = street.district === null;
      let city: AddressRow | null = null;
      let district: AddressRow | null = null;
      let postcode: AddressRow | null = null;
      let cityKm = Infinity;
      let districtKm = Infinity;
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
          if (needsCity && address.city !== null && km < cityKm) [city, cityKm] = [address, km];
          if (needsDistrict && address.district !== null && km < districtKm) {
            [district, districtKm] = [address, km];
          }
          if (needsPostcode && address.postcode !== null && km < postcodeKm) {
            [postcode, postcodeKm] = [address, km];
          }
        }
        if ((!needsCity || city) && (!needsPostcode || postcode)) break;
      }
      if (city || district || postcode) {
        save.run(
          street.id,
          city?.city ?? null,
          district?.district ?? null,
          postcode?.postcode ?? null,
        );
      }
    }

    this.db.exec(`
      UPDATE places
         SET city = coalesce(places.city, a.city),
             district = coalesce(places.district, a.district),
             postcode = coalesce(places.postcode, a.postcode)
        FROM temp.street_address a
       WHERE places.id = a.id;
      DROP TABLE temp.street_address;
      DROP INDEX places_street_lat;
    `);
  }

  /** Bricht ab und löscht die Zwischendatei; die Indexdatei räumt der Aufrufer auf. */
  abort(): void {
    if (this.db.isOpen) this.db.close();
    rmSync(this.stagingPath, { force: true });
  }
}
