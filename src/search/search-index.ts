import { existsSync, statSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../import/index-writer.js';
import { importanceFor } from '../import/place.js';
import { bm25, ftsColumns, idf } from './bm25.js';
import { boundingBox, distanceKm, gridCellsInBox } from './geo.js';
import { nameForms, normalizeTokens } from './normalize.js';
import {
  buildFtsQuery,
  expandPrefix,
  inTextColumns,
  phrasesFor,
  tokenVariants,
  withinCells,
  withoutHousenumbers,
  withoutSingleLetters,
} from './query.js';
import { resultType, type ResultType } from './result-type.js';
import { dedupeNearby, rank, type Candidate } from './ranking.js';
import { charLength, MAX_INDEXED_PREFIX, TermStats } from './term-stats.js';

export { distanceKm };

/** A row from `places` as the API delivers it. */
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
  category: string | null;
  lat: number;
  lon: number;
}

export interface SearchOptions {
  q: string;
  limit: number;
  /** Optional location (location bias): nearby hits are boosted. */
  lat?: number;
  lon?: number;
  /** Only hits of these result types; default all. */
  types?: readonly ResultType[];
}

export interface ReverseOptions {
  lat: number;
  lon: number;
  limit: number;
  /** Search radius in kilometers. */
  radiusKm: number;
  /** Only hits of these result types; default all. */
  types?: readonly ResultType[];
}

interface CandidateRow extends PlaceRow {
  id: number;
  importance: number;
}

type RankedRow = CandidateRow & Candidate;

/** Midpoint of a segment of a merged street (`street_points`). */
interface StreetPoint {
  place_id: number;
  lat: number;
  lon: number;
}

export interface SearchIndexOptions {
  /** Prefixes with more documents are expanded (see `expandPrefix`); smaller only for tests. */
  expandPrefixDocs?: number;
}

const COLUMNS = `p.osm_type, p.osm_id, p.type, p.name, p.name_de, p.name_en, p.street,
  p.housenumber, p.postcode, p.city, p.district, p.state, p.country, p.category, p.lat, p.lon`;

/**
 * From this many documents on, a prefix over 4 characters is expanded. FTS5 needs about
 * 30 ns per document to merge: 50,000 documents cost about 1.5 ms.
 */
const EXPAND_PREFIX_DOCS = 50_000;
/**
 * This many candidates per query go into the ranking. IDs are assigned by importance
 * and FTS5 returns hits in ID order, so the first hits are the most important ones,
 * without having to score all hits.
 */
const CANDIDATES = 200;
/** Radius for the additional candidates when a location is given. */
const LOCAL_RADIUS_KM = 25;
/** More grid cells (only near the poles) make the query more expensive than checking all hits. */
const MAX_LOCAL_CELLS = 64;
/**
 * From this many global candidates within the radius on, the search runs without grid
 * cells: with 10 out of 200, 200 nearby hits are reached after checking about 4,000.
 */
const LOCAL_DENSE_HITS = 10;
/** Looks like a house number ("12", "60d"). */
const HOUSENUMBER_TOKEN = /^\d+[a-z]?$/;
/** Hits with the same name (e.g. segments of a street) within this distance are merged. */
const DEDUPE_RADIUS_KM = 2;

/**
 * Settlements: the same city often exists as a boundary (its centroid) and as a place node a
 * few kilometers apart, sometimes with different `place` values (`city` and `town`).
 */
const SETTLEMENT_TYPES = new Set(['city', 'town', 'village', 'hamlet', 'municipality']);
const SETTLEMENT_DEDUPE_RADIUS_KM = 10;

/**
 * Equal hits have the same kind, name and address. Only the main name counts: two OSM objects
 * for the same station may differ in `name:en`. Streets also need the same postcode: for
 * delivery checks, a street in two postcode areas is shown once per area.
 */
