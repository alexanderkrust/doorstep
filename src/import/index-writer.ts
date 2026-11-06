import { rmSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { ATTRIBUTION } from '../api/attribution.js';
import { boundingBox, distanceKm, gridCell } from '../search/geo.js';
import { housenumberText, indexText } from '../search/normalize.js';
import { kindToken, RESULT_TYPES, resultType, type ResultType } from '../search/result-type.js';
import { withLocation, type Place, type PlaceLocation } from './place.js';
import { Progress, type Logger } from './progress.js';

/**
 * 2: name_de/name_en, normalized full-text index, IDs by importance (phase 4).
 * 3: grid cells for the nearby search.
 * 4: district (`district`), "St." = "Sankt", "sss" → "ss", house number "12 a" also as "12a".
 * 5: country and state from administrative boundaries instead of only `addr:country`/`addr:state`.
 * 6: word statistics (`terms`, `prefixes`, meta `fts_tokens`) for bm25 in JS and the
 *    expansion of long prefixes (src/search/bm25.ts, `expandPrefix`).
 * 7: street names also split and joined ("Friedrich Straße", "Adenauerstraße").
 * 8: `category` (e.g. `shop=supermarket`), more POI kinds, city/district/postcode from boundaries.
 * 9: FTS column `kind` (result type) for the `types` parameter; INDEX_TYPES, meta `types`.
 */
export const SCHEMA_VERSION = 9;

const PLACE_COLUMNS = `osm_type, osm_id, type, name, name_de, name_en, street, housenumber,
  postcode, city, district, state, country, category, lat, lon, importance`;

/** Staging table in a separate file; copied into places, sorted, at the end. */
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
  category    TEXT,
  lat         REAL    NOT NULL,
  lon         REAL    NOT NULL,
  importance  REAL    NOT NULL,
  UNIQUE (osm_type, osm_id)
);
`;

const SCHEMA = `
-- id grows with falling importance (cities first, house numbers last).
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
  category    TEXT,
  lat         REAL    NOT NULL,
  lon         REAL    NOT NULL,
  importance  REAL    NOT NULL,
  UNIQUE (osm_type, osm_id)
);

-- Full-text index with normalized text (see src/search/normalize.ts), rowid = places.id.
-- Contentless: what is shown is always the row from places.
-- Column name holds name, name:de and name:en; column city also holds the district. Hits come
-- in rowid order, i.e. by importance. Prefix 1 for single-digit house numbers ("Hauptstraße 1").
-- Column cell: grid cell of the point (src/search/geo.ts) for the nearby search.
-- Column kind: result type as a token (src/search/result-type.ts) for the "types" parameter.
CREATE VIRTUAL TABLE places_fts USING fts5(
  name, street, housenumber, postcode, city, cell, kind,
  content = '',
  prefix = '1 2 3 4',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Points as degenerate rectangles; id = places.id.
CREATE VIRTUAL TABLE places_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon);

