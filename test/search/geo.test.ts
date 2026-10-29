import { describe, expect, it } from 'vitest';
import { boundingBox, gridCell, gridCellsInBox } from '../../src/search/geo.js';

describe('gridCell', () => {
  it('names the grid cell of a point', () => {
    // Row floor((52.52 + 90) / 0.25) = 570, column floor((13.405 + 180) / 0.25) = 773
    expect(gridCell(52.52, 13.405)).toBe('g570x773');
    expect(gridCell(-90, -180)).toBe('g0x0');
  });

  it('assigns edge values to a valid cell', () => {
    expect(gridCell(90, 180)).toBe('g719x1439');
  });
});

describe('gridCellsInBox', () => {
  it('contains the cell of every point in the box', () => {
    const box = boundingBox(52.5, 13.4, 25);
    const cells = new Set(gridCellsInBox(box));
    const [minLat, maxLat, minLon, maxLon] = box;
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j <= 20; j++) {
        const lat = minLat + ((maxLat - minLat) * i) / 20;
        const lon = minLon + ((maxLon - minLon) * j) / 20;
        expect(cells.has(gridCell(lat, lon))).toBe(true);
      }
    }
  });

  it('needs only a few cells for 25 km in Central Europe', () => {
    expect(gridCellsInBox(boundingBox(52.52, 13.405, 25)).length).toBeLessThanOrEqual(12);
  });

  it('limits the box to valid coordinates', () => {
    const cells = gridCellsInBox([89.9, 91, 179.9, 181]);
    expect(cells).toEqual(['g719x1439']);
  });
});
