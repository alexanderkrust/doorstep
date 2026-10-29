/**
 * Country and state from OSM administrative boundaries (`boundary=administrative`,
 * `admin_level=2` and `4`).
 *
 * The input is osmium's output for the filtered boundaries:
 * - a GeoJSON sequence with areas (relations) and lines (ways),
 * - OPL lines of the relations (for the members of the country relations).
 *
 * A Geofabrik country extract contains only its own boundaries completely; neighboring
 * countries are cut off and cannot be assembled into an area. For points outside all
 * complete countries, the nearest boundary way therefore decides: it belongs to the
 * complete country and to exactly one neighboring country, and that is where the point is.
 */
import type { Feature, Position } from './place.js';

export interface Location {
  /** ISO 3166-1 code, e.g. `DE`. */
  country: string | null;
  /** Name of the state (`admin_level=4`). */
  state: string | null;
  /**
   * Municipality: `admin_level=8`, else a city at a higher level marked with `de:place=city`
   * or `place=city` (independent cities like Köln, city-states like Berlin).
   */
  city: string | null;
  /** District: `admin_level=10`, else `admin_level=9`. */
  district: string | null;
  /** From `boundary=postal_code`. */
  postcode: string | null;
}

export interface LocateStats {
  /** Points inside a complete country area. */
  inside: number;
  /** Points outside; country determined via the nearest boundary way. */
  border: number;
  /** Points without a result (country stays `addr:country`). */
  unknown: number;
}

/** Radius for the nearest boundary way in degrees (latitude); points farther away stay open. */
const MAX_BORDER_DISTANCE_DEG = 0.5;
/** Grid size for the search for boundary ways in degrees. */
const BORDER_CELL_DEG = 0.05;
/** At most this many grid cells per axis for an area. */
const MAX_CELLS_PER_AXIS = 512;
const MIN_CELL_DEG = 0.002;

/**
 * Municipalities, districts and postcode areas: tens of thousands of areas. A coarser grid
 * per area and outlines simplified to about 10 m keep the memory in check; a point a few
 * meters from a municipal border may end up on the wrong side.
 */
const LOCALITY_GRID = { maxCellsPerAxis: 64, minCellDeg: 0.005 } as const;
const LOCALITY_SIMPLIFY_DEG = 0.0001;
/** Bucket size of the coarse index that finds the candidate areas of a point. */
const BUCKET_DEG = 0.25;

// --- OPL ------------------------------------------------------------------------------------

export interface OplRelation {
  id: number;
  tags: Record<string, string>;
  /** IDs of the ways among the members. */
  wayIds: number[];
}

