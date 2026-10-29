import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IndexWriter } from '../../src/import/index-writer.js';
import { importanceFor, type Place } from '../../src/import/place.js';
import { SearchIndex } from '../../src/search/search-index.js';

/** More same-named, more important hits than the search used to look through up front (20,000). */
const FAR_STREETS = 25_000;
const HERE = { lat: 52.52, lon: 13.405 };
/** Just north of the grid border at 52.5° (cells g570… and g569…). */
const AT_CELL_BORDER = { lat: 52.501, lon: 13.405 };
/** Near the poles the radius covers too many grid cells; then the search runs without cells. */
const NEAR_POLE = { lat: 89.9, lon: 0 };

function place(overrides: Partial<Place> & Pick<Place, 'osmId' | 'type' | 'lat' | 'lon'>): Place {
  return {
    osmType: 'W',
    name: null,
    nameDe: null,
    nameEn: null,
    street: null,
    housenumber: null,
    postcode: null,
    city: null,
    district: null,
    state: null,
    country: null,
    importance: importanceFor(overrides.type),
    ...overrides,
  };
}

let dir: string;
let index: SearchIndex;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doorstep-location-'));
  const path = join(dir, 'index.sqlite');
  const writer = new IndexWriter(path);
  // Many Hauptstraßen far away (grid in southern Germany, about 2 km apart) …
  const side = Math.ceil(Math.sqrt(FAR_STREETS));
  for (let i = 0; i < FAR_STREETS; i++) {
    writer.add(
      place({
        osmId: i + 1,
        type: 'street',
        name: 'Hauptstraße',
        lat: 47 + Math.floor(i / side) * 0.02,
        lon: 6 + (i % side) * 0.03,
      }),
    );
  }
  // … and an address on a Hauptstraße right at the request's location.
  writer.add(
    place({
      osmType: 'N',
      osmId: 1,
      type: 'house',
      street: 'Hauptstraße',
      housenumber: '3',
      postcode: '10178',
      city: 'Berlin',
      lat: HERE.lat + 0.001,
      lon: HERE.lon,
    }),
  );
  // … one beyond the grid border …
  writer.add(
    place({
      osmType: 'N',
      osmId: 2,
      type: 'house',
      street: 'Hauptstraße',
      housenumber: '7',
      postcode: '10179',
      city: 'Berlin',
      lat: 52.499,
      lon: HERE.lon,
    }),
  );
  // … and one near the pole.
  writer.add(
    place({
      osmType: 'N',
      osmId: 3,
      type: 'house',
      street: 'Hauptstraße',
      housenumber: '9',
      lat: NEAR_POLE.lat,
      lon: NEAR_POLE.lon,
    }),
  );
  writer.finish({});
  index = new SearchIndex(path);
}, 60_000);

afterAll(async () => {
  index.close();
  await rm(dir, { recursive: true, force: true });
});

describe('location bias on large indexes', () => {
  it('finds a nearby address behind many more important hits with the same name', () => {
    const rows = index.search({ q: 'Hauptstr', limit: 5, ...HERE }) ?? [];
    expect(rows[0]).toMatchObject({ type: 'house', street: 'Hauptstraße', housenumber: '3' });
  });

  it('also finds it with a partial house number', () => {
    const rows = index.search({ q: 'Hauptstraße 3', limit: 5, ...HERE }) ?? [];
    expect(rows[0]).toMatchObject({ type: 'house', housenumber: '3' });
  });

  it('finds nearby addresses in the neighboring grid cell', () => {
    const rows = index.search({ q: 'Hauptstr', limit: 5, ...AT_CELL_BORDER }) ?? [];
    expect(rows[0]).toMatchObject({ type: 'house', housenumber: '7' });
  });

  it('finds nearby addresses also where the radius would have too many cells', () => {
    const rows = index.search({ q: 'Hauptstr', limit: 5, ...NEAR_POLE }) ?? [];
    expect(rows[0]).toMatchObject({ type: 'house', housenumber: '9' });
  });

  it('does not let search words match the grid cells', () => {
    expect(index.search({ q: 'g570', limit: 5, ...HERE })).toEqual([]);
    expect(index.search({ q: 'g5', limit: 5 })).toEqual([]);
  });
});
