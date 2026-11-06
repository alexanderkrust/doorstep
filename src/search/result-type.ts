/**
 * What a hit is, independent of OSM tagging. Used by the API (`type` of a feature, the
 * `types` parameter), by INDEX_TYPES at import and as a token in the full-text index.
 * - `address`: a house number without a name
 * - `street`: a street or square
 * - `poi`: a named place such as a shop, station or named building
 * - `locality`: a city, town, village or other settlement
 * - `sublocality`: a part of a city (district, quarter, neighbourhood)
 * - `place`: any other named place
 */
export const RESULT_TYPES = [
  'address',
  'street',
  'poi',
  'locality',
  'sublocality',
  'place',
] as const;

export type ResultType = (typeof RESULT_TYPES)[number];

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

/** Result type of a row from its `type` column and whether it has any name. */
export function resultType(type: string, named: boolean): ResultType {
  if (type === 'house') return named ? 'poi' : 'address';
  if (type === 'street' || type === 'square') return 'street';
  if (type === 'poi') return 'poi';
  if (LOCALITY_TYPES.has(type)) return 'locality';
  if (SUBLOCALITY_TYPES.has(type)) return 'sublocality';
  return 'place';
}

/**
 * Token of a result type in the FTS column `kind`. A word that no name produces, so the
 * word statistics can leave it out (`kindstreet`, …).
 */
export const kindToken = (type: ResultType): string => `kind${type}`;

/** "address, street, poi, …" for error messages. */
export const RESULT_TYPE_LIST = RESULT_TYPES.join(', ');

/**
 * Comma-separated result types ("street, poi"), case-insensitive, without duplicates.
 * Unknown values are returned in `unknown`.
 */
export function parseResultTypes(value: string): { types: ResultType[]; unknown: string[] } {
  const types: ResultType[] = [];
  const unknown: string[] = [];
  for (const raw of value.split(',')) {
    const item = raw.trim().toLowerCase();
    if (item === '') continue;
    if ((RESULT_TYPES as readonly string[]).includes(item)) {
      if (!types.includes(item as ResultType)) types.push(item as ResultType);
    } else {
      unknown.push(item);
    }
  }
  return { types, unknown };
}
