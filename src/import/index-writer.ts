import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { ATTRIBUTION } from '../api/attribution.js';
import { fuzzyRows } from '../search/fuzzy.js';
import { boundingBox, distanceKm, gridCell } from '../search/geo.js';
import { housenumberText, indexText } from '../search/normalize.js';
import { kindToken, RESULT_TYPES, resultType, type ResultType } from '../search/result-type.js';
import { withLocation, type Place, type PlaceLocation, type Position } from './place.js';
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
 * 9: popularity in `importance` (Wikidata/Wikipedia, population), landmarks (`man_made`, `natural`).
 * 10: FTS column `kind` (result type) for the `types` parameter; INDEX_TYPES, meta `types`.
 * 11: connected street segments with the same name merged during the import; their
 *     midpoints in `street_points` for the location and `/reverse`.
 */
export const SCHEMA_VERSION = 11;

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
-- End points of street segments (seg = rowid in staging.places), in 1e-7 degrees.
CREATE TABLE staging.segment_ends (
  seg INTEGER NOT NULL,
  lat INTEGER NOT NULL,
  lon INTEGER NOT NULL
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
-- SymSpell for the typo tolerance: word starts of 4 to 7 letters by their forms with up to
-- 1 (4–6 letters) or 2 (7 letters) letters removed; see src/search/fuzzy.ts.
CREATE TABLE fuzzy_deletes (del TEXT NOT NULL, prefix TEXT NOT NULL,
  PRIMARY KEY (del, prefix)) WITHOUT ROWID;

-- Midpoints of the segments of merged streets (place_id = places.id). The search uses the
-- nearest one for the distance to the location, /reverse finds the street at every segment.
CREATE TABLE street_points (
  id       INTEGER PRIMARY KEY,
  place_id INTEGER NOT NULL,
  lat      REAL    NOT NULL,
  lon      REAL    NOT NULL
);
CREATE VIRTUAL TABLE street_points_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon);

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

/** Coordinates of segment end points as integers (1e-7 degrees, as in OSM). */
const toE7 = (degrees: number) => Math.round(degrees * 1e7);

