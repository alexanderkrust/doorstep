import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SearchIndex } from '../../src/search/search-index.js';
import { createFixtureIndex, type FixtureIndex } from '../helpers/fixture-index.js';

/** Düsseldorf, as in the benchmark. */
const HERE = { lat: 51.2254, lon: 6.7763 };

let fixture: FixtureIndex;
let plain: SearchIndex;
let expanded: SearchIndex;

beforeAll(async () => {
  fixture = await createFixtureIndex();
  plain = new SearchIndex(fixture.path);
  // Every prefix over 4 characters with hits is expanded.
  expanded = new SearchIndex(fixture.path, { expandPrefixDocs: 0 });
});

afterAll(async () => {
  plain.close();
  expanded.close();
  await fixture.cleanup();
});

describe('expansion of long prefixes', () => {
  it.each([
    'Königsall',
    'Königsallee',
    'Königsallee 6',
    'Düsseld',
    'Schadowstr',
    'Graf-Adolf-Str',
    'Kasernenstr 1',
    'Königsalleh',
  ])('returns the same hits as the prefix: %s', (q) => {
    for (const location of [{}, HERE]) {
      const options = { q, limit: 10, ...location };
      const expected = plain.search(options);
      expect(expected?.length).toBeGreaterThan(0);
      expect(expanded.search(options)).toEqual(expected);
    }
  });
});
