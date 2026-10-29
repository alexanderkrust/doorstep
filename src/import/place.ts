/** Conversion of osmium GeoJSON features into index rows. Pure functions. */

export type Position = number[];

export type Geometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] }
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] };

export interface Feature {
  type: 'Feature';
  geometry: Geometry | null;
  properties: Record<string, unknown> | null;
}

export type OsmType = 'N' | 'W' | 'R';

/** A row of the `places` table (without the internal `id`). */
export interface Place {
  osmType: OsmType;
  osmId: number;
  /** `house`, `street`, `poi` or the value of `place=*` (e.g. `city`). */
  type: string;
  name: string | null;
  /** `name:de` and `name:en`; selected via `lang` in the API. */
  nameDe: string | null;
  nameEn: string | null;
  street: string | null;
  housenumber: string | null;
  postcode: string | null;
  city: string | null;
  /** District (`addr:suburb`, else `addr:hamlet`); `city` is often the municipality. */
  district: string | null;
  state: string | null;
  country: string | null;
  /** OSM tag that makes the object what it is, e.g. `shop=supermarket`, `place=village`. */
  category: string | null;
  lat: number;
  lon: number;
  importance: number;
}

/** Importance per type: city before village before street before house number. */
const IMPORTANCE: Record<string, number> = {
  country: 1,
  state: 0.95,
  city: 0.9,
  town: 0.8,
  borough: 0.75,
  suburb: 0.7,
  village: 0.65,
  quarter: 0.6,
  neighbourhood: 0.55,
  hamlet: 0.5,
  square: 0.45,
  locality: 0.45,
  isolated_dwelling: 0.45,
  street: 0.4,
  poi: 0.35,
  house: 0.3,
};
const DEFAULT_IMPORTANCE = 0.4;

/** Place types whose name is also the city. */
const CITY_TYPES = new Set(['city', 'town', 'village', 'hamlet']);

const OSM_TYPES: Record<string, OsmType> = { node: 'N', way: 'W', relation: 'R' };

/**
 * Tags that make a named object a POI, in order of priority for its category. `null` = any
 * value; otherwise only the listed values (e.g. stations, not every railway track).
 */
const POI_TAGS: readonly (readonly [string, ReadonlySet<string> | null])[] = [
  ['amenity', null],
  ['shop', null],
  ['tourism', null],
  ['railway', new Set(['station', 'halt'])],
  ['public_transport', new Set(['station'])],
  ['aeroway', new Set(['aerodrome', 'terminal'])],
  ['healthcare', null],
  ['office', null],
  ['leisure', null],
  ['historic', null],
  ['craft', null],
];

/** POIs that people look for by name more often than others. */
const POI_IMPORTANCE: Record<string, number> = {
  'aeroway=aerodrome': 0.65,
  'railway=station': 0.6,
  'public_transport=station': 0.55,
  'tourism=attraction': 0.5,
  'tourism=museum': 0.5,
  'amenity=university': 0.5,
  'amenity=hospital': 0.5,
};

export function importanceFor(type: string, category: string | null = null): number {
  return (
    (category ? POI_IMPORTANCE[category] : undefined) ?? IMPORTANCE[type] ?? DEFAULT_IMPORTANCE
  );
}

/**
 * Named objects that nobody looks for in an autosuggest: signposts and boards, Stolpersteine
 * (named after people), street furniture.
 */
function isNoise(props: Record<string, unknown>): boolean {
  const tourism = tag(props, 'tourism');
  if (tourism === 'information' && tag(props, 'information') !== 'office') return true;
  if (tag(props, 'historic') === 'memorial' && tag(props, 'memorial') === 'stolperstein') {
    return true;
  }
  const amenity = tag(props, 'amenity');
  return amenity !== null && NOISE_AMENITIES.has(amenity);
}

const NOISE_AMENITIES = new Set([
  'bench',
  'waste_basket',
  'vending_machine',
  'parking_space',
  'hunting_stand',
  'grit_bin',
]);

/** The POI tag of an object as `key=value`, or `null`. */
function poiCategory(props: Record<string, unknown>): string | null {
  if (isNoise(props)) return null;
  for (const [key, values] of POI_TAGS) {
    const value = tag(props, key);
    if (value && (!values || values.has(value))) return `${key}=${value}`;
  }
  return null;
}