const dedupeKey = (row: PlaceRow) =>
  [
    SETTLEMENT_TYPES.has(row.type) ? 'settlement' : row.type,
    row.name ?? row.name_de ?? row.name_en,
    row.street,
    row.housenumber,
    row.type === 'street' ? row.postcode : null,
  ]
    .map((v) => v?.toLowerCase() ?? '')
    .join('|');

const dedupeRadius = (row: PlaceRow) =>
  SETTLEMENT_TYPES.has(row.type) ? SETTLEMENT_DEDUPE_RADIUS_KM : DEDUPE_RADIUS_KM;

/** Start radius of the nearby search; doubled until there are enough hits. */
const REVERSE_START_RADIUS_KM = 0.05;

/** Names the query is compared with in the ranking. */
function candidateNames(row: PlaceRow): string[] {
  const names = [row.name, row.name_de, row.name_en].flatMap(nameForms);
  if (row.street && row.housenumber) names.push(...nameForms(`${row.street} ${row.housenumber}`));
  return names;
}

/** The index exists but is not usable (e.g. old schema). */
export class IndexUnavailableError extends Error {
  override name = 'IndexUnavailableError';

  constructor(
    message: string,
    /** Schema version found in the file, if it could be read. */
    readonly foundSchemaVersion?: number,
  ) {
    super(message);
  }
}

