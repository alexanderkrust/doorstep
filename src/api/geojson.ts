import { distanceKm } from '../search/geo.js';
import type { PlaceRow } from '../search/search-index.js';
import { ATTRIBUTION } from './attribution.js';

/**
 * What a hit is, independent of OSM tagging:
 * - `address`: a house number without a name
 * - `street`: a street or square
 * - `poi`: a named place such as a shop, station or named building
 * - `locality`: a city, town, village or other settlement
 * - `sublocality`: a part of a city (district, quarter, neighbourhood)
 * - `place`: any other named place
 */
export type ResultType = 'address' | 'street' | 'poi' | 'locality' | 'sublocality' | 'place';

export interface Address {
  street?: string;
  housenumber?: string;
  postcode?: string;
  city?: string;
  district?: string;
  state?: string;
  /** Country name in the requested language. */
  country?: string;
  /** ISO 3166-1 code, e.g. `DE`. */
  country_code?: string;
}

export interface FeatureProperties {
  /** Stable ID of the OSM object, e.g. `node/123`, `way/42`. */
  id: string;
  type: ResultType;
  /** OSM tag that makes the object what it is, e.g. `shop=supermarket`. */
  category?: string;
  /** Name in the requested language; missing for plain addresses. */
  name?: string;
  /** One line for display: `main_text, secondary_text`. */
  label: string;
  /** The part the user is looking for, e.g. the name or "street number". */
  main_text: string;
  /** Where it is, e.g. "80331 München, Deutschland". */
  secondary_text?: string;
  address: Address;
  /** Distance to the request's location (`lat`/`lon`), in meters. */
  distance_m?: number;
}

export interface PointFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: FeatureProperties;
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: PointFeature[];
  /** Foreign member (allowed by GeoJSON); required by the ODbL. */
  attribution: string;
}

const OSM_TYPE_NAMES = { N: 'node', W: 'way', R: 'relation' } as const;
const LOCALITY_TYPES = new Set([
  'city',
  'town',
  'village',
  'hamlet',
  'municipality',
  'isolated_dwelling',
  'farm',
]);
const SUBLOCALITY_TYPES = new Set([
  'borough',
  'suburb',
  'quarter',
  'neighbourhood',
  'city_block',
  'plot',
]);

function resultType(row: PlaceRow, name: string | null): ResultType {
  if (row.type === 'house') return name ? 'poi' : 'address';
  if (row.type === 'street' || row.type === 'square') return 'street';
  if (row.type === 'poi') return 'poi';
  if (LOCALITY_TYPES.has(row.type)) return 'locality';
  if (SUBLOCALITY_TYPES.has(row.type)) return 'sublocality';
  return 'place';
}

/** Name in the requested language; otherwise `name`, otherwise any available name. */
export function displayName(row: PlaceRow, lang: string): string | null {
  const localized = lang === 'de' ? row.name_de : lang === 'en' ? row.name_en : null;
  return localized ?? row.name ?? row.name_de ?? row.name_en;
}

const countryNames = new Map<string, Intl.DisplayNames | null>();

/** "DE" → "Deutschland" (lang `de`) or "Germany" (lang `en`); the code if unknown. */
function countryName(code: string, lang: string): string {
  if (!countryNames.has(lang)) {
    let names: Intl.DisplayNames | null;
    try {
      names = new Intl.DisplayNames([lang, 'en'], { type: 'region' });
    } catch {
      names = null;
    }
    countryNames.set(lang, names);
  }
  try {
    return countryNames.get(lang)?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Joins the non-empty parts, skipping a part that repeats the one before. */
function join(parts: readonly (string | null | undefined)[], separator = ', '): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part && part !== out[out.length - 1]) out.push(part);
  }
  return out.join(separator);
}

/** Leaves out parts of the secondary text that just repeat the main text. */
const without = (main: string, parts: readonly (string | null | undefined)[]) =>
  parts.map((part) => (part === main ? null : part));

/** Main and secondary text as a list of parts, depending on the type. */
function texts(
  row: PlaceRow,
  type: ResultType,
  name: string | null,
  country: string | null,
): { main: string; secondary: string } {
  const streetLine = join([row.street, row.housenumber], ' ');
  const postalCity = join([row.postcode, row.city], ' ');
  const otherCity = row.city !== name ? row.city : null;
  switch (type) {
    case 'address':
      return { main: streetLine, secondary: join([postalCity, country]) };
    case 'poi':
      return {
        main: name ?? streetLine,
        secondary: join([streetLine || row.district, postalCity, country]),
      };
    case 'street':
      return {
        main: name ?? '',
        secondary: join([row.district !== row.city ? row.district : null, row.city, country]),
      };
    case 'locality':
      return { main: name ?? '', secondary: join([otherCity, row.state, country]) };
    case 'sublocality':
    case 'place':
      return {
        main: name ?? '',
        secondary: join([otherCity ?? (row.city ? null : row.state), country]),
      };
  }
}

/** One hit as a GeoJSON feature; missing values are left out. */
export function toFeature(
  row: PlaceRow,
  lang: string,
  origin?: { lat: number; lon: number },
): PointFeature {
  const name = displayName(row, lang);
  const type = resultType(row, name);
  const country = row.country ? countryName(row.country, lang) : null;
  const { main, secondary: raw } = texts(row, type, name, country);
  const secondary = join(without(main, raw.split(', ')));

  const address: Address = {};
  if (row.street) address.street = row.street;
  if (row.housenumber) address.housenumber = row.housenumber;
  if (row.postcode) address.postcode = row.postcode;
  if (row.city) address.city = row.city;
  if (row.district) address.district = row.district;
  if (row.state) address.state = row.state;
  if (country && row.country) {
    address.country = country;
    address.country_code = row.country;
  }

  const properties: FeatureProperties = {
    id: `${OSM_TYPE_NAMES[row.osm_type]}/${String(row.osm_id)}`,
    type,
    ...(row.category ? { category: row.category } : {}),
    ...(name ? { name } : {}),
    label: join([main, secondary]),
    main_text: main,
    ...(secondary ? { secondary_text: secondary } : {}),
    address,
  };
  if (origin) {
    properties.distance_m = Math.round(distanceKm(origin.lat, origin.lon, row.lat, row.lon) * 1000);
  }
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [row.lon, row.lat] },
    properties,
  };
}

export function toFeatureCollection(
  rows: readonly PlaceRow[],
  lang: string,
  origin?: { lat: number; lon: number },
): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: rows.map((row) => toFeature(row, lang, origin)),
    attribution: ATTRIBUTION,
  };
}
