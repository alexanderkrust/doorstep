/** Geometrie-Hilfen. Reine Funktionen. */

const EARTH_RADIUS_KM = 6371.0088;

/** Großkreisentfernung in Kilometern. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

const KM_PER_DEGREE_LAT = 111.32;

/** Box, die einen Kreis um den Punkt sicher enthält: [minLat, maxLat, minLon, maxLon]. */
export function boundingBox(
  lat: number,
  lon: number,
  radiusKm: number,
): [number, number, number, number] {
  const dLat = radiusKm / KM_PER_DEGREE_LAT;
  const cos = Math.cos((lat * Math.PI) / 180);
  const dLon = Math.min(180, radiusKm / (KM_PER_DEGREE_LAT * Math.max(0.01, cos)));
  return [lat - dLat, lat + dLat, lon - dLon, lon + dLon];
}