/** Undoes the OPL escaping (`%20%` → space, `%2014%` → em dash). */
export function unescapeOpl(text: string): string {
  return text.replace(/%([0-9a-fA-F]+)%/g, (_, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}

/** Parses a relation line of `osmium cat -f opl`; other lines give `null`. */
export function parseOplRelation(line: string): OplRelation | null {
  const fields = line.trim().split(' ');
  const head = fields[0];
  if (!head?.startsWith('r')) return null;
  const id = Number(head.slice(1));
  if (!Number.isInteger(id)) return null;
  const tags: Record<string, string> = {};
  const wayIds: number[] = [];
  for (const field of fields.slice(1)) {
    if (field.startsWith('T') && field.length > 1) {
      for (const pair of field.slice(1).split(',')) {
        const eq = pair.indexOf('=');
        if (eq > 0) tags[unescapeOpl(pair.slice(0, eq))] = unescapeOpl(pair.slice(eq + 1));
      }
    } else if (field.startsWith('M') && field.length > 1) {
      for (const member of field.slice(1).split(',')) {
        if (!member.startsWith('w')) continue;
        const ref = Number(member.slice(1, member.indexOf('@')));
        if (Number.isInteger(ref)) wayIds.push(ref);
      }
    }
  }
  return { id, tags, wayIds };
}

/** Administrative level of a `boundary=administrative` object, otherwise `null`. */
function adminLevel(tags: Record<string, unknown>): number | null {
  if (tags['boundary'] !== 'administrative') return null;
  const level = Number(tags['admin_level']);
  return Number.isInteger(level) ? level : null;
}

/** Marked as a city (independent cities and city-states above `admin_level=8`). */
function isCity(tags: Record<string, unknown>): boolean {
  return tags['de:place'] === 'city' || tags['place'] === 'city';
}

/** ISO code of a country relation; border line relations (`Deutschland - Österreich`) have none. */
function countryCode(tags: Record<string, unknown>): string | null {
  for (const key of ['ISO3166-1:alpha2', 'ISO3166-1', 'country_code']) {
    const value = tags[key];
    if (typeof value === 'string' && /^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  }
  return null;
}

// --- Point in polygon -----------------------------------------------------------------------

/** x coordinate where the edge crosses the horizontal `y`, or `null`. */
function crossingX(edges: Float64Array, e: number, y: number): number | null {
  const y1 = edges[e + 1] ?? 0;
  const y2 = edges[e + 3] ?? 0;
  if (y1 > y === y2 > y) return null;
  const x1 = edges[e] ?? 0;
  const x2 = edges[e + 2] ?? 0;
  return x1 + ((y - y1) * (x2 - x1)) / (y2 - y1);
}

const OUTSIDE = 0;
const INSIDE = 1;
const MIXED = 2;

/**
 * Point in polygon (even-odd rule over all rings) with a grid: cells without an edge are
 * entirely inside or outside and are answered in O(1). Otherwise, a ray to the east counts
 * the crossings only in the cells up to the next edge-free cell, whose state is known.
 */
export class PolygonGrid {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  private readonly size: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly edges: Float64Array;
  /** Edge indices (multiples of 4) per cell; `undefined` = no edge. */
  private readonly cellEdges: (Int32Array | undefined)[];
  private readonly status: Uint8Array;

  constructor(
    rings: readonly Position[][],
    { maxCellsPerAxis = MAX_CELLS_PER_AXIS, minCellDeg = MIN_CELL_DEG } = {},
  ) {
    const coords: number[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i++) {
        const [x1 = 0, y1 = 0] = ring[i - 1] ?? [];
        const [x2 = 0, y2 = 0] = ring[i] ?? [];
        if (x1 === x2 && y1 === y2) continue;
        coords.push(x1, y1, x2, y2);
        minX = Math.min(minX, x1, x2);
        maxX = Math.max(maxX, x1, x2);
        minY = Math.min(minY, y1, y2);
        maxY = Math.max(maxY, y1, y2);
      }
    }
    this.edges = Float64Array.from(coords);
    if (coords.length === 0) [minX, minY, maxX, maxY] = [0, 0, -1, -1];
    [this.minX, this.minY, this.maxX, this.maxY] = [minX, minY, maxX, maxY];
    this.size = Math.max(minCellDeg, Math.max(maxX - minX, maxY - minY) / maxCellsPerAxis);
    this.cols = Math.max(1, Math.floor((maxX - minX) / this.size) + 1);
    this.rows = Math.max(1, Math.floor((maxY - minY) / this.size) + 1);
    this.cellEdges = this.assignEdges();
    this.status = this.computeStatus();
  }

  private colX(col: number): number {
    return this.minX + col * this.size;
  }

  /**
   * East boundary of a column. The last column has none: with rounding, `colX(cols)` can
   * equal `maxX`, and an edge exactly there would no longer be counted.
   */
  private colEnd(col: number): number {
    return col >= this.cols - 1 ? Infinity : this.colX(col + 1);
  }

  private rowY(row: number): number {
    return this.minY + row * this.size;
  }

  private col(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.size)));
  }

  private row(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.size)));
  }

  /** Assigns each edge to the cells it touches (per row, one cell of margin). */
  private assignEdges(): (Int32Array | undefined)[] {
    const lists: (number[] | undefined)[] = new Array<number[] | undefined>(this.cols * this.rows);
    const { edges } = this;
    for (let e = 0; e < edges.length; e += 4) {
      const x1 = edges[e] ?? 0;
      const y1 = edges[e + 1] ?? 0;
      const x2 = edges[e + 2] ?? 0;
      const y2 = edges[e + 3] ?? 0;
      const r0 = this.row(Math.min(y1, y2));
      const r1 = this.row(Math.max(y1, y2));
      for (let r = r0; r <= r1; r++) {
        // x range of the edge within the row
        let xa = x1;
        let xb = x2;
        if (y1 !== y2) {
          const lo = Math.max(Math.min(y1, y2), this.rowY(r));
          const hi = Math.min(Math.max(y1, y2), this.rowY(r + 1));
          xa = x1 + ((lo - y1) * (x2 - x1)) / (y2 - y1);
          xb = x1 + ((hi - y1) * (x2 - x1)) / (y2 - y1);
        }
        const c0 = Math.max(0, this.col(Math.min(xa, xb)) - 1);
        const c1 = Math.min(this.cols - 1, this.col(Math.max(xa, xb)) + 1);
        for (let c = c0; c <= c1; c++) {
          const cell = r * this.cols + c;
          (lists[cell] ??= []).push(e);
        }
      }
    }
    return lists.map((list) => (list ? Int32Array.from(list) : undefined));
  }

  /** State of the edge-free cells, per row from east (outside) to west. */
  private computeStatus(): Uint8Array {
    const status = new Uint8Array(this.cols * this.rows);
    for (let r = 0; r < this.rows; r++) {
      const y = this.rowY(r) + this.size / 2;
      let inside = false;
      for (let c = this.cols - 1; c >= 0; c--) {
        const cell = r * this.cols + c;
        const list = this.cellEdges[cell];
        if (!list) {
          status[cell] = inside ? INSIDE : OUTSIDE;
          continue;
        }
        status[cell] = MIXED;
        if (this.countCrossings(list, y, this.colX(c), this.colEnd(c), true) % 2 === 1) {
          inside = !inside;
        }
      }
    }
    return status;
  }

  /** Crossings with the horizontal `y` at x in [from, to) or (from, to). */
  private countCrossings(
    list: Int32Array,
    y: number,
    from: number,
    to: number,
    includeFrom: boolean,
  ): number {
    let count = 0;
    for (const e of list) {
      const x = crossingX(this.edges, e, y);
      if (x === null || x >= to) continue;
      if (x > from || (includeFrom && x === from)) count++;
    }
    return count;
  }

  contains(x: number, y: number): boolean {
    if (x < this.minX || x > this.maxX || y < this.minY || y > this.maxY) return false;
    const r = this.row(y);
    const start = this.col(x);
    let odd = false;
    for (let c = start; c < this.cols; c++) {
      const cell = r * this.cols + c;
      const state = this.status[cell];
      if (state !== MIXED) {
        if (c === start) return state === INSIDE;
        return (state === INSIDE) !== odd;
      }
      const list = this.cellEdges[cell];
      if (!list) continue;
      const from = c === start ? x : this.colX(c);
      if (this.countCrossings(list, y, from, this.colEnd(c), c !== start) % 2 === 1) odd = !odd;
    }
    return odd;
  }
}

