import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IndexWriter } from '../../src/import/index-writer.js';
import { featureToPlace, type Feature } from '../../src/import/place.js';

let nextId = 1;
const node = (lat: number, lon: number, tags: Record<string, string>): Feature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { '@type': 'node', '@id': nextId++, ...tags },
});
const street = (lat: number, lon: number, name: string): Feature => ({
  type: 'Feature',
  geometry: {
    type: 'LineString',
    coordinates: [
      [lon, lat],
      [lon + 0.001, lat],
    ],
  },
  properties: { '@type': 'way', '@id': nextId++, highway: 'residential', name },
});

const FEATURES = [
  node(51.22, 6.78, { place: 'city', name: 'Düsseldorf' }),
  node(51.2, 6.79, { place: 'suburb', name: 'Bilk' }),
  street(51.2181, 6.7802, 'Lindenstraße'),
  street(51.3181, 6.8802, 'Ahornweg'),
  node(51.2182, 6.7803, {
    'addr:street': 'Lindenstraße',
    'addr:housenumber': '1',
    'addr:postcode': '40233',
    'addr:city': 'Düsseldorf',
  }),
  node(51.2183, 6.7804, {
    'addr:street': 'Lindenstraße',
    'addr:housenumber': '2',
    'addr:postcode': '40233',
    'addr:city': 'Düsseldorf',
  }),
  node(51.2184, 6.7805, { amenity: 'cafe', name: 'Café Linde' }),
];

interface Row {
  id: number;
  type: string;
  name: string | null;
  city: string | null;
  postcode: string | null;
}

describe('IndexWriter with indexTypes', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'doorstep-types-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function build(name: string, indexTypes?: ('street' | 'poi' | 'address' | 'locality')[]) {
    const path = join(dir, `${name}.sqlite`);
    const writer = new IndexWriter(path, indexTypes ? { indexTypes } : {});
    for (const feature of FEATURES) {
      const place = featureToPlace(feature);
      if (place) writer.add(place);
    }
    const count = writer.finish({});
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare('SELECT id, type, name, city, postcode FROM places ORDER BY id').all();
    const meta = Object.fromEntries(
      (db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map(
        (r) => [r.key, r.value],
      ),
    );
    const fts = (db.prepare('SELECT count(*) AS n FROM places_fts').get() as { n: number }).n;
    const rtree = (db.prepare('SELECT count(*) AS n FROM places_rtree').get() as { n: number }).n;
    db.close();
    return { count, rows: rows as unknown as Row[], meta, fts, rtree };
  }

  it('keeps everything by default and records all types', () => {
    const { count, meta } = build('all');
    expect(count).toBe(FEATURES.length);
    expect(meta['types']).toBe('address,street,poi,locality,sublocality,place');
  });

  it('keeps only streets, which still get city and postcode from the addresses', () => {
    const { count, rows, meta, fts, rtree } = build('streets', ['street']);
    expect(rows.map((r) => r.name)).toEqual(['Lindenstraße', 'Ahornweg']);
    expect(rows[0]).toMatchObject({ city: 'Düsseldorf', postcode: '40233' });
    expect(count).toBe(2);
    expect(meta['places']).toBe('2');
    expect(meta['types']).toBe('street');
    expect(fts).toBe(2);
    expect(rtree).toBe(2);
  });

  it('numbers the remaining rows without gaps, in the order of importance', () => {
    const { rows } = build('mixed', ['address', 'locality']);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.type)).toEqual(['city', 'house', 'house']);
  });

  it('counts the words of the remaining rows only', () => {
    const path = join(dir, 'streets.sqlite');
    const db = new DatabaseSync(path, { readOnly: true });
    const docs = (term: string) =>
      (
        db.prepare('SELECT docs FROM terms WHERE term = ?').get(term) as
          { docs?: number } | undefined
      )?.docs ?? 0;
    expect(docs('lindenstrasse')).toBe(1);
    expect(docs('cafe')).toBe(0);
    expect(docs('kindstreet')).toBe(0);
    db.close();
  });
});