function tag(props: Record<string, unknown>, key: string): string | null {
  const value = props[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Type and category; `null` if the object does not belong in the index. */
function classify(
  props: Record<string, unknown>,
  name: string | null,
  osmType: OsmType,
): { type: string; category: string | null } | null {
  const place = tag(props, 'place');
  if (place && name) return { type: place, category: `place=${place}` };
  const poi = name ? poiCategory(props) : null;
  if (poi) return { type: 'poi', category: poi };
  if (tag(props, 'addr:housenumber')) return { type: 'house', category: null };
  const highway = tag(props, 'highway');
  // Only ways: osmium also passes along the nodes of a road, and named nodes are bus stops,
  // junctions and the like, not streets.
  if (highway && name && osmType !== 'N') {
    return { type: 'street', category: `highway=${highway}` };
  }
  return null;
}

export function featureToPlace(feature: Feature): Place | null {
  const props = feature.properties;
  if (!props || !feature.geometry) return null;

  const osmType = OSM_TYPES[String(props['@type'])];
  const osmId = props['@id'];
  if (!osmType || typeof osmId !== 'number') return null;

  const name = tag(props, 'name');
  const nameDe = tag(props, 'name:de');
  const nameEn = tag(props, 'name:en');
  const kind = classify(props, name ?? nameDe ?? nameEn, osmType);
  if (!kind) return null;
  const { type, category } = kind;

  const point = representativePoint(feature.geometry);
  if (!point) return null;

  return {
    osmType,
    osmId,
    type,
    name,
    nameDe,
    nameEn,
    // Addresses without a street (mostly small places) carry the place name in addr:place.
    street: tag(props, 'addr:street') ?? tag(props, 'addr:place'),
    housenumber: tag(props, 'addr:housenumber'),
    postcode: tag(props, 'addr:postcode') ?? tag(props, 'postal_code'),
    city: tag(props, 'addr:city') ?? (CITY_TYPES.has(type) ? (name ?? nameDe ?? nameEn) : null),
    district: tag(props, 'addr:suburb') ?? tag(props, 'addr:hamlet'),
    state: tag(props, 'addr:state'),
    country: tag(props, 'addr:country'),
    category,
    lat: point.lat,
    lon: point.lon,
    importance: importanceFor(type, category),
  };
}

export interface LatLon {
  lat: number;
  lon: number;
}

function toLatLon(p: Position | undefined): LatLon | null {
  const [lon, lat] = p ?? [];
  return lon === undefined || lat === undefined ? null : { lat, lon };
}

function lineLength(line: Position[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    if (a && b) total += Math.hypot((b[0] ?? 0) - (a[0] ?? 0), (b[1] ?? 0) - (a[1] ?? 0));
  }
  return total;
}

/** Point at half the length of the line (in degrees, good enough for short distances). */
function lineMidpoint(line: Position[]): LatLon | null {
  if (line.length === 0) return null;
  let remaining = lineLength(line) / 2;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    if (!a || !b) continue;
    const [ax = 0, ay = 0] = a;
    const [bx = 0, by = 0] = b;
    const segment = Math.hypot(bx - ax, by - ay);
    if (segment >= remaining && segment > 0) {
      const t = remaining / segment;
      return { lon: ax + (bx - ax) * t, lat: ay + (by - ay) * t };
    }
    remaining -= segment;
  }
  return toLatLon(line[0]);
}

/** Centroid of a ring; for degenerate rings the mean of the points. */
function ringCentroid(ring: Position[]): { point: LatLon; area: number } | null {
  if (ring.length === 0) return null;
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0 = 0, y0 = 0] = ring[i] ?? [];
    const [x1 = 0, y1 = 0] = ring[i + 1] ?? [];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area) < 1e-14) {
    const sum = ring.reduce<[number, number]>(
      (acc, [x = 0, y = 0]) => [acc[0] + x, acc[1] + y],
      [0, 0],
    );
    return { point: { lon: sum[0] / ring.length, lat: sum[1] / ring.length }, area: 0 };
  }
  area /= 2;
  return { point: { lon: cx / (6 * area), lat: cy / (6 * area) }, area: Math.abs(area) };
}

function largestCentroid(rings: (Position[] | undefined)[]): LatLon | null {
  let best: { point: LatLon; area: number } | null = null;
  for (const ring of rings) {
    const c = ring ? ringCentroid(ring) : null;
    if (c && (!best || c.area > best.area)) best = c;
  }
  return best?.point ?? null;
}

/** A point representing the object (point, middle of the line, or centroid). */
export function representativePoint(geometry: Geometry): LatLon | null {
  switch (geometry.type) {
    case 'Point':
      return toLatLon(geometry.coordinates);
    case 'LineString':
      return lineMidpoint(geometry.coordinates);
    case 'MultiLineString': {
      let longest: Position[] | undefined;
      for (const line of geometry.coordinates) {
        if (!longest || lineLength(line) > lineLength(longest)) longest = line;
      }
      return longest ? lineMidpoint(longest) : null;
    }
    case 'Polygon':
      return largestCentroid([geometry.coordinates[0]]);
    case 'MultiPolygon':
      return largestCentroid(geometry.coordinates.map((polygon) => polygon[0]));
  }
}

const RECORD_SEPARATOR = '\u001e';

/** Parses a line of `osmium export -f geojsonseq` (with or without the RS character). */
export function parseGeoJsonSeqLine(line: string): Feature | null {
  const text = (line.startsWith(RECORD_SEPARATOR) ? line.slice(1) : line).trim();
  if (text === '') return null;
  return JSON.parse(text) as Feature;
}

/** Location from the boundaries (see `boundaries.ts`); `null` where they give nothing. */
export interface PlaceLocation {
  country: string | null;
  state: string | null;
  /** Municipality. */
  city?: string | null;
  district?: string | null;
  postcode?: string | null;
}

/**
 * Takes country and state from the boundaries; they take precedence over `addr:country`
 * and `addr:state`. The tags stay only where the boundaries give nothing. If, according to
 * the boundaries, the point lies in a different country than `addr:country`, then
 * `addr:state` does not fit either.
 *
 * City, district and postcode are the other way round: `addr:city` (the postal town),
 * `addr:suburb` and `addr:postcode` stay, the boundaries only fill gaps. Villages and other
 * settlements get the municipality they belong to as their city.
 */
export function withLocation(place: Place, location: PlaceLocation): Place {
  const country = location.country ?? place.country;
  const state =
    location.state ??
    (location.country !== null && location.country !== place.country ? null : place.state);
  const municipality = location.city ?? null;
  const city = CITY_TYPES.has(place.type)
    ? (municipality ?? place.city)
    : (place.city ?? municipality);
  const district = place.district ?? location.district ?? null;
  const postcode = place.postcode ?? location.postcode ?? null;
  if (
    country === place.country &&
    state === place.state &&
    city === place.city &&
    district === place.district &&
    postcode === place.postcode
  ) {
    return place;
  }
  return { ...place, country, state, city, district, postcode };
}
