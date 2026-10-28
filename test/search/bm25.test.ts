import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IndexWriter } from '../../src/import/index-writer.js';
import { importanceFor, type Place } from '../../src/import/place.js';
import { bm25, ftsColumns, idf } from '../../src/search/bm25.js';
import { buildFtsQuery, inTextColumns, phrasesFor } from '../../src/search/query.js';
import { TermStats } from '../../src/search/term-stats.js';

function place(overrides: Partial<Place> & Pick<Place, 'osmId' | 'type'>): Place {
  return {
    osmType: 'N',
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
    lat: 51.2,
    lon: 6.8,
    importance: importanceFor(overrides.type),
    ...overrides,
  };
}

const PLACES: Place[] = [
  place({ osmId: 1, type: 'street', name: 'Breite Straße', city: 'Düsseldorf' }),
  place({
    osmId: 2,
    type: 'house',
    street: 'Breite Straße',
    housenumber: '12 a',
    postcode: '40213',
    city: 'Düsseldorf',
    district: 'Carlstadt',
  }),
  place({ osmId: 3, type: 'street', name: 'Kölner Straße', city: 'Köln', lat: 50.9, lon: 6.9 }),
  place({ osmId: 4, type: 'village', name: 'Breitenbach', nameDe: 'Breitenbach am Herzberg' }),
  place({
    osmId: 5,
    type: 'cafe',
    name: 'Café Breite',
    street: 'Breite Straße',
    housenumber: '3',
    city: 'Düsseldorf',
  }),
  place({ osmId: 6, type: 'house', street: 'Hauptstraße', housenumber: '1', postcode: '10115' }),
];

let dir: string;
let db: DatabaseSync;
let stats: TermStats;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doorstep-bm25-'));
  const path = join(dir, 'index.sqlite');
  const writer = new IndexWriter(path);
  for (const p of PLACES) writer.add(p);
  writer.finish({});
  db = new DatabaseSync(path, { readOnly: true });
  stats = TermStats.open(db);
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

interface Row {
  id: number;
  bm25: number;
  name: string | null;
  name_de: string | null;
  name_en: string | null;
  street: string | null;
  housenumber: string | null;
  postcode: string | null;
  city: string | null;
  district: string | null;
}

describe('TermStats', () => {
  it('kennt Zeilen, Wörter und Dokumentzahlen aus dem Import', () => {
    expect(stats.rows).toBe(PLACES.length);
    expect(stats.avgTokens).toBeGreaterThan(1);
    expect(stats.docs('breite')).toBe(3);
    expect(stats.docs('unbekannt')).toBe(0);
    // Präfixe bis 4 Zeichen aus der vorberechneten Tabelle, längere aus den Wörtern.
    expect(stats.prefixDocs('brei')).toBe(4);
    expect(stats.prefixDocs('breite')).toBe(4);
    expect(stats.completions('breite').map((c) => c.term)).toEqual(['breite', 'breitenbach']);
  });

  it('enthält keine Rasterzellen', () => {
    expect(stats.prefixDocs('g')).toBe(0);
  });
});

describe('bm25 in JS', () => {
  // Fälle ohne Überschneidung der Wörter eines Präfixes: Dort zählt FTS5 genau dieselben Dokumente.
  it.each([
    [['breite', 'strasse']],
    [['breite']],
    [['koelner', 'strasse']],
    [['duesseldorf']],
    [['cafe', 'breite']],
    [['breite', 'strasse', '12a']],
  ])('entspricht bm25() aus FTS5 für %j', (tokens) => {
    const match = inTextColumns(buildFtsQuery(tokens) ?? '');
    const rows = db
      .prepare(
        `SELECT p.*, bm25(places_fts, 4.0, 2.0, 1.0, 1.0, 1.0, 0.0) AS bm25
           FROM places_fts JOIN places p ON p.id = places_fts.rowid
          WHERE places_fts MATCH ?`,
      )
      .all(match) as unknown as Row[];
    expect(rows.length).toBeGreaterThan(0);
    const phrases = phrasesFor(tokens);
    const idfs = phrases.map((p) =>
      idf(stats.rows, p.prefix ? stats.prefixDocs(p.token) : stats.docs(p.token)),
    );
    for (const row of rows) {
      expect(bm25(phrases, idfs, ftsColumns(row), stats.avgTokens)).toBeCloseTo(row.bm25, 9);
    }
  });

  it('bewertet seltene Wörter höher als häufige', () => {
    expect(idf(1000, 1)).toBeGreaterThan(idf(1000, 100));
    expect(idf(1000, 900)).toBeGreaterThan(0);
  });

  it('liefert 0 ohne Treffer in der Zeile', () => {
    const columns = ftsColumns({
      name: 'Foo',
      name_de: null,
      name_en: null,
      street: null,
      housenumber: null,
      postcode: null,
      city: null,
      district: null,
    });
    expect(bm25(phrasesFor(['bar']), [1], columns, 3)).toBe(0);
  });
});
