/**
 * Inputs as they occur when checking addresses in a web shop. The data mimics cases from
 * the Germany extract where the search used to find nothing or the wrong place.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IndexWriter } from '../../src/import/index-writer.js';
import { featureToPlace } from '../../src/import/place.js';
import { SearchIndex, type PlaceRow } from '../../src/search/search-index.js';

let nextId = 1;

/** An OSM node with the given tags. */
function node(lat: number, lon: number, tags: Record<string, string>) {
  return {
    type: 'Feature' as const,
    geometry: { type: 'Point' as const, coordinates: [lon, lat] },
    properties: { '@type': 'node', '@id': nextId++, ...tags },
  };
}

/** A street segment as a short line. */
function street(lat: number, lon: number, name: string) {
  return {
    type: 'Feature' as const,
    geometry: {
      type: 'LineString' as const,
      coordinates: [
        [lon, lat],
        [lon + 0.001, lat],
      ],
    },
    properties: { '@type': 'way', '@id': nextId++, highway: 'residential', name },
  };
}

const addr = (street: string, housenumber: string, postcode: string, city: string) => ({
  'addr:street': street,
  'addr:housenumber': housenumber,
  'addr:postcode': postcode,
  'addr:city': city,
});

const FEATURES = [
  // Sylt: municipality Sylt, district Westerland
  node(54.9076, 8.3076, {
    ...addr('Strandstraße', '1', '25980', 'Sylt'),
    'addr:suburb': 'Westerland',
  }),
  street(54.9078, 8.3071, 'Strandstraße'),
  // Bonn has the street but no no. 1; Bönen has no. 1
  street(50.7184, 7.1186, 'Konrad-Adenauer-Straße'),
  node(50.7185, 7.1187, addr('Konrad-Adenauer-Straße', '7', '53113', 'Bonn')),
  node(51.5977, 7.7518, addr('Konrad-Adenauer-Straße', '1', '59199', 'Bönen')),
  // Frankfurt am Main
  node(50.1153, 8.6806, addr('Zeil', '106', '60313', 'Frankfurt am Main')),
  // ß + s: "Schloßstraße"
  node(52.4644, 13.3271, addr('Schloßstraße', '1', '12163', 'Berlin')),
  // House number with a space before the letter
  node(51.2, 6.8, addr('Musterweg', '12 a', '40210', 'Düsseldorf')),
  // Address without a street (addr:place), Kleinwalsertal
  node(47.3809, 10.216, {
    'addr:place': 'Wäldele',
    'addr:housenumber': '16',
    'addr:postcode': '87567',
    'addr:city': 'Riezlern',
  }),
  // "St." and "Sankt": church with the short form, town with the long form
  node(48.934, 10.9713, { amenity: 'place_of_worship', name: 'St. Augustin' }),
  node(50.7753, 7.1896, { place: 'town', name: 'Sankt Augustin' }),
  // Berlin district
  node(52.5407, 13.4117, {
    ...addr('Kastanienallee', '1', '10435', 'Berlin'),
    'addr:suburb': 'Prenzlauer Berg',
  }),
  node(52.5361, 13.6007, addr('Kastanienallee', '1', '12627', 'Berlin')),
];

let dir: string;
let index: SearchIndex;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doorstep-address-cases-'));
  const path = join(dir, 'index.sqlite');
  const writer = new IndexWriter(path);
  for (const feature of FEATURES) {
    const place = featureToPlace(feature);
    if (place) writer.add(place);
  }
  writer.finish({});
  index = new SearchIndex(path);
});

afterAll(async () => {
  index.close();
  await rm(dir, { recursive: true, force: true });
});

const search = (q: string): PlaceRow[] => index.search({ q, limit: 5 }) ?? [];
const first = (q: string) => search(q)[0];

