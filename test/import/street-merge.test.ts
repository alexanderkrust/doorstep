import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lineEnds, type Feature } from '../../src/import/place.js';
import { importFromGeoJsonSeq } from '../../src/import/pipeline.js';
import { SearchIndex } from '../../src/search/search-index.js';

let nextId = 1000;

/** A node with tags. */
function point(lat: number, lon: number, tags: Record<string, string>): Feature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { '@type': 'node', '@id': nextId++, ...tags },
  };
}

/** A street way from `[lon, lat]` points. */
function way(points: number[][], tags: Record<string, string>): Feature {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: points },
    properties: { '@type': 'way', '@id': nextId++, highway: 'residential', ...tags },
  };
}

// Lindenstraße in three connected pieces from west to east (6.700 → 6.730), the last one far
// enough from the first that a location near it should point there.
const WEST = [6.7, 51.2];
const MIDDLE_A = [6.71, 51.2];
const MIDDLE_B = [6.72, 51.2];
const EAST = [6.73, 51.2];
const FEATURES: Feature[] = [
  way([WEST, MIDDLE_A], { name: 'Lindenstraße' }),
  way([MIDDLE_A, MIDDLE_B], { name: 'Lindenstraße', wikidata: 'Q1' }),
  way([MIDDLE_B, EAST], { name: 'Lindenstraße' }),
  // Same name, not connected: a different street.
  way(
    [
      [7.0, 51.5],
      [7.01, 51.5],
    ],
    { name: 'Lindenstraße' },
  ),
  // Connected, different name.
  way([EAST, [6.74, 51.2]], { name: 'Ahornweg' }),
  // Connected, same name, other postcode: stays apart (delivery checks need the postcode).
  way(
    [
      [6.74, 51.2],
      [6.75, 51.2],
    ],
    { name: 'Ahornweg', postal_code: '40211' },
  ), // Connected, but the addresses along it lie in two postcode areas: two entries. Without
  // postcode boundaries the postcode comes from the addresses, before the merge.
  way(
    [
      [6.8, 51.3],
      [6.81, 51.3],
    ],
    { name: 'Birkenweg' },
  ),
  way(
    [
      [6.81, 51.3],
      [6.82, 51.3],
    ],
    { name: 'Birkenweg' },
  ),
  point(51.3, 6.805, {
    'addr:street': 'Birkenweg',
    'addr:housenumber': '1',
    'addr:postcode': '40210',
  }),
  point(51.3, 6.815, {
    'addr:street': 'Birkenweg',
    'addr:housenumber': '99',
    'addr:postcode': '40227',
  }),
  // Search merge: pieces in two postcode areas stay two hits, pieces that do not touch in the
  // same area become one.
  way(
    [
      [6.9, 51.4],
      [6.905, 51.4],
    ],
    { name: 'Kölner Straße', postal_code: '40211' },
  ),
  way(
    [
      [6.905, 51.4],
      [6.91, 51.4],
    ],
    { name: 'Kölner Straße', postal_code: '40227' },
  ),
  way(
    [
      [6.95, 51.4],
      [6.952, 51.4],
    ],
    { name: 'Ulmenweg', postal_code: '40210' },
  ),
  way(
    [
      [6.955, 51.4],
      [6.957, 51.4],
    ],
    { name: 'Ulmenweg', postal_code: '40210' },
  ),
];

interface Row {
  id: number;
  osm_id: number;
  name: string;
  lat: number;
  lon: number;
  importance: number;
  postcode: string | null;
}

describe('lineEnds', () => {
  it('returns the first and last point of a line', () => {
    expect(lineEnds({ type: 'LineString', coordinates: [WEST, MIDDLE_A, EAST] })).toEqual([
      WEST,
      EAST,
    ]);
  });

  it('returns the ends of every part of a multi-line', () => {
    expect(
      lineEnds({
        type: 'MultiLineString',
        coordinates: [
          [WEST, MIDDLE_A],
          [MIDDLE_B, EAST],
        ],
      }),
    ).toEqual([WEST, MIDDLE_A, MIDDLE_B, EAST]);
  });

  it('returns nothing for points and areas', () => {
    expect(lineEnds({ type: 'Point', coordinates: WEST })).toEqual([]);
  });
});