/**
 * Douglas-Peucker simplification of a ring: drops points closer than `tolerance` (degrees) to
 * the line between their neighbors. Keeps first and last point.
 */
export function simplifyRing(ring: readonly Position[], tolerance: number): Position[] {
  if (ring.length <= 4) return [...ring];
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop() ?? [0, 0];
    const [ax = 0, ay = 0] = ring[from] ?? [];
    const [bx = 0, by = 0] = ring[to] ?? [];
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = from + 1; i < to; i++) {
      const [px = 0, py = 0] = ring[i] ?? [];
      const d = pointSegmentDistance(px, py, ax, ay, bx, by);
      if (d > worstDistance) [worst, worstDistance] = [i, d];
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([from, worst], [worst, to]);
    }
  }
  const out = ring.filter((_, i) => keep[i] === 1);
  // A ring needs at least three distinct points; otherwise keep the original.
  return out.length >= 4 ? out : [...ring];
}

function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Many areas with a coarse bucket index over their bounding boxes. With several matches, the
 * one with the highest `rank` wins (e.g. Bremerhaven at level 6 before the state of Bremen).
 */
class AreaSet {
  private readonly areas: { name: string; rank: number; grid: PolygonGrid }[] = [];
  private readonly buckets = new Map<number, number[]>();