interface SegmentRow {
  osm_type: string;
  osm_id: number;
  lat: number;
  lon: number;
  importance: number;
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
 * Where SQLite puts its temp files (sorting for ORDER BY and CREATE INDEX, several GB for
 * Germany); `''` restores the default (`/tmp`). Next to the index, so the import only needs
 * space on that volume, also in containers with a small or read-only `/tmp`. The setting is
 * global for the process.
 */
function setTempDirectory(db: DatabaseSync, dir: string): void {
  db.exec(`PRAGMA temp_store_directory = '${dir.replaceAll("'", "''")}'`);
}

/**
 * Writes a new index. Rows first go into a staging file; at the end they are copied
 * over sorted by importance, and FTS and R*Tree are built.
 */
export class IndexWriter {
  private readonly db: DatabaseSync;
  private readonly insert: StatementSync;
  private readonly insertEnd: StatementSync;
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
    setTempDirectory(this.db, dirname(path));
    this.db.exec(SCHEMA);
    this.db.prepare('ATTACH DATABASE ? AS staging').run(this.stagingPath);
    this.db.exec('PRAGMA staging.journal_mode = OFF; PRAGMA staging.synchronous = OFF;');
    this.db.exec(STAGING_SCHEMA);
    // Duplicate OSM objects (osmium exports some closed ways as a line and as an
    // area) are ignored; the first entry wins.
    this.insert = this.db.prepare(`
      INSERT OR IGNORE INTO staging.places (${PLACE_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.insertEnd = this.db.prepare(
      'INSERT INTO staging.segment_ends (seg, lat, lon) VALUES (?, ?, ?)',
    );
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

  /**
   * Adds an entry. `ends`: end points of a street's line (`lineEnds`), so that connected
   * segments with the same name can be merged in `finish`.
   */
  add(input: Place, ends: readonly Position[] = []): void {
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
    if (result.changes > 0 && place.type === 'street') {
      for (const [lon, lat] of ends) {
        if (lat === undefined || lon === undefined) continue;
        this.insertEnd.run(result.lastInsertRowid, toE7(lat), toE7(lon));
      }
    }
    if (++this.pending >= BATCH_SIZE) {
      this.db.exec('COMMIT; BEGIN');
      this.pending = 0;
    }
  }

  /** Builds FTS and R*Tree, writes metadata and closes the file. Returns the row count. */
  finish(meta: Record<string, string>): number {
    this.db.exec('COMMIT');
    // On the staging rows, before merging: the segments of a street keep the postcode of
    // their own addresses, so a street in two postcode areas stays two entries.
    this.assignStreetAddresses();
    this.mergeStreetSegments();
    this.log('Sorting entries');
    this.db.exec(`
      BEGIN;
      INSERT INTO places (${PLACE_COLUMNS})
        SELECT ${PLACE_COLUMNS} FROM staging.places ORDER BY importance DESC, rowid;
      COMMIT;
      DETACH DATABASE staging;
    `);
    rmSync(this.stagingPath, { force: true });
    this.keepIndexTypes();
    this.buildStreetPoints();
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
      fuzzy: 'symspell',
      types: this.indexTypes.join(','),
      ...meta,
    };
    for (const [key, value] of Object.entries(entries)) setMeta.run(key, value);
    this.db.exec('ANALYZE; PRAGMA journal_mode = DELETE;');
    setTempDirectory(this.db, '');
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
    this.buildFuzzyDeletes();
    return tokens;
  }

  /** Fills `fuzzy_deletes` from `terms` (SymSpell, see `fuzzyRows`). */
  private buildFuzzyDeletes(): void {
    this.log('Typo index (SymSpell)');
    const terms = this.db.prepare('SELECT term FROM terms').all() as { term: string }[];
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO fuzzy_deletes (del, prefix) VALUES (?, ?)',
    );
    let rows = 0;
    this.db.exec('BEGIN');
    for (const [del, prefix] of fuzzyRows(terms.map((t) => t.term))) {
      insert.run(del, prefix);
      rows++;
    }
    this.db.exec('COMMIT');
    this.log(
      `Typo index: ${rows.toLocaleString('en-US')} entries for ${terms.length.toLocaleString('en-US')} words`,
    );
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
      CREATE INDEX staging.places_street_lat ON places (street, lat)
        WHERE street IS NOT NULL AND (city IS NOT NULL OR postcode IS NOT NULL);
      CREATE TEMP TABLE street_address (
        id INTEGER PRIMARY KEY, city TEXT, district TEXT, postcode TEXT);
    `);
    const where = `type = 'street' AND name IS NOT NULL AND (city IS NULL OR postcode IS NULL)`;
    const streets = this.db.prepare(
      `SELECT rowid AS id, name, city, district, postcode, lat, lon FROM staging.places WHERE ${where}`,
    );
    const { total } = this.db
      .prepare(`SELECT count(*) AS total FROM staging.places WHERE ${where}`)
      .get() as { total: number };
    const progress = this.progress('Assigning streets', total);
    let done = 0;
    const addresses = this.db.prepare(`
      SELECT city, district, postcode, lat, lon FROM staging.places INDEXED BY places_street_lat
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
      UPDATE staging.places AS p
         SET city = coalesce(p.city, a.city),
             district = coalesce(p.district, a.district),
             postcode = coalesce(p.postcode, a.postcode)
        FROM temp.street_address a
       WHERE p.rowid = a.id;
      DROP TABLE temp.street_address;
      DROP INDEX staging.places_street_lat;
    `);
  }