-- Word statistics of the full-text index without grid cells and result types: documents per word and per
-- prefix up to 4 characters (summed over the words). Replaces the counting in bm25().
CREATE TABLE terms (term TEXT PRIMARY KEY, docs INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE prefixes (prefix TEXT PRIMARY KEY, docs INTEGER NOT NULL) WITHOUT ROWID;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Result type tokens of the column `kind`, as an SQL list; not part of the word statistics. */
const KIND_TOKENS = RESULT_TYPES.map((t) => `'${kindToken(t)}'`).join(', ');

/** Result type of a row from SQL values: `type` and its names. */
function resultTypeOf(type: unknown, names: unknown[]): ResultType {
  return resultType(
    String(type),
    names.some((n) => typeof n === 'string' && n !== ''),
  );
}

const BATCH_SIZE = 10_000;
/**
 * FTS and R*Tree are built in blocks of this size. Node frees the memory of the JS
 * functions (index_text, …) only at the end of a statement; in a single statement over
 * all of Germany (25 million rows) the heap runs full.
 */
const DEFAULT_INDEX_BATCH_SIZE = 250_000;

export interface IndexWriterOptions {
  /** Rows per statement when building FTS and R*Tree; smaller only for tests. */
  indexBatchSize?: number;
  /**
   * Country and state of a point from the administrative boundaries (`BoundaryIndex.locate`).
   * Without it: values from `addr:country`/`addr:state`.
   */
  locate?: (lat: number, lon: number) => PlaceLocation;
  /** Progress messages while building the index (`finish`). */
  log?: Logger;
  /** Interval of the progress messages; 0 reports every step of progress (tests). */
  progressIntervalMs?: number;
  /**
   * Result types that end up in the index (INDEX_TYPES); default all. The others are only
   * used while building it, e.g. addresses for the city and postcode of streets.
   */
  indexTypes?: readonly ResultType[];
}

/**
 * Radii in which addresses on the same street are searched for a street. A street's
 * point lies in the middle of the segment; long segments often have their house
 * numbers farther away.
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
 * Writes a new index. Rows first go into a staging file; at the end they are copied
 * over sorted by importance, and FTS and R*Tree are built.
 */
export class IndexWriter {
  private readonly db: DatabaseSync;
  private readonly insert: StatementSync;
  private readonly stagingPath: string;
  private readonly indexBatchSize: number;
  private readonly locate: ((lat: number, lon: number) => PlaceLocation) | undefined;
  private readonly log: Logger;
  private readonly progressIntervalMs: number | undefined;
  private readonly indexTypes: readonly ResultType[];
  private pending = 0;
  private count = 0;

  constructor(path: string, options: IndexWriterOptions = {}) {
    this.indexBatchSize = options.indexBatchSize ?? DEFAULT_INDEX_BATCH_SIZE;
    this.locate = options.locate;
    this.log = options.log ?? (() => undefined);
    this.progressIntervalMs = options.progressIntervalMs;
    this.indexTypes = options.indexTypes ?? RESULT_TYPES;
    this.stagingPath = `${path}.staging`;
    rmSync(this.stagingPath, { force: true });
    this.db = new DatabaseSync(path);
    // The import writes to fresh files that are discarded on errors.
    this.db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
    this.db.exec(SCHEMA);
    this.db.prepare('ATTACH DATABASE ? AS staging').run(this.stagingPath);
    this.db.exec('PRAGMA staging.journal_mode = OFF; PRAGMA staging.synchronous = OFF;');
    this.db.exec(STAGING_SCHEMA);
    // Duplicate OSM objects (osmium exports some closed ways as a line and as an
    // area) are ignored; the first entry wins.
    this.insert = this.db.prepare(`
      INSERT OR IGNORE INTO staging.places (${PLACE_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // Normalization in JS, so import and search use the same function.
    this.db.function('index_text', { varargs: true, deterministic: true }, (...values) =>
      indexText(values.map((v) => (typeof v === 'string' ? v : null))),
    );
    this.db.function('housenumber_text', { deterministic: true }, (value) =>
      housenumberText(typeof value === 'string' ? value : null),
    );
    this.db.function('grid_cell', { deterministic: true }, (lat, lon) =>
      gridCell(Number(lat), Number(lon)),
    );
    this.db.function('kind_token', { varargs: true, deterministic: true }, (type, ...names) =>
      kindToken(resultTypeOf(type, names)),
    );
    this.db.exec('BEGIN');
  }

  add(input: Place): void {
    // On insert instead of a separate pass over all rows: the boundaries are in memory,
    // and this avoids an extra UPDATE over 25 million rows.
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
      place.category,
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

  /** Builds FTS and R*Tree, writes metadata and closes the file. Returns the row count. */
  finish(meta: Record<string, string>): number {
    this.db.exec('COMMIT');
    this.log('Sorting entries');
    this.db.exec(`
      BEGIN;
      INSERT INTO places (${PLACE_COLUMNS})
        SELECT ${PLACE_COLUMNS} FROM staging.places ORDER BY importance DESC, rowid;
      COMMIT;
      DETACH DATABASE staging;
    `);
    rmSync(this.stagingPath, { force: true });
    this.assignStreetAddresses();
    this.keepIndexTypes();
    this.buildSearchIndexes();
    this.log('Word statistics and optimization');
    const ftsTokens = this.buildTermStats();
    const setMeta = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    const entries: Record<string, string> = {
      schema_version: String(SCHEMA_VERSION),
      attribution: ATTRIBUTION,
      license: 'ODbL-1.0',
      imported_at: new Date().toISOString(),
      places: String(this.count),
      fts_tokens: String(ftsTokens),
      types: this.indexTypes.join(','),
      ...meta,
    };
    for (const [key, value] of Object.entries(entries)) setMeta.run(key, value);
    this.db.exec('ANALYZE; PRAGMA journal_mode = DELETE;');
    this.db.close();
    return this.count;
  }

  /** Fills FTS and R*Tree in blocks by id (see `DEFAULT_INDEX_BATCH_SIZE`). */
  private buildSearchIndexes(): void {
    const fts = this.db.prepare(`
      INSERT INTO places_fts (rowid, name, street, housenumber, postcode, city, cell, kind)
        SELECT id, index_text(name, name_de, name_en), index_text(street),
               housenumber_text(housenumber), postcode, index_text(city, district),
               grid_cell(lat, lon), kind_token(type, name, name_de, name_en)
          FROM places WHERE id > ? AND id <= ?`);
    const rtree = this.db.prepare(`
      INSERT INTO places_rtree (id, min_lat, max_lat, min_lon, max_lon)
        SELECT id, lat, lat, lon, lon FROM places WHERE id > ? AND id <= ?`);
    const { maxId } = this.db.prepare('SELECT coalesce(max(id), 0) AS maxId FROM places').get() as {
      maxId: number;
    };
    const progress = this.progress('Building search index', maxId);
    this.db.exec('BEGIN');
    for (let from = 0; from < maxId; from += this.indexBatchSize) {
      fts.run(from, from + this.indexBatchSize);
      rtree.run(from, from + this.indexBatchSize);
      progress.update(Math.min(maxId, from + this.indexBatchSize));
    }
    progress.finish(maxId);
    this.db.exec(`COMMIT; INSERT INTO places_fts(places_fts) VALUES ('optimize');`);
  }

  /**
   * Fills `terms` and `prefixes` from the finished full-text index. Returns the number of
   * all words in the index (including grid cells and result types), for the average
   * document length in bm25.
   */
  private buildTermStats(): number {
    this.db.exec(`
      CREATE VIRTUAL TABLE temp.fts_vocab USING fts5vocab(main, places_fts, row);
      CREATE TEMP TABLE vocab AS SELECT term, doc, cnt FROM temp.fts_vocab;
      DROP TABLE temp.fts_vocab;
      BEGIN;
      INSERT INTO terms (term, docs)
        SELECT term, doc FROM temp.vocab
         WHERE term NOT GLOB 'g[0-9]*x[0-9]*' AND term NOT IN (${KIND_TOKENS});
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
   * Streets in OSM rarely carry `addr:city` or `addr:postcode`. They take city, district
   * and postcode from the nearest address whose `addr:street` equals the street name.
   * This way "Hauptstraße Musterstadt" can be found, and streets with the same name can
   * be told apart in the results.
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
    // Only for this step: find a street's addresses within a latitude band.
    this.db.exec(`
      CREATE INDEX places_street_lat ON places (street, lat)
        WHERE street IS NOT NULL AND (city IS NOT NULL OR postcode IS NOT NULL);
      CREATE TEMP TABLE street_address (
        id INTEGER PRIMARY KEY, city TEXT, district TEXT, postcode TEXT);
    `);
    const where = `type = 'street' AND name IS NOT NULL AND (city IS NULL OR postcode IS NULL)`;
    const streets = this.db.prepare(
      `SELECT id, name, city, district, postcode, lat, lon FROM places WHERE ${where}`,
    );
    const { total } = this.db
      .prepare(`SELECT count(*) AS total FROM places WHERE ${where}`)
      .get() as { total: number };
    const progress = this.progress('Assigning streets', total);
    let done = 0;
    const addresses = this.db.prepare(`
      SELECT city, district, postcode, lat, lon FROM places INDEXED BY places_street_lat
       WHERE street = ? AND (city IS NOT NULL OR postcode IS NOT NULL)
         AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`);
    const save = this.db.prepare(
      'INSERT INTO temp.street_address (id, city, district, postcode) VALUES (?, ?, ?, ?)',
    );

    for (const row of streets.iterate()) {
      progress.update(++done);
      const street = row as unknown as AddressRow & { id: number; name: string };
      // Only look for what the street is still missing.
      const needsCity = street.city === null;
      const needsPostcode = street.postcode === null;
      // Districts do not exist everywhere: they are taken along, but not searched for separately.
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

    progress.finish(done);
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

  /**
   * Drops the rows whose result type is not in INDEX_TYPES, after the streets took city and
   * postcode from the addresses. The rest is numbered anew without gaps and in the same
   * order: the search relies on ids sorted by importance (`findAddressStart`).
   */
  private keepIndexTypes(): void {
    if (RESULT_TYPES.every((t) => this.indexTypes.includes(t))) return;
    this.log(`Keeping only ${this.indexTypes.join(', ')}`);
    this.db.function('result_type', { varargs: true, deterministic: true }, (type, ...names) =>
      resultTypeOf(type, names),
    );
    const types = this.indexTypes.map((t) => `'${t}'`).join(', ');
    this.db.exec(`
      BEGIN;
      CREATE TEMP TABLE kept AS
        SELECT ${PLACE_COLUMNS} FROM places
         WHERE result_type(type, name, name_de, name_en) IN (${types}) ORDER BY id;
      DELETE FROM places;
      INSERT INTO places (${PLACE_COLUMNS}) SELECT ${PLACE_COLUMNS} FROM temp.kept ORDER BY rowid;
      DROP TABLE temp.kept;
      COMMIT;
    `);
    const { kept } = this.db.prepare('SELECT count(*) AS kept FROM places').get() as {
      kept: number;
    };
    this.count = kept;
  }

  private progress(label: string, total: number): Progress {
    return new Progress(this.log, label, {
      total,
      ...(this.progressIntervalMs !== undefined ? { intervalMs: this.progressIntervalMs } : {}),
    });
  }

  /** Aborts and deletes the staging file; the caller cleans up the index file. */
  abort(): void {
    if (this.db.isOpen) this.db.close();
    rmSync(this.stagingPath, { force: true });
  }
}
