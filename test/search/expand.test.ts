import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SearchIndex } from '../../src/search/search-index.js';
import { createFixtureIndex, type FixtureIndex } from '../helpers/fixture-index.js';

/** Düsseldorf, wie im Benchmark. */
const HERE = { lat: 51.2254, lon: 6.7763 };

let fixture: FixtureIndex;
let plain: SearchIndex;
let expanded: SearchIndex;

beforeAll(async () => {
  fixture = await createFixtureIndex();
  plain = new SearchIndex(fixture.path);
  // Jedes Präfix über 4 Zeichen mit Treffern wird zerlegt.
  expanded = new SearchIndex(fixture.path, { expandPrefixDocs: 0 });
});

afterAll(async () => {
  plain.close();
  expanded.close();
  await fixture.cleanup();
});

describe('Zerlegung langer Präfixe', () => {
  it.each([
    'Königsall',
    'Königsallee',
    'Königsallee 6',
    'Düsseld',
    'Schadowstr',
    'Graf-Adolf-Str',
    'Kasernenstr 1',
    'Königsalleh',
  ])('liefert dieselben Treffer wie das Präfix: %s', (q) => {
    for (const location of [{}, HERE]) {
      const options = { q, limit: 10, ...location };
      const expected = plain.search(options);
      expect(expected?.length).toBeGreaterThan(0);
      expect(expanded.search(options)).toEqual(expected);
    }
  });
});
