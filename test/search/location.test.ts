import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IndexWriter } from '../../src/import/index-writer.js';
import { importanceFor, type Place } from '../../src/import/place.js';
import { SearchIndex } from '../../src/search/search-index.js';

/** Mehr gleichnamige, wichtigere Treffer, als die Suche früher vorab durchsah (20.000). */
const FAR_STREETS = 25_000;
const HERE = { lat: 52.52, lon: 13.405 };
/** Knapp nördlich der Rastergrenze bei 52,5° (Zellen g570… und g569…). */
const AT_CELL_BORDER = { lat: 52.501, lon: 13.405 };
/** In Polnähe deckt der Umkreis zu viele Rasterzellen ab; dann wird ohne Zellen gesucht. */
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
  // Viele Hauptstraßen weit weg (Raster in Süddeutschland, Abstand ca. 2 km) …
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
  // … und eine Adresse an einer Hauptstraße direkt am Standort der Anfrage.
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
  // … eine jenseits der Rastergrenze …
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
  // … und eine in Polnähe.
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

describe('Location Bias auf großen Indizes', () => {
  it('findet eine nahe Adresse hinter vielen wichtigeren gleichnamigen Treffern', () => {
    const rows = index.search({ q: 'Hauptstr', limit: 5, ...HERE }) ?? [];
    expect(rows[0]).toMatchObject({ type: 'house', street: 'Hauptstraße', housenumber: '3' });
  });

  it('findet sie auch mit angefangener Hausnummer', () => {
    const rows = index.search({ q: 'Hauptstraße 3', limit: 5, ...HERE }) ?? [];
    expect(rows[0]).toMatchObject({ type: 'house', housenumber: '3' });
  });

  it('findet nahe Adressen in der Nachbarzelle des Rasters', () => {
    const rows = index.search({ q: 'Hauptstr', limit: 5, ...AT_CELL_BORDER }) ?? [];
    expect(rows[0]).toMatchObject({ type: 'house', housenumber: '7' });
  });

  it('findet nahe Adressen auch dort, wo der Umkreis zu viele Zellen hätte', () => {
    const rows = index.search({ q: 'Hauptstr', limit: 5, ...NEAR_POLE }) ?? [];
    expect(rows[0]).toMatchObject({ type: 'house', housenumber: '9' });
  });

  it('lässt Suchwörter nicht auf die Rasterzellen passen', () => {
    expect(index.search({ q: 'g570', limit: 5, ...HERE })).toEqual([]);
    expect(index.search({ q: 'g5', limit: 5 })).toEqual([]);
  });
});