/** Identity of a file: an atomic swap via rename yields a new inode. */
function fileIdentity(path: string): string | null {
  try {
    const s = statSync(path);
    return `${String(s.dev)}:${String(s.ino)}:${String(s.size)}:${String(s.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** An open index file with prepared queries. */
interface OpenIndex {
  db: DatabaseSync;
  identity: string | null;
  meta: Record<string, string>;
  stats: TermStats;
  search: StatementSync;
  /** Like `search`, but only from a given id on (see `addressStart`). */
  searchFrom: StatementSync;
  searchLocal: StatementSync;
  /** First id of the addresses; ids are sorted by importance, addresses come last. */
  addressStart: number | null;
  box: StatementSync;
  /** Segment midpoints of merged streets, by place id (JSON array). */
  streetPoints: StatementSync;
  /** Segment midpoints of merged streets within a box. */
  streetBox: StatementSync;
  /** Rows by id (JSON array). */
  byIds: StatementSync;
}

/** Opens and checks an index file. Throws `IndexUnavailableError` on a wrong schema. */
function openIndexFile(path: string): OpenIndex {
  // Read the identity before opening: if the file is swapped in between, the next
  // comparison notices and it is loaded again.
  const identity = fileIdentity(path);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    throw new IndexUnavailableError(`Index ${path} cannot be opened: ${String(err)}`);
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
      throw new IndexUnavailableError(`Index ${path} is not readable: ${String(err)}`);
    }
    const version = meta['schema_version'];
    if (version !== String(SCHEMA_VERSION)) {
      throw new IndexUnavailableError(
        `Index has schema version ${version ?? 'unknown'}, expected ${String(SCHEMA_VERSION)}. ` +
          'Please import again.',
        version === undefined || Number.isNaN(Number(version)) ? undefined : Number(version),
      );
    }
    return {
      db,
      identity,
      meta,
      stats: TermStats.open(db),
      // Without bm25(): it counts all documents for every search word; bm25 comes from JS.
      search: db.prepare(`SELECT p.id, ${COLUMNS}, p.importance
        FROM (SELECT rowid AS id FROM places_fts
               WHERE places_fts MATCH ? LIMIT ${String(CANDIDATES)}) f
        JOIN places p ON p.id = f.id`),
      searchFrom: db.prepare(`SELECT p.id, ${COLUMNS}, p.importance
        FROM (SELECT rowid AS id FROM places_fts
               WHERE places_fts MATCH ? AND rowid >= ? LIMIT ${String(CANDIDATES)}) f
        JOIN places p ON p.id = f.id`),
      addressStart: findAddressStart(db),
      // All hits within the radius, not just the most important: nearby addresses have the
      // lowest importance and come last in FTS order. The query contains the box's grid
      // cells; FTS5 then intersects the hit lists.
      searchLocal: db.prepare(`SELECT p.id, ${COLUMNS}, p.importance
        FROM places_fts JOIN places p ON p.id = places_fts.rowid
        WHERE places_fts MATCH ?
          AND p.lat BETWEEN ? AND ? AND p.lon BETWEEN ? AND ?
        LIMIT ${String(CANDIDATES)}`),
      streetPoints: db.prepare(`SELECT place_id, lat, lon FROM street_points
        WHERE place_id IN (SELECT value FROM json_each(?))`),
      streetBox: db.prepare(`SELECT s.place_id, s.lat, s.lon
        FROM street_points_rtree r JOIN street_points s ON s.id = r.id
        WHERE r.max_lat >= ? AND r.min_lat <= ? AND r.max_lon >= ? AND r.min_lon <= ?`),
      byIds: db.prepare(`SELECT p.id, ${COLUMNS} FROM places p
        WHERE p.id IN (SELECT value FROM json_each(?))`),
      box: db.prepare(`SELECT p.id, ${COLUMNS} FROM places_rtree r JOIN places p ON p.id = r.id
        WHERE r.max_lat >= ? AND r.min_lat <= ? AND r.max_lon >= ? AND r.min_lon <= ?`),
    };
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * First id with the importance of an address, by binary search over the ids (they are
 * assigned by descending importance). `null` if there are no addresses.
 */
function findAddressStart(db: DatabaseSync): number | null {
  const threshold = importanceFor('house');
  const importanceAt = db.prepare('SELECT importance FROM places WHERE id = ?');
  const { maxId } = db.prepare('SELECT coalesce(max(id), 0) AS maxId FROM places').get() as {
    maxId: number;
  };
  let lo = 1;
  let hi = maxId + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const row = importanceAt.get(mid) as { importance?: number } | undefined;
    if ((row?.importance ?? 0) <= threshold) hi = mid;
    else lo = mid + 1;
  }
  return lo <= maxId ? lo : null;
}

/**
 * Read access to `index.sqlite`. The file is opened on first access, so the API also
 * starts before an import has run.
 *
 * Updates replace the file via an atomic rename. The open old file stays readable until
 * the reload (on Unix it lives as long as it is open); `reloadIfChanged()` then switches
 * to the new one without interruption.
 */
export class SearchIndex {
  private current: OpenIndex | null = null;
  private readonly expandPrefixDocs: number;

  constructor(
    readonly path: string,
    options: SearchIndexOptions = {},
  ) {
    this.expandPrefixDocs = options.expandPrefixDocs ?? EXPAND_PREFIX_DOCS;
  }

  /**
   * Opens the index if present; `false` if none exists yet.
   * Throws `IndexUnavailableError` if the file has a different schema.
   */
  open(): boolean {
    if (this.current) return true;
    if (!existsSync(this.path)) return false;
    this.current = openIndexFile(this.path);
    return true;
  }

  /**
   * Reloads the index if a different file now lies at `path`. Returns `true` after a
   * switch. If the new file is unusable, the old index stays active and
   * `IndexUnavailableError` is thrown. If no index is open yet, nothing happens (the
   * next access takes care of it).
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
      // Do not retry on every call, only when the file changes again.
      old.identity = identity;
      throw err;
    }
    // Queries run synchronously: no request can come in between these lines.
    this.current = next;
    old.db.close();
    return true;
  }

  /** Metadata of the open index (`places`, `imported_at`, `source`, …); otherwise `null`. */
  meta(): Readonly<Record<string, string>> | null {
    return this.current?.meta ?? null;
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  /**
   * Autosuggest; `null` if there is no index.
   *
   * Order; the first with hits wins:
   * 1. the query as typed, otherwise without single letters ("Frankfurt a.M."),
   *    each with the house number and otherwise at street level (house number missing in OSM);
   * 2. the same with typo tolerance on the last word.
   * So the street in the named city comes before a house number in a similarly
   * spelled city ("… 1 Bonn" does not find "… 1 Bönen").
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
   * First query variant with hits, ranked. Without `typos` only the query itself, with
   * `typos` only the variants with a trimmed last word.
   */
  private rankedSearch(
    tokens: readonly string[],
    options: SearchOptions,
    typos: boolean,
  ): RankedRow[] {
    const current = this.current;
    if (!current) return [];
    const { lat, lon, types } = options;
    const hasLocation = lat !== undefined && lon !== undefined;
    const [exact, ...trimmed] = tokenVariants(tokens);
    const variants = typos ? trimmed : exact === undefined ? [] : [exact];
    for (const variant of variants) {
      const { match, idfs } = this.prepareQuery(current.stats, variant);
      if (match === null) continue;
      const rows = current.search.all(inTextColumns(match, types)) as unknown as CandidateRow[];
      // A query with a house number looks for an address, but on a common street the
      // candidates fill up with more important POIs first: also read from the addresses.
      if (
        rows.length >= CANDIDATES &&
        current.addressStart !== null &&
        (!types || types.includes('address')) &&
        variant.some((t) => HOUSENUMBER_TOKEN.test(t))
      ) {
        const seen = new Set(rows.map((r) => r.id));
        const addresses = current.searchFrom.all(
          inTextColumns(match, types),
          current.addressStart,
        ) as unknown as CandidateRow[];
        for (const row of addresses) if (!seen.has(row.id)) rows.push(row);
      }
      // Fewer than CANDIDATES hits: all are already included, the nearby ones too.
      if (hasLocation && rows.length >= CANDIDATES) {
        // Nearby hits that do not make it into the first candidates globally.
        const seen = new Set(rows.map((r) => r.id));
        for (const row of this.localCandidates(match, lat, lon, rows, types)) {
          if (!seen.has(row.id)) rows.push(row);
        }
      }
      if (rows.length === 0) continue;
      if (hasLocation) this.moveToNearestSegment(rows, lat, lon);

      const phrases = phrasesFor(variant);
      const candidates: RankedRow[] = rows.map((row) => ({
        ...row,
        bm25: bm25(phrases, idfs, ftsColumns(row), current.stats.avgTokens),
        names: candidateNames(row),
        ownNames: [row.name, row.name_de, row.name_en].flatMap(nameForms),
        plainAddress: row.type === 'house' && !row.name && !row.name_de && !row.name_en,
        ...(hasLocation ? { distanceKm: distanceKm(lat, lon, row.lat, row.lon) } : {}),
      }));
      return dedupeNearby(rank(candidates, tokens), dedupeKey, dedupeRadius);
    }
    return [];
  }

  /**
   * FTS5 query and IDF per search word from the word statistics. A long prefix with a
   * frequent word ("strasse"*) is expanded, see `expandPrefix`.
   */
  private prepareQuery(
    stats: TermStats,
    tokens: readonly string[],
  ): { match: string | null; idfs: number[] } {
    const last = tokens[tokens.length - 1] ?? '';
    let lastParts: string[] | null = null;
    let lastDocs: number;
    if (charLength(last) > MAX_INDEXED_PREFIX) {
      const completions = stats.completions(last);
      lastDocs = stats.prefixDocs(last, completions);
      lastParts = expandPrefix(last, completions, this.expandPrefixDocs);
    } else {
      lastDocs = stats.prefixDocs(last);
    }
    const idfs = tokens.map((token, i) =>
      idf(stats.rows, Math.min(stats.rows, i === tokens.length - 1 ? lastDocs : stats.docs(token))),
    );
    return { match: buildFtsQuery(tokens, lastParts), idfs };
  }

  /**
   * The most important hits within the radius. Through the box's grid cells, FTS5 only has
   * to return nearby hits; the duration depends on the density within the radius, not on
   * the number of hits in the whole index. If many of the global candidates already lie
   * within the radius, the nearby hits are found quickly without cells too, and the
   * intersection with the cells' hit lists is skipped. Both ways return the same rows.
   */
  private localCandidates(
    match: string,
    lat: number,
    lon: number,
    globalRows: readonly CandidateRow[],
    types: readonly ResultType[] | undefined,
  ): CandidateRow[] {
    const box = boundingBox(lat, lon, LOCAL_RADIUS_KM);
    const [minLat, maxLat, minLon, maxLon] = box;
    const inBox = globalRows.filter(
      (r) => r.lat >= minLat && r.lat <= maxLat && r.lon >= minLon && r.lon <= maxLon,
    ).length;
    const cells = gridCellsInBox(box);
    const useCells = inBox < LOCAL_DENSE_HITS && cells.length <= MAX_LOCAL_CELLS;
    const query = useCells ? withinCells(match, cells, types) : inTextColumns(match, types);
    return (this.current?.searchLocal.all(query, ...box) ?? []) as unknown as CandidateRow[];
  }

  /**
   * Merged streets (see `street_points`) take the midpoint of their segment nearest to the
   * point: the distance then counts from the part of the street near the user, and the hit
   * points there. `points` if already loaded; otherwise read for the street rows.
   */
  private moveToNearestSegment(
    rows: CandidateRow[],
    lat: number,
    lon: number,
    points?: readonly StreetPoint[],
  ): void {
    const streets = rows.filter((r) => r.type === 'street');
    if (streets.length === 0) return;
    const all =
      points ??
      ((this.current?.streetPoints.all(JSON.stringify(streets.map((r) => r.id))) ??
        []) as unknown as StreetPoint[]);
    if (all.length === 0) return;
    const byPlace = new Map<number, StreetPoint[]>();
    for (const p of all) {
      const list = byPlace.get(p.place_id);
      if (list) list.push(p);
      else byPlace.set(p.place_id, [p]);
    }
    for (const row of streets) {
      let best = { lat: row.lat, lon: row.lon, d: distanceKm(lat, lon, row.lat, row.lon) };
      for (const p of byPlace.get(row.id) ?? []) {
        const d = distanceKm(lat, lon, p.lat, p.lon);
        if (d < best.d) best = { lat: p.lat, lon: p.lon, d };
      }
      row.lat = best.lat;
      row.lon = best.lon;
    }
  }

  /** Nearest objects to the point via the R*Tree; `null` if there is no index. */
  reverse(options: ReverseOptions): PlaceRow[] | null {
    if (!this.open()) return null;
    const { lat, lon, limit, radiusKm, types } = options;
    const wanted = (row: PlaceRow) =>
      !types || types.includes(resultType(row.type, !!(row.name ?? row.name_de ?? row.name_en)));
    let radius = Math.min(REVERSE_START_RADIUS_KM, radiusKm);
    for (;;) {
      const box = boundingBox(lat, lon, radius);
      const candidates = (this.current?.box.all(...box) ?? []) as unknown as CandidateRow[];
      // Merged streets also by the midpoints of their other segments.
      const points = (this.current?.streetBox.all(...box) ?? []) as unknown as StreetPoint[];
      const missing = [...new Set(points.map((p) => p.place_id))].filter(
        (id) => !candidates.some((c) => c.id === id),
      );
      if (missing.length > 0) {
        candidates.push(
          ...((this.current?.byIds.all(JSON.stringify(missing)) ??
            []) as unknown as CandidateRow[]),
        );
      }
      this.moveToNearestSegment(candidates, lat, lon, points);
      // Only hits inside the circle are surely the nearest.
      const inCircle = candidates
        .map((row) => ({ row, d: distanceKm(lat, lon, row.lat, row.lon) }))
        .filter((c) => c.d <= radius && wanted(c.row))
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
