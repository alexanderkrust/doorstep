/** Geometry helpers. Pure functions. */

const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance in kilometers. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

const KM_PER_DEGREE_LAT = 111.32;

/** Box that surely contains a circle around the point: [minLat, maxLat, minLon, maxLon]. */
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

/**
 * Edge length of the grid cells in degrees (about 28 × 17 km in Germany). Every entry
 * carries its cell as a token in the FTS column `cell`; the nearby search requires one
 * of the box's cells and so does not have to go through all hits.
 * Changing it requires a new schema version.
 */
const GRID_CELL_DEG = 0.25;
const GRID_ROWS = 180 / GRID_CELL_DEG;
const GRID_COLS = 360 / GRID_CELL_DEG;

const gridRow = (lat: number) =>
  Math.min(GRID_ROWS - 1, Math.max(0, Math.floor((lat + 90) / GRID_CELL_DEG)));
const gridCol = (lon: number) =>
  Math.min(GRID_COLS - 1, Math.max(0, Math.floor((lon + 180) / GRID_CELL_DEG)));

/** Token of a point's grid cell, e.g. `g570x773`. */
export function gridCell(lat: number, lon: number): string {
  return `g${String(gridRow(lat))}x${String(gridCol(lon))}`;
}

/** All grid cells that touch the box [minLat, maxLat, minLon, maxLon]. */
export function gridCellsInBox([minLat, maxLat, minLon, maxLon]: readonly [
  number,
  number,
  number,
  number,
]): string[] {
  const cells: string[] = [];
  for (let row = gridRow(minLat); row <= gridRow(maxLat); row++) {
    for (let col = gridCol(minLon); col <= gridCol(maxLon); col++) {
      cells.push(`g${String(row)}x${String(col)}`);
    }
  }
  return cells;
}