  get size(): number {
    return this.areas.length;
  }

  add(name: string, rings: Position[][], rank = 0): void {
    const simplified = rings.map((ring) => simplifyRing(ring, LOCALITY_SIMPLIFY_DEG));
    const grid = new PolygonGrid(simplified, LOCALITY_GRID);
    if (grid.maxX < grid.minX) return;
    const index = this.areas.push({ name, rank, grid }) - 1;
    for (let row = bucketOf(grid.minY); row <= bucketOf(grid.maxY); row++) {
      for (let col = bucketOf(grid.minX); col <= bucketOf(grid.maxX); col++) {
        const key = bucketKey(row, col);
        const list = this.buckets.get(key);
        if (list) list.push(index);
        else this.buckets.set(key, [index]);
      }
    }
  }

  find(x: number, y: number): string | null {
    const list = this.buckets.get(bucketKey(bucketOf(y), bucketOf(x)));
    let best: { name: string; rank: number } | null = null;
    for (const i of list ?? []) {
      const area = this.areas[i];
      if (!area || (best && area.rank <= best.rank)) continue;
      if (area.grid.contains(x, y)) best = area;
    }
    return best?.name ?? null;
  }
}

const bucketOf = (deg: number) => Math.floor(deg / BUCKET_DEG);
// Rows and columns stay within ±1440; a unique key without a string.
const bucketKey = (row: number, col: number) => (row + 2048) * 4096 + (col + 2048);

/** All rings of an area (Polygon or MultiPolygon). */
function areaRings(feature: Feature): Position[][] | null {
  const geometry = feature.geometry;
  if (geometry?.type === 'Polygon') return geometry.coordinates;
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates.flat();
  return null;
}

// --- Nearest boundary way ------------------------------------------------------------------

/** Border segments of a complete country with the code of the neighboring country. */
class BorderIndex {
  private readonly segments: number[] = [];
  private readonly codes: string[] = [];
  private readonly cells = new Map<number, number[]>();

  get size(): number {
    return this.codes.length;
  }

  add(line: Position[], code: string): void {
    for (let i = 1; i < line.length; i++) {
      const [x1 = 0, y1 = 0] = line[i - 1] ?? [];
      const [x2 = 0, y2 = 0] = line[i] ?? [];
      const index = this.codes.length;
      this.codes.push(code);
      this.segments.push(x1, y1, x2, y2);
      const c0 = Math.floor(Math.min(x1, x2) / BORDER_CELL_DEG);
      const c1 = Math.floor(Math.max(x1, x2) / BORDER_CELL_DEG);
      const r0 = Math.floor(Math.min(y1, y2) / BORDER_CELL_DEG);
      const r1 = Math.floor(Math.max(y1, y2) / BORDER_CELL_DEG);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = cellKey(c, r);
          const list = this.cells.get(key);
          if (list) list.push(index);
          else this.cells.set(key, [index]);
        }
      }
    }
  }

  /** Code at the nearest border segment (distance corrected with cos(latitude)). */
  nearest(x: number, y: number): string | null {
    if (this.codes.length === 0) return null;
    const scale = Math.cos((y * Math.PI) / 180);
    const col = Math.floor(x / BORDER_CELL_DEG);
    const row = Math.floor(y / BORDER_CELL_DEG);
    const maxRing = Math.ceil(MAX_BORDER_DISTANCE_DEG / BORDER_CELL_DEG);
    let best = Infinity;
    let bestCode: string | null = null;
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let r = row - ring; r <= row + ring; r++) {
        for (let c = col - ring; c <= col + ring; c++) {
          // only the edge of the square; the inside was covered in earlier rings
          if (Math.max(Math.abs(r - row), Math.abs(c - col)) !== ring) continue;
          for (const s of this.cells.get(cellKey(c, r)) ?? []) {
            const d = segmentDistance(this.segments, s * 4, x, y, scale);
            if (d < best) {
              best = d;
              bestCode = this.codes[s] ?? null;
            }
          }
        }
      }
      // Unvisited cells are at least `ring` cells away.
      if (best <= ring * BORDER_CELL_DEG * scale) break;
    }
    return best <= MAX_BORDER_DISTANCE_DEG ? bestCode : null;
  }
}