  /**
   * Drops the rows whose result type is not in INDEX_TYPES, after the streets took city and
   * postcode from the addresses. The rest is numbered anew without gaps and in the same
   * order: the search relies on ids sorted by importance (`findAddressStart`).
   */
  /**
   * Merges street segments that share an end point and have the same names, postcode, city
   * and district (segments in different postcode areas stay apart). One entry per street
   * remains: the segment closest to the middle of all segments, with the highest importance.
   * The midpoints of all segments go to `street_points` (see `buildStreetPoints`).
   */
  private mergeStreetSegments(): void {
    this.db.exec(`
      CREATE TEMP TABLE merged_points (
        osm_type TEXT NOT NULL, osm_id INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL);
      CREATE INDEX staging.segment_ends_point ON segment_ends (lat, lon);
    `);
    const { maxSeg } = this.db
      .prepare('SELECT coalesce(max(seg), 0) AS maxSeg FROM staging.segment_ends')
      .get() as { maxSeg: number };
    if (maxSeg === 0) return;
    this.log('Merging street segments');

    // Union-find over the segments; ids are rowids in staging.places.
    const parent = new Int32Array(maxSeg + 1).map((_, i) => i);
    const root = (i: number): number => {
      let r = i;
      while (parent[r] !== r) r = parent[r] ?? r;
      while (parent[i] !== r) [parent[i], i] = [r, parent[i] ?? r];
      return r;
    };
    const edges = this.db.prepare(`
      SELECT a.seg AS a, b.seg AS b
        FROM staging.segment_ends a
        JOIN staging.segment_ends b ON b.lat = a.lat AND b.lon = a.lon AND b.seg > a.seg
        JOIN staging.places pa ON pa.rowid = a.seg
        JOIN staging.places pb ON pb.rowid = b.seg
       WHERE pa.name IS pb.name AND pa.name_de IS pb.name_de AND pa.name_en IS pb.name_en
         AND pa.postcode IS pb.postcode AND pa.city IS pb.city AND pa.district IS pb.district`);
    for (const edge of edges.iterate()) {
      const { a, b } = edge as { a: number; b: number };
      const ra = root(a);
      const rb = root(b);
      if (ra !== rb) parent[ra] = rb;
    }

    const groups = new Map<number, number[]>();
    const segments = this.db.prepare('SELECT DISTINCT seg FROM staging.segment_ends');
    for (const row of segments.iterate()) {
      const seg = (row as { seg: number }).seg;
      const r = root(seg);
      const group = groups.get(r);
      if (group) group.push(seg);
      else groups.set(r, [seg]);
    }

    const member = this.db.prepare(
      'SELECT osm_type, osm_id, lat, lon, importance FROM staging.places WHERE rowid = ?',
    );
    const promote = this.db.prepare('UPDATE staging.places SET importance = ? WHERE rowid = ?');
    const drop = this.db.prepare('DELETE FROM staging.places WHERE rowid = ?');
    const point = this.db.prepare(
      'INSERT INTO temp.merged_points (osm_type, osm_id, lat, lon) VALUES (?, ?, ?, ?)',
    );
    let segmentCount = 0;
    let merged = 0;
    this.db.exec('BEGIN');
    for (const [, segs] of groups) {
      segmentCount += segs.length;
      if (segs.length < 2) continue;
      const rows = segs.map((seg) => ({ seg, ...(member.get(seg) as unknown as SegmentRow) }));
      const lat = rows.reduce((sum, r) => sum + r.lat, 0) / rows.length;
      const lon = rows.reduce((sum, r) => sum + r.lon, 0) / rows.length;
      let keep = rows[0] as (typeof rows)[number];
      for (const r of rows) {
        if (distanceKm(lat, lon, r.lat, r.lon) < distanceKm(lat, lon, keep.lat, keep.lon)) keep = r;
      }
      promote.run(Math.max(...rows.map((r) => r.importance)), keep.seg);
      for (const r of rows) {
        if (r.seg !== keep.seg) drop.run(r.seg);
        point.run(keep.osm_type, keep.osm_id, r.lat, r.lon);
      }
      merged += rows.length - 1;
    }
    this.db.exec('COMMIT');
    this.count -= merged;
    this.log(
      `Merged ${String(segmentCount)} street segments into ${String(segmentCount - merged)} streets`,
    );
  }

  /** Fills `street_points` and its R*Tree with the final ids (after `keepIndexTypes`). */
  private buildStreetPoints(): void {
    this.db.exec(`
      BEGIN;
      INSERT INTO street_points (place_id, lat, lon)
        SELECT p.id, m.lat, m.lon
          FROM temp.merged_points m
          JOIN places p ON p.osm_type = m.osm_type AND p.osm_id = m.osm_id
         ORDER BY p.id;
      CREATE INDEX street_points_place ON street_points (place_id);
      INSERT INTO street_points_rtree (id, min_lat, max_lat, min_lon, max_lon)
        SELECT id, lat, lat, lon, lon FROM street_points;
      DROP TABLE temp.merged_points;
      COMMIT;
    `);
  }

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
    if (this.db.isOpen) {
      setTempDirectory(this.db, '');
      this.db.close();
    }
    rmSync(this.stagingPath, { force: true });
  }
}
