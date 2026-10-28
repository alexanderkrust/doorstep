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
  'state',
  'country',
] as const;

/** GeoJSON-Feature; fehlende Werte werden weggelassen. */
export function toFeature(row: PlaceRow): PointFeature {
  const properties: Record<string, string | number> = {
    osm_type: row.osm_type,
    osm_id: row.osm_id,
    type: row.type,
  };
  for (const key of PROPERTY_KEYS) {
    const value = row[key];
    if (value !== null) properties[key] = value;
  }
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [row.lon, row.lat] },
    properties,
  };
}

export function toFeatureCollection(rows: readonly PlaceRow[]): FeatureCollection {
  return { type: 'FeatureCollection', features: rows.map(toFeature), attribution: ATTRIBUTION };
}
