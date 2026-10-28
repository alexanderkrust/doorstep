/**
 * Eingaben, wie sie bei der Adressprüfung im Webshop vorkommen. Die Daten sind Fällen
 * aus dem Deutschland-Extrakt nachgebaut, bei denen die Suche früher nichts oder den
 * falschen Ort fand.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IndexWriter } from '../../src/import/index-writer.js';
import { featureToPlace } from '../../src/import/place.js';
import { SearchIndex, type PlaceRow } from '../../src/search/search-index.js';

let nextId = 1;

/** Ein OSM-Knoten mit den angegebenen Tags. */
function node(lat: number, lon: number, tags: Record<string, string>) {
  return {
    type: 'Feature' as const,
    geometry: { type: 'Point' as const, coordinates: [lon, lat] },
    properties: { '@type': 'node', '@id': nextId++, ...tags },
  };
}

/** Ein Straßenabschnitt als kurze Linie. */
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
  // Sylt: Gemeinde Sylt, Ortsteil Westerland
  node(54.9076, 8.3076, {
    ...addr('Strandstraße', '1', '25980', 'Sylt'),
    'addr:suburb': 'Westerland',
  }),
  street(54.9078, 8.3071, 'Strandstraße'),
  // Bonn hat die Straße, aber keine Nr. 1; Bönen hat Nr. 1
  street(50.7184, 7.1186, 'Konrad-Adenauer-Straße'),
  node(50.7185, 7.1187, addr('Konrad-Adenauer-Straße', '7', '53113', 'Bonn')),
  node(51.5977, 7.7518, addr('Konrad-Adenauer-Straße', '1', '59199', 'Bönen')),
  // Frankfurt am Main
  node(50.1153, 8.6806, addr('Zeil', '106', '60313', 'Frankfurt am Main')),
  // ß + s: "Schloßstraße"
  node(52.4644, 13.3271, addr('Schloßstraße', '1', '12163', 'Berlin')),
  // Hausnummer mit Leerzeichen vor dem Buchstaben
  node(51.2, 6.8, addr('Musterweg', '12 a', '40210', 'Düsseldorf')),
  // Adresse ohne Straße (addr:place), Kleinwalsertal
  node(47.3809, 10.216, {
    'addr:place': 'Wäldele',
    'addr:housenumber': '16',
    'addr:postcode': '87567',
    'addr:city': 'Riezlern',
  }),
  // "St." und "Sankt": Kirche mit Kurzform, Stadt mit Langform
  node(48.934, 10.9713, { amenity: 'place_of_worship', name: 'St. Augustin' }),
  node(50.7753, 7.1896, { place: 'town', name: 'Sankt Augustin' }),
  // Berliner Ortsteil
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

describe('Adresseingaben im Webshop', () => {
  it('findet eine Adresse über den Ortsteil (Westerland in der Gemeinde Sylt)', () => {
    expect(first('Strandstraße 1 Westerland')).toMatchObject({
      housenumber: '1',
      city: 'Sylt',
      district: 'Westerland',
    });
    expect(first('Strandstraße 1, 25980 Sylt')).toMatchObject({ district: 'Westerland' });
  });

  it('übernimmt den Ortsteil für Straßen von der nächsten Adresse', () => {
    expect(first('Strandstraße Westerland')).toMatchObject({
      type: 'street',
      district: 'Westerland',
    });
  });

  it('findet den Berliner Ortsteil statt einer gleichnamigen Straße woanders in Berlin', () => {
    expect(first('Kastanienallee 1 Prenzlauer Berg')).toMatchObject({ postcode: '10435' });
  });

  it('nimmt lieber die Straße im genannten Ort als eine Hausnummer in einem ähnlich geschriebenen', () => {
    expect(first('Konrad-Adenauer-Str. 1 Bonn')).toMatchObject({ type: 'street', city: 'Bonn' });
  });

  it('versteht "a.M." und ähnliche Abkürzungen', () => {
    expect(first('Zeil 106 Frankfurt a.M.')).toMatchObject({ housenumber: '106' });
  });

  it('findet "Schlosstr" als Schloßstraße', () => {
    expect(first('Schlosstr 1 Berlin')).toMatchObject({ street: 'Schloßstraße' });
  });

  it('findet eine Hausnummer ohne Leerzeichen hinter der Straße', () => {
    expect(first('schloßstraße1 berlin')).toMatchObject({ street: 'Schloßstraße' });
  });

  it('findet "12a", wenn OSM "12 a" schreibt, und umgekehrt', () => {
    expect(first('Musterweg 12a')).toMatchObject({ housenumber: '12 a' });
    expect(first('Musterweg 12 a')).toMatchObject({ housenumber: '12 a' });
  });

  it('findet Adressen ohne Straße über addr:place', () => {
    expect(first('Wäldele 16 Riezlern')).toMatchObject({ street: 'Wäldele', postcode: '87567' });
  });

  it('setzt "St." und "Sankt" gleich', () => {
    expect(first('St. Augustin')).toMatchObject({ type: 'town', name: 'Sankt Augustin' });
    expect(search('Sankt Augustin').map((r) => r.name)).toContain('St. Augustin');
  });
});

describe('Aufbau des Suchindex in Blöcken', () => {
  it('nimmt alle Zeilen auf, auch über Blockgrenzen hinweg', async () => {
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
        // Jede Zeile ist über FTS und über den R*Tree auffindbar
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
