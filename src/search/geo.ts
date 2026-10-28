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

/**
 * Kantenlänge der Rasterzellen in Grad (ca. 28 × 17 km in Deutschland). Jeder
 * Eintrag trägt seine Zelle als Token in der FTS-Spalte `cell`; die Umkreissuche
 * verlangt eine der Zellen der Box und muss so nicht alle Treffer durchgehen.
 * Eine Änderung erfordert eine neue Schema-Version.
 */
const GRID_CELL_DEG = 0.25;
const GRID_ROWS = 180 / GRID_CELL_DEG;
const GRID_COLS = 360 / GRID_CELL_DEG;

const gridRow = (lat: number) =>
  Math.min(GRID_ROWS - 1, Math.max(0, Math.floor((lat + 90) / GRID_CELL_DEG)));
const gridCol = (lon: number) =>
  Math.min(GRID_COLS - 1, Math.max(0, Math.floor((lon + 180) / GRID_CELL_DEG)));

/** Token der Rasterzelle eines Punkts, z. B. `g570x773`. */
export function gridCell(lat: number, lon: number): string {
  return `g${String(gridRow(lat))}x${String(gridCol(lon))}`;
}

/** Alle Rasterzellen, die die Box [minLat, maxLat, minLon, maxLon] berühren. */
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
