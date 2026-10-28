import type { PlaceRow } from '../search/search-index.js';
import { ATTRIBUTION } from './attribution.js';

export interface PointFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, string | number>;
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: PointFeature[];
  /** Fremdes Member (GeoJSON erlaubt das); Pflicht nach ODbL. */
  attribution: string;
}

const PROPERTY_KEYS = [
  'name',
  'housenumber',
  'street',
  'postcode',
  'city',
  'district',
  'state',
  'country',
] as const;

/** Name in der gewünschten Sprache; sonst `name`, sonst irgendein vorhandener Name. */
export function displayName(row: PlaceRow, lang: string): string | null {
  const localized = lang === 'de' ? row.name_de : lang === 'en' ? row.name_en : null;
  return localized ?? row.name ?? row.name_de ?? row.name_en;
}

/** GeoJSON-Feature; fehlende Werte werden weggelassen. */
export function toFeature(row: PlaceRow, lang: string): PointFeature {
  const properties: Record<string, string | number> = {
    osm_type: row.osm_type,
    osm_id: row.osm_id,
    type: row.type,
  };
  for (const key of PROPERTY_KEYS) {
    const value = key === 'name' ? displayName(row, lang) : row[key];
    if (value !== null) properties[key] = value;
  }
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [row.lon, row.lat] },
    properties,
  };
}

export function toFeatureCollection(rows: readonly PlaceRow[], lang: string): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: rows.map((row) => toFeature(row, lang)),
    attribution: ATTRIBUTION,
  };
}