function cellKey(col: number, row: number): number {
  // Degrees/0.05 is surely within ±7200; a unique key without a string.
  return (row + 8192) * 16384 + (col + 8192);
}

function segmentDistance(s: number[], i: number, x: number, y: number, scale: number): number {
  const ax = (s[i] ?? 0) * scale;
  const ay = s[i + 1] ?? 0;
  const bx = (s[i + 2] ?? 0) * scale;
  const by = s[i + 3] ?? 0;
  const px = x * scale;
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (y - ay) * dy) / len));
  return Math.hypot(px - (ax + t * dx), y - (ay + t * dy));
}

// --- Index ----------------------------------------------------------------------------------

interface Area {
  name: string;
  grid: PolygonGrid;
}

export interface BoundarySummary {
  /** ISO codes of the countries that are fully present. */
  countries: string[];
  /** Number of states that are fully present. */
  states: number;
  /** Number of border segments with a known neighboring country. */
  borderSegments: number;
  /** Number of municipality areas (including cities above `admin_level=8`). */
  municipalities: number;
  /** Number of district areas (`admin_level=9` and `10`). */
  districts: number;
  /** Number of postcode areas. */
  postcodes: number;
}

/** Municipalities, districts and postcode areas. */
interface Localities {
  /** `admin_level=8`, rank 0. */
  municipalities: AreaSet;
  /** Cities above `admin_level=8`, ranked by level (most specific first). */
  cities: AreaSet;
  districts10: AreaSet;
  districts9: AreaSet;
  postcodes: AreaSet;
}

const emptyLocalities = (): Localities => ({
  municipalities: new AreaSet(),
  cities: new AreaSet(),
  districts10: new AreaSet(),
  districts9: new AreaSet(),
  postcodes: new AreaSet(),
});

export class BoundaryIndex {
  readonly stats: LocateStats = { inside: 0, border: 0, unknown: 0 };

  private constructor(
    private readonly countries: Area[],
    private readonly states: Area[],
    private readonly borders: BorderIndex,
    private readonly localities: Localities,
  ) {}

  /** Empty index: country and state stay as in the address tags. */
  static empty(): BoundaryIndex {
    return new BoundaryIndex([], [], new BorderIndex(), emptyLocalities());
  }

