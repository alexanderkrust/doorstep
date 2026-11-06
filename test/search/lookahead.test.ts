/**
 * Lookahead: every word the user types can be the start of a word, not only the last one
 * ("gneis 62 düss" → Gneisenaustraße 62, Düsseldorf).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IndexWriter } from '../../src/import/index-writer.js';
import { featureToPlace } from '../../src/import/place.js';
import { SearchIndex, type PlaceRow } from '../../src/search/search-index.js';

let nextId = 1;

function node(lat: number, lon: number, tags: Record<string, string>) {
  return {
    type: 'Feature' as const,
    geometry: { type: 'Point' as const, coordinates: [lon, lat] },
    properties: { '@type': 'node', '@id': nextId++, ...tags },
  };
}

function street(lat: number, lon: number, name: string, city: string, postcode: string) {
  return {
    type: 'Feature' as const,
    geometry: {
      type: 'LineString' as const,
      coordinates: [
        [lon, lat],
        [lon + 0.001, lat],
      ],
    },
    properties: {
      '@type': 'way',
      '@id': nextId++,
      highway: 'residential',
      name,
      'addr:city': city,
      'addr:postcode': postcode,
    },
  };
}

const addr = (street: string, housenumber: string, postcode: string, city: string) => ({
  'addr:street': street,
  'addr:housenumber': housenumber,
  'addr:postcode': postcode,
  'addr:city': city,
});

const FEATURES = [
  // Düsseldorf: the address the user looks for, and similar house numbers
  street(51.2402, 6.7876, 'Gneisenaustraße', 'Düsseldorf', '40477'),
  node(51.2403, 6.7877, addr('Gneisenaustraße', '62', '40477', 'Düsseldorf')),
  node(51.2404, 6.7878, addr('Gneisenaustraße', '6', '40477', 'Düsseldorf')),
  node(51.2405, 6.7879, addr('Gneisenaustraße', '620', '40477', 'Düsseldorf')),
  // Berlin: the same address in another city
  street(52.4918, 13.3953, 'Gneisenaustraße', 'Berlin', '10961'),
  node(52.4919, 13.3954, addr('Gneisenaustraße', '62', '10961', 'Berlin')),
  // A POI whose name starts like the street
  node(51.2302, 6.7801, {
    amenity: 'cafe',
    name: 'Gneisenau-Eck',
    ...addr('Nordstraße', '1', '40477', 'Düsseldorf'),
  }),
  // Frankfurt: a 4-letter street name
  street(50.1147, 8.6825, 'Zeil', 'Frankfurt am Main', '60313'),
  node(50.1148, 8.6826, addr('Zeil', '106', '60313', 'Frankfurt am Main')),
  // Fully typed queries must keep their results
  street(51.2235, 6.7795, 'Königsallee', 'Düsseldorf', '40212'),
  node(51.2236, 6.7796, addr('Königsallee', '1', '40212', 'Düsseldorf')),
  node(51.2237, 6.7797, addr('Königsallee', '11', '40212', 'Düsseldorf')),
];

let dir: string;
let index: SearchIndex;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doorstep-lookahead-'));
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

describe('lookahead: every word as the start of a word', () => {
  it('finds "gneis 62 düss" as Gneisenaustraße 62 in Düsseldorf', () => {
    expect(first('gneis 62 düss')).toMatchObject({
      street: 'Gneisenaustraße',
      housenumber: '62',
      city: 'Düsseldorf',
    });
  });

  it('works with short prefixes (prefix index) and long ones (expanded from the word list)', () => {
    for (const q of ['gnei 62 düss', 'gneise 62 düss', 'gneisenau 62 düsseld']) {
      expect(first(q), q).toMatchObject({ housenumber: '62', city: 'Düsseldorf' });
    }
  });

  it('picks the city from its prefix', () => {
    expect(first('gneis 62 ber')).toMatchObject({ housenumber: '62', city: 'Berlin' });
  });

  it('finds the street when no house number is typed', () => {
    expect(first('gneis düss')).toMatchObject({ type: 'street', city: 'Düsseldorf' });
  });

  it('finds the house number before the street when only the street is a prefix', () => {
    const rows = search('gneis 62');
    expect(rows[0]).toMatchObject({ housenumber: '62' });
    expect(
      rows
        .slice(0, 2)
        .map((r) => r.city)
        .sort(),
    ).toEqual(['Berlin', 'Düsseldorf']);
  });

  it('does not take a house number before the end as a prefix (62 is not 620)', () => {
    const numbers = search('gneis 62 düss').map((r) => r.housenumber);
    expect(numbers).not.toContain('620');
  });

  it('keeps the typo tolerance on the last word', () => {
    expect(first('gneis 62 düsseldorg')).toMatchObject({ housenumber: '62', city: 'Düsseldorf' });
  });

  it('keeps the results of fully typed queries', () => {
    expect(first('gneisenaustr 62 düss')).toMatchObject({ housenumber: '62', city: 'Düsseldorf' });
    expect(first('Königsallee 1')).toMatchObject({ housenumber: '1' });
    expect(first('Königsallee')).toMatchObject({ type: 'street' });
  });
});

describe('typo tolerance in every word', () => {
  it('finds a swapped pair of letters in the first word', () => {
    expect(first('gnies 62 düs')).toMatchObject({
      street: 'Gneisenaustraße',
      housenumber: '62',
      city: 'Düsseldorf',
    });
  });

  it('finds a missing letter in a fully typed word', () => {
    expect(first('gneisenaustrase 62 düss')).toMatchObject({
      housenumber: '62',
      city: 'Düsseldorf',
    });
    expect(first('gneis 62 düseldorf')).toMatchObject({ housenumber: '62', city: 'Düsseldorf' });
  });

  it('finds a wrong letter in the city', () => {
    expect(first('gneis 62 bxrlin')).toMatchObject({ housenumber: '62', city: 'Berlin' });
  });

  it('finds an extra letter', () => {
    expect(first('gneisenaux 62 düss')).toMatchObject({ housenumber: '62', city: 'Düsseldorf' });
  });

  it('does not correct house numbers: a missing number gives the street', () => {
    expect(first('gneis 63 düss')).toMatchObject({ type: 'street', city: 'Düsseldorf' });
  });

  it('finds two typos in a long word', () => {
    expect(first('gxexsenau 62 düss')).toMatchObject({ housenumber: '62', city: 'Düsseldorf' });
  });

  it('finds a swap after the 7th letter', () => {
    expect(first('gneisenaustrsae 62 düs')).toMatchObject({
      housenumber: '62',
      city: 'Düsseldorf',
    });
  });

  it('finds a typo in a 4-letter word', () => {
    expect(first('zeli 106 frankfurt')).toMatchObject({ street: 'Zeil', housenumber: '106' });
  });

  it('finds nothing for words with more typos than allowed', () => {
    expect(search('gxexsxnau 62 düss')).toEqual([]);
  });
});

describe('typo tolerance without the SymSpell table (index from an older import)', () => {
  let oldDir: string;
  let old: SearchIndex;

  beforeAll(async () => {
    oldDir = await mkdtemp(join(tmpdir(), 'doorstep-no-symspell-'));
    const path = join(oldDir, 'index.sqlite');
    const writer = new IndexWriter(path);
    for (const feature of FEATURES) {
      const place = featureToPlace(feature);
      if (place) writer.add(place);
    }
    writer.finish({});
    const db = new DatabaseSync(path);
    db.exec("DROP TABLE fuzzy_deletes; DELETE FROM meta WHERE key = 'fuzzy';");
    db.close();
    old = new SearchIndex(path);
  });

  afterAll(async () => {
    old.close();
    await rm(oldDir, { recursive: true, force: true });
  });

  it('still corrects one typo in words of 5 letters or more', () => {
    expect(old.search({ q: 'gnies 62 düs', limit: 1 })?.[0]).toMatchObject({ housenumber: '62' });
  });

  it('does not correct two typos', () => {
    expect(old.search({ q: 'gxexsenau 62 düss', limit: 1 })).toEqual([]);
  });
});
