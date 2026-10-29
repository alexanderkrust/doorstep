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

/** Administrative level 2 or 4, otherwise `null`. */
function adminLevel(tags: Record<string, unknown>): 2 | 4 | null {
  if (tags['boundary'] !== 'administrative') return null;
  const level = tags['admin_level'];
  return level === '2' ? 2 : level === '4' ? 4 : null;
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

  constructor(rings: readonly Position[][]) {
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
    this.size = Math.max(MIN_CELL_DEG, Math.max(maxX - minX, maxY - minY) / MAX_CELLS_PER_AXIS);
    this.cols = Math.max(1, Math.floor((maxX - minX) / this.size) + 1);
    this.rows = Math.max(1, Math.floor((maxY - minY) / this.size) + 1);
    this.cellEdges = this.assignEdges();
    this.status = this.computeStatus();
  }

  private colX(col: number): number {
    return this.minX + col * this.size;
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
        if (this.countCrossings(list, y, this.colX(c), this.colX(c + 1), true) % 2 === 1) {
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
      if (this.countCrossings(list, y, from, this.colX(c + 1), c !== start) % 2 === 1) odd = !odd;
    }
    return odd;
  }
}

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
}

export class BoundaryIndex {
  readonly stats: LocateStats = { inside: 0, border: 0, unknown: 0 };

  private constructor(
    private readonly countries: Area[],
    private readonly states: Area[],
    private readonly borders: BorderIndex,
  ) {}

  /** Empty index: country and state stay as in the address tags. */
  static empty(): BoundaryIndex {
    return new BoundaryIndex([], [], new BorderIndex());
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
      const level = adminLevel(props);
      if (!rings || !level) continue;
      if (level === 2) {
        const code = relationCodes.get(id) ?? countryCode(props);
        if (code) countries.push({ name: code, grid: new PolygonGrid(rings) });
      } else {
        const name = typeof props['name'] === 'string' ? props['name'] : null;
        if (name) states.push({ name, grid: new PolygonGrid(rings) });
      }
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
    return new BoundaryIndex(countries, states, borders);
  }

  get summary(): BoundarySummary {
    return {
      countries: this.countries.map((c) => c.name),
      states: this.states.length,
      borderSegments: this.borders.size,
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
    return { country, state: findArea(this.states, lon, lat) };
  }
}

function findArea(areas: readonly Area[], x: number, y: number): string | null {
  for (const area of areas) if (area.grid.contains(x, y)) return area.name;
  return null;
}