  /**
   * Reads the relations (OPL) first, then areas and lines (GeoJSON sequence).
   * Keeps only country and state areas plus the boundary ways of the complete countries.
   */
  static async load(
    features: () => AsyncIterable<string>,
    relations: AsyncIterable<string>,
    parse: (line: string) => Feature | null,
  ): Promise<BoundaryIndex> {
    /** Way ID → ISO codes of the countries it belongs to. */
    const wayCountries = new Map<number, string[]>();
    const relationCodes = new Map<number, string>();
    for await (const line of relations) {
      const relation = parseOplRelation(line);
      if (!relation || adminLevel(relation.tags) !== 2) continue;
      const code = countryCode(relation.tags);
      if (!code) continue;
      relationCodes.set(relation.id, code);
      for (const way of relation.wayIds) {
        const list = wayCountries.get(way);
        if (!list) wayCountries.set(way, [code]);
        else if (!list.includes(code)) list.push(code);
      }
    }

    const countries: Area[] = [];
    const states: Area[] = [];
    const localities = emptyLocalities();
    const lines: { id: number; coordinates: Position[] }[] = [];
    for await (const line of features()) {
      const feature = parse(line);
      const props = feature?.properties;
      if (!feature?.geometry || !props) continue;
      const id = props['@id'];
      if (typeof id !== 'number') continue;
      if (props['@type'] === 'way' && feature.geometry.type === 'LineString') {
        if (wayCountries.has(id)) lines.push({ id, coordinates: feature.geometry.coordinates });
        continue;
      }
      if (props['@type'] !== 'relation') continue;
      const rings = areaRings(feature);
      if (!rings) continue;
      if (props['boundary'] === 'postal_code') {
        const code = stringTag(props, 'postal_code') ?? stringTag(props, 'ref');
        if (code) localities.postcodes.add(code, rings);
        continue;
      }
      const level = adminLevel(props);
      const name = stringTag(props, 'name');
      if (level === 2) {
        const code = relationCodes.get(id) ?? countryCode(props);
        if (code) countries.push({ name: code, grid: new PolygonGrid(rings) });
        continue;
      }
      if (!level || !name) continue;
      if (level === 4) states.push({ name, grid: new PolygonGrid(rings) });
      if (level === 8) localities.municipalities.add(name, rings);
      else if (level > 2 && level < 8 && isCity(props)) localities.cities.add(name, rings, level);
      else if (level === 9) localities.districts9.add(name, rings);
      else if (level === 10) localities.districts10.add(name, rings);
    }

    // Boundary ways with exactly one incomplete country: shared borders with a complete
    // country, but also ways of the neighboring country only (on the Moselle, the German
    // and the Luxembourg border run along different banks). Ways between two neighboring
    // countries do not tell which side a point is on and are left out.
    const complete = new Set(countries.map((c) => c.name));
    const borders = new BorderIndex();
    for (const { id, coordinates } of complete.size > 0 ? lines : []) {
      const others = (wayCountries.get(id) ?? []).filter((code) => !complete.has(code));
      if (others.length === 1 && others[0]) borders.add(coordinates, others[0]);
    }
    return new BoundaryIndex(countries, states, borders, localities);
  }

  get summary(): BoundarySummary {
    return {
      countries: this.countries.map((c) => c.name),
      states: this.states.length,
      borderSegments: this.borders.size,
      municipalities: this.localities.municipalities.size + this.localities.cities.size,
      districts: this.localities.districts9.size + this.localities.districts10.size,
      postcodes: this.localities.postcodes.size,
    };
  }

  /** Country and state of a point; `null` where the boundaries give nothing. */
  locate(lat: number, lon: number): Location {
    let country = findArea(this.countries, lon, lat);
    if (country) this.stats.inside++;
    else {
      country = this.borders.nearest(lon, lat);
      if (country) this.stats.border++;
      else this.stats.unknown++;
    }
    const { municipalities, cities, districts10, districts9, postcodes } = this.localities;
    return {
      country,
      state: findArea(this.states, lon, lat),
      city: municipalities.find(lon, lat) ?? cities.find(lon, lat),
      district: districts10.find(lon, lat) ?? districts9.find(lon, lat),
      postcode: postcodes.find(lon, lat),
    };
  }
}

function stringTag(props: Record<string, unknown>, key: string): string | null {
  const value = props[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function findArea(areas: readonly Area[], x: number, y: number): string | null {
  for (const area of areas) if (area.grid.contains(x, y)) return area.name;
  return null;
}
