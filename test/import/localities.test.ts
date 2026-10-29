/**
 * City, district and postcode from boundaries: municipalities (admin_level 8, or cities with
 * `de:place=city` at a higher level such as Köln, Berlin), districts (admin_level 10, else 9)
 * and postcode areas (`boundary=postal_code`).
 */
import { describe, expect, it } from 'vitest';
import { BoundaryIndex } from '../../src/import/boundaries.js';
import { parseGeoJsonSeqLine } from '../../src/import/place.js';

let nextId = 1;

/** A relation area as `osmium export` writes it: a rectangle with the relation's tags. */
function area(
  [minLon, minLat, maxLon, maxLat]: [number, number, number, number],
  tags: Record<string, string>,
): string {
  return JSON.stringify({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [minLon, minLat],
          [maxLon, minLat],
          [maxLon, maxLat],
          [minLon, maxLat],
          [minLon, minLat],
        ],
      ],
    },
    properties: { '@type': 'relation', '@id': nextId++, ...tags },
  });
}

const admin = (level: number, name: string, extra: Record<string, string> = {}) => ({
  boundary: 'administrative',
  admin_level: String(level),
  name,
  ...extra,
});

async function* lines(items: readonly string[]): AsyncGenerator<string> {
  await Promise.resolve();
  yield* items;
}

function load(features: readonly string[]): Promise<BoundaryIndex> {
  return BoundaryIndex.load(() => lines(features), lines([]), parseGeoJsonSeqLine);
}

const WORLD = [
  area([0, 50, 10, 60], admin(2, 'Deutschland', { 'ISO3166-1': 'DE' })),
  area([0, 50, 7, 60], admin(4, 'Nordrhein-Westfalen')),
  area([8, 52, 9, 53], admin(4, 'Berlin', { 'de:place': 'city' })),
  // A district (Landkreis) is not a city …
  area([0, 50, 5, 55], admin(6, 'Landkreis Muster')),
  // … but an independent city at the same level is.
  area([3, 51, 4, 52], admin(6, 'Köln', { 'de:place': 'city' })),
  area([1, 51, 2, 52], admin(8, 'Musterstadt')),
  area([3, 51, 4, 51.5], admin(9, 'Stadtbezirk Innen')),
  area([3, 51, 3.5, 51.5], admin(10, 'Ehrenfeld')),
  area([3, 51, 3.5, 51.2], { boundary: 'postal_code', postal_code: '50823' }),
  area([1, 51, 2, 51.5], { boundary: 'postal_code', postal_code: '12345' }),
];

describe('city, district and postcode from boundaries', () => {
  it('takes the municipality (admin_level 8)', async () => {
    const index = await load(WORLD);
    expect(index.locate(51.4, 1.5)).toMatchObject({
      country: 'DE',
      state: 'Nordrhein-Westfalen',
      city: 'Musterstadt',
      district: null,
      postcode: '12345',
    });
  });

  it('takes an independent city with de:place=city, not a Landkreis', async () => {
    const index = await load(WORLD);
    expect(index.locate(51.1, 3.2)).toMatchObject({
      city: 'Köln',
      district: 'Ehrenfeld',
      postcode: '50823',
    });
    // In the Landkreis, but in no municipality
    expect(index.locate(54, 4)).toMatchObject({ city: null });
  });

  it('takes a city-state (admin_level 4 with de:place=city)', async () => {
    const index = await load(WORLD);
    expect(index.locate(52.5, 8.5)).toMatchObject({ state: 'Berlin', city: 'Berlin' });
  });

  it('falls back to admin_level 9 for the district', async () => {
    const index = await load(WORLD);
    expect(index.locate(51.4, 3.8)).toMatchObject({
      city: 'Köln',
      district: 'Stadtbezirk Innen',
      postcode: null,
    });
  });

  it('finds the right one among thousands of areas', async () => {
    // 50 × 40 municipalities and postcode areas of 0.1° each
    const features = [area([0, 50, 10, 60], admin(2, 'Deutschland', { 'ISO3166-1': 'DE' }))];
    for (let x = 0; x < 50; x++) {
      for (let y = 0; y < 40; y++) {
        const box: [number, number, number, number] = [
          x * 0.1,
          50 + y * 0.1,
          (x + 1) * 0.1,
          50 + (y + 1) * 0.1,
        ];
        features.push(area(box, admin(8, `M${String(x)}-${String(y)}`)));
        features.push(
          area(box, { boundary: 'postal_code', postal_code: `${String(x)}${String(y)}` }),
        );
      }
    }
    const index = await load(features);
    for (const [x, y] of [
      [0, 0],
      [49, 39],
      [17, 23],
      [33, 5],
    ] as const) {
      const lat = 50 + y * 0.1 + 0.05;
      const lon = x * 0.1 + 0.05;
      expect(index.locate(lat, lon)).toMatchObject({
        city: `M${String(x)}-${String(y)}`,
        postcode: `${String(x)}${String(y)}`,
      });
    }
  });

  it('reports the number of localities in the summary', async () => {
    const index = await load(WORLD);
    expect(index.summary).toMatchObject({ municipalities: 3, districts: 2, postcodes: 2 });
  });
});