describe('address input in a web shop', () => {
  it('finds an address via the district (Westerland in the municipality of Sylt)', () => {
    expect(first('Strandstraße 1 Westerland')).toMatchObject({
      housenumber: '1',
      city: 'Sylt',
      district: 'Westerland',
    });
    expect(first('Strandstraße 1, 25980 Sylt')).toMatchObject({ district: 'Westerland' });
  });

  it('takes the district for streets from the nearest address', () => {
    expect(first('Strandstraße Westerland')).toMatchObject({
      type: 'street',
      district: 'Westerland',
    });
  });

  it('finds the Berlin district instead of a street with the same name elsewhere in Berlin', () => {
    expect(first('Kastanienallee 1 Prenzlauer Berg')).toMatchObject({ postcode: '10435' });
  });

  it('prefers the street in the named city over a house number in a similarly spelled one', () => {
    expect(first('Konrad-Adenauer-Str. 1 Bonn')).toMatchObject({ type: 'street', city: 'Bonn' });
  });

  it('understands "a.M." and similar abbreviations', () => {
    expect(first('Zeil 106 Frankfurt a.M.')).toMatchObject({ housenumber: '106' });
  });

  it('finds "Schlosstr" as Schloßstraße', () => {
    expect(first('Schlosstr 1 Berlin')).toMatchObject({ street: 'Schloßstraße' });
  });

  it('finds a house number without a space after the street', () => {
    expect(first('schloßstraße1 berlin')).toMatchObject({ street: 'Schloßstraße' });
  });

  it('finds "12a" when OSM writes "12 a", and vice versa', () => {
    expect(first('Musterweg 12a')).toMatchObject({ housenumber: '12 a' });
    expect(first('Musterweg 12 a')).toMatchObject({ housenumber: '12 a' });
  });

  it('finds addresses without a street via addr:place', () => {
    expect(first('Wäldele 16 Riezlern')).toMatchObject({ street: 'Wäldele', postcode: '87567' });
  });

  it('treats "St." and "Sankt" the same', () => {
    expect(first('St. Augustin')).toMatchObject({ type: 'town', name: 'Sankt Augustin' });
    expect(search('Sankt Augustin').map((r) => r.name)).toContain('St. Augustin');
  });
});

describe('building the search index in blocks', () => {
  it('includes all rows, also across block boundaries', async () => {
    const blockDir = await mkdtemp(join(tmpdir(), 'doorstep-blocks-'));
    try {
      const path = join(blockDir, 'index.sqlite');
      const writer = new IndexWriter(path, { indexBatchSize: 3 });
      for (const feature of FEATURES) {
        const place = featureToPlace(feature);
        if (place) writer.add(place);
      }
      const count = writer.finish({});
      const blocks = new SearchIndex(path);
      try {
        expect(count).toBe(FEATURES.length);
        // Every row can be found via FTS and via the R*Tree
        expect(blocks.search({ q: 'Strandstraße 1 Westerland', limit: 1 })).toHaveLength(1);
        expect(blocks.search({ q: 'Sankt Augustin', limit: 1 })).toHaveLength(1);
        expect(blocks.search({ q: 'Kastanienallee 1 Prenzlauer', limit: 1 })).toHaveLength(1);
        const near = blocks.reverse({ lat: 52.5361, lon: 13.6007, limit: 1, radiusKm: 1 });
        expect(near?.[0]).toMatchObject({ postcode: '12627' });
      } finally {
        blocks.close();
      }
    } finally {
      await rm(blockDir, { recursive: true, force: true });
    }
  });
});