describe('merging street segments during the import', () => {
  let dir: string;
  let path: string;
  let rows: Row[];
  let index: SearchIndex;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'doorstep-merge-'));
    const input = join(dir, 'streets.geojsonseq');
    await writeFile(input, FEATURES.map((f) => JSON.stringify(f)).join('\n'));
    path = join(dir, 'index.sqlite');
    await importFromGeoJsonSeq(input, path);
    const db = new DatabaseSync(path, { readOnly: true });
    rows = db
      .prepare('SELECT id, osm_id, name, lat, lon, importance, postcode FROM places ORDER BY id')
      .all() as unknown as Row[];
    db.close();
    index = new SearchIndex(path);
  });

  afterAll(async () => {
    index.close();
    await rm(dir, { recursive: true, force: true });
  });

  const lindenstrassen = () => rows.filter((r) => r.name === 'Lindenstraße');

  it('keeps one entry for connected segments with the same name', () => {
    expect(lindenstrassen()).toHaveLength(2);
  });

  it('places the merged street on the segment in the middle, with the highest importance', () => {
    const merged = lindenstrassen().find((r) => r.lon < 7);
    expect(merged?.lon).toBeCloseTo(6.715, 6);
    // The middle segment carries wikidata; it wins anyway, and its importance counts.
    expect(merged?.importance).toBe(Math.max(...lindenstrassen().map((r) => r.importance)));
  });

  it('keeps segments with another name or another postcode apart', () => {
    const ahornweg = rows.filter((r) => r.name === 'Ahornweg');
    expect(ahornweg.map((r) => r.postcode).sort()).toEqual(['40211', null].sort());
  });

  it('keeps a street apart where its addresses have other postcodes', () => {
    const birkenweg = rows.filter((r) => r.name === 'Birkenweg');
    expect(birkenweg.map((r) => r.postcode).sort()).toEqual(['40210', '40227']);
  });

  it('shows a street once per postcode area in the search', () => {
    const koelner = index.search({ q: 'Kölner Straße', limit: 5, lat: 51.4, lon: 6.905 }) ?? [];
    expect(koelner.map((r) => r.postcode).sort()).toEqual(['40211', '40227']);
    const ulmen = index.search({ q: 'Ulmenweg', limit: 5 }) ?? [];
    expect(ulmen).toHaveLength(1);
  });

  it('numbers the rows without gaps', () => {
    expect(rows.map((r) => r.id)).toEqual(rows.map((_, i) => i + 1));
  });

  it('points to the nearest segment when a location is given', () => {
    const [hit] = index.search({ q: 'Lindenstraße', limit: 1, lat: 51.2, lon: 6.729 }) ?? [];
    expect(hit?.lon).toBeCloseTo(6.725, 6);
    const [plain] = index.search({ q: 'Lindenstraße', limit: 1 }) ?? [];
    expect(plain?.lon).toBeCloseTo(6.715, 6);
  });

  it('ranks the street by the distance to its nearest segment', () => {
    // Without the nearest segment, the unconnected Lindenstraße (at 7.0) would not lose much.
    const hits = index.search({ q: 'Lindenstraße', limit: 2, lat: 51.2, lon: 6.729 }) ?? [];
    expect(hits[0]?.lon).toBeLessThan(7);
  });

  it('finds the merged street in /reverse at every segment', () => {
    const [hit] = index.reverse({ lat: 51.2, lon: 6.725, limit: 1, radiusKm: 0.2 }) ?? [];
    expect(hit).toMatchObject({ name: 'Lindenstraße' });
    expect(hit?.lon).toBeCloseTo(6.725, 6);
  });
});
