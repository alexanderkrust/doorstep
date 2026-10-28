/** Umwandlung von osmium-GeoJSON-Features in Index-Zeilen. Reine Funktionen. */

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

/** Eine Zeile der Tabelle `places` (ohne die interne `id`). */
export interface Place {
  osmType: OsmType;
  osmId: number;
  /** `house`, `street`, `poi` oder der Wert von `place=*` (z. B. `city`). */
  type: string;
  name: string | null;
  /** `name:de` bzw. `name:en`; ausgewählt per `lang` in der API. */
  nameDe: string | null;
  nameEn: string | null;
  street: string | null;
  housenumber: string | null;
  postcode: string | null;
  city: string | null;
  /** Ortsteil (`addr:suburb`, sonst `addr:hamlet`); `city` ist oft die Gemeinde. */
  district: string | null;
  state: string | null;
  country: string | null;
  lat: number;
  lon: number;
  importance: number;
}

/** Wichtigkeit je Typ: Stadt vor Dorf vor Straße vor Hausnummer. */
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

/** Ortstypen, deren Name gleichzeitig die Stadt ist. */
const CITY_TYPES = new Set(['city', 'town', 'village', 'hamlet']);

const OSM_TYPES: Record<string, OsmType> = { node: 'N', way: 'W', relation: 'R' };

export function importanceFor(type: string): number {
  return IMPORTANCE[type] ?? DEFAULT_IMPORTANCE;
}

function tag(props: Record<string, unknown>, key: string): string | null {
  const value = props[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Bestimmt den Typ; `null`, wenn das Objekt nicht in den Index gehört. */
function classify(props: Record<string, unknown>, name: string | null): string | null {
  const place = tag(props, 'place');
  if (place && name) return place;
  if (tag(props, 'amenity') && name) return 'poi';
  if (tag(props, 'addr:housenumber')) return 'house';
  if (tag(props, 'highway') && name) return 'street';
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
  const type = classify(props, name ?? nameDe ?? nameEn);
  if (!type) return null;

  const point = representativePoint(feature.geometry);
  if (!point) return null;

  return {
    osmType,
    osmId,
    type,
    name,
    nameDe,
    nameEn,
    // Adressen ohne Straße (meist kleine Orte) tragen den Ortsnamen in addr:place.
    street: tag(props, 'addr:street') ?? tag(props, 'addr:place'),
    housenumber: tag(props, 'addr:housenumber'),
    postcode: tag(props, 'addr:postcode') ?? tag(props, 'postal_code'),
    city: tag(props, 'addr:city') ?? (CITY_TYPES.has(type) ? (name ?? nameDe ?? nameEn) : null),
    district: tag(props, 'addr:suburb') ?? tag(props, 'addr:hamlet'),
    state: tag(props, 'addr:state'),
    country: tag(props, 'addr:country'),
    lat: point.lat,
    lon: point.lon,
    importance: importanceFor(type),
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

/** Punkt auf halber Länge der Linie (in Grad, für kurze Strecken ausreichend). */
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

/** Flächenschwerpunkt eines Rings; bei entarteten Ringen der Mittelwert der Punkte. */
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

/** Ein Punkt, der das Objekt repräsentiert (Punkt, Linienmitte oder Schwerpunkt). */
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

/** Parst eine Zeile von `osmium export -f geojsonseq` (mit oder ohne RS-Zeichen). */
export function parseGeoJsonSeqLine(line: string): Feature | null {
  const text = (line.startsWith(RECORD_SEPARATOR) ? line.slice(1) : line).trim();
  if (text === '') return null;
  return JSON.parse(text) as Feature;
}