describe('spelling variants of street names', () => {
  let variantsDir: string;
  let variants: SearchIndex;

  beforeAll(async () => {
    variantsDir = await mkdtemp(join(tmpdir(), 'doorstep-variants-'));
    const path = join(variantsDir, 'index.sqlite');
    const writer = new IndexWriter(path);
    for (const feature of [
      node(52.5069, 13.3907, addr('Friedrichstraße', '43', '10969', 'Berlin')),
      node(52.458, 13.5009, addr('Friedrich-List-Straße', '43', '12487', 'Berlin')),
      node(50.7, 7.1, addr('Konrad-Adenauer-Straße', '1', '53604', 'Bad Honnef')),
    ]) {
      const place = featureToPlace(feature);
      if (place) writer.add(place);
    }
    writer.finish({});
    variants = new SearchIndex(path);
  });

  afterAll(async () => {
    variants.close();
    await rm(variantsDir, { recursive: true, force: true });
  });

  const top = (q: string) => variants.search({ q, limit: 5 })?.[0];

  it('finds "Friedrich Straße" as Friedrichstraße, not as Friedrich-List-Straße', () => {
    expect(top('Friedrich Straße 43 Berlin')).toMatchObject({ street: 'Friedrichstraße' });
  });

  it('finds "Konrad-Adenauerstraße" as Konrad-Adenauer-Straße', () => {
    expect(top('Konrad-Adenauerstraße 1')).toMatchObject({ street: 'Konrad-Adenauer-Straße' });
    expect(top('Konrad Adenauerstr 1 Bad Honnef')).toMatchObject({ postcode: '53604' });
  });
});

describe('duplicates in the results', () => {
  let dupDir: string;
  let dups: SearchIndex;

  beforeAll(async () => {
    dupDir = await mkdtemp(join(tmpdir(), 'doorstep-dups-'));
    const path = join(dupDir, 'index.sqlite');
    const writer = new IndexWriter(path);
    for (const feature of [
      // The city as a boundary centroid and as a place node, 4.4 km apart
      node(52.3247, 14.4903, { place: 'city', name: 'Frankfurt (Oder)' }),
      node(52.3412, 14.5495, { place: 'town', name: 'Frankfurt (Oder)' }),
      // Two station nodes 100 m apart, one with an English name
      node(53.5532, 10.0064, { railway: 'station', name: 'Hamburg Hauptbahnhof' }),
      node(53.5527, 10.0076, {
        railway: 'station',
        name: 'Hamburg Hauptbahnhof',
        'name:en': 'Hamburg Central Station',
      }),
    ]) {
      const place = featureToPlace(feature);
      if (place) writer.add(place);
    }
    writer.finish({});
    dups = new SearchIndex(path);
  });

  afterAll(async () => {
    dups.close();
    await rm(dupDir, { recursive: true, force: true });
  });

  it('shows a city only once, even as a boundary and a place node', () => {
    expect(dups.search({ q: 'Frankfurt Oder', limit: 5 })).toHaveLength(1);
  });

  it('shows a station only once, even with different English names', () => {
    expect(dups.search({ q: 'Hamburg Hauptbahnhof', limit: 5 })).toHaveLength(1);
  });
});

describe('address queries on a common street name', () => {
  let streetDir: string;
  let streets: SearchIndex;

  beforeAll(async () => {
    streetDir = await mkdtemp(join(tmpdir(), 'doorstep-common-street-'));
    const path = join(streetDir, 'index.sqlite');
    const writer = new IndexWriter(path);
    // More POIs on a Hauptstraße than the search reads as candidates (200) …
    for (let i = 0; i < 250; i++) {
      const place = featureToPlace(
        node(48 + i * 0.01, 9, {
          amenity: 'restaurant',
          name: `Gasthaus ${String(i)}`,
          ...addr('Hauptstraße', `1${String(i)}`, '70000', `Ort ${String(i)}`),
        }),
      );
      if (place) writer.add(place);
    }
    // … and one plain address with exactly the number searched for.
    const house = featureToPlace(node(52, 13, addr('Hauptstraße', '1', '10000', 'Berlin')));
    if (house) writer.add(house);
    writer.finish({});
    streets = new SearchIndex(path);
  });

  afterAll(async () => {
    streets.close();
    await rm(streetDir, { recursive: true, force: true });
  });

  it('finds the plain address behind many more important POIs', () => {
    expect(streets.search({ q: 'Hauptstraße 1', limit: 5 })?.[0]).toMatchObject({
      type: 'house',
      housenumber: '1',
      city: 'Berlin',
    });
  });
});
