import { copyFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { importFromGeoJsonSeq } from '../../src/import/pipeline.js';
import { SearchPool } from '../../src/search/search-pool.js';
import { IndexUnavailableError, SearchIndex } from '../../src/search/search-index.js';
import { createFixtureIndex, type FixtureIndex } from '../helpers/fixture-index.js';

let fixture: FixtureIndex;
let dir: string;
let pool: SearchPool | undefined;

beforeAll(async () => {
  fixture = await createFixtureIndex();
  dir = await mkdtemp(join(tmpdir(), 'doorstep-pool-'));
});

afterEach(async () => {
  await pool?.close();
  pool = undefined;
});

afterAll(async () => {
  await fixture.cleanup();
  await rm(dir, { recursive: true, force: true });
});

describe('SearchPool', () => {
  it('returns the same hits as the search in the main thread', async () => {
    pool = new SearchPool(fixture.path, 2);
    const local = new SearchIndex(fixture.path);
    try {
      for (const options of [
        { q: 'Königsall', limit: 5 },
        { q: 'Königsallee 60', limit: 5 },
        { q: 'Königsallee', limit: 5, lat: 51.2195, lon: 6.7805 },
        { q: 'Königsallee', limit: 10, types: ['address' as const] },
      ]) {
        expect(await pool.search(options)).toEqual(local.search(options));
      }
      const reverse = { lat: 51.2235, lon: 6.7795, limit: 3, radiusKm: 1 };
      expect(await pool.reverse(reverse)).toEqual(local.reverse(reverse));
    } finally {
      local.close();
    }
  });

  it('answers many requests at the same time', async () => {
    const busy = new SearchPool(fixture.path, 3);
    pool = busy;
    const queries = Array.from({ length: 60 }, (_, i) => ['Kö', 'Königsallee', 'Kasernen'][i % 3]);
    const results = await Promise.all(queries.map((q) => busy.search({ q: q ?? '', limit: 3 })));
    expect(results.every((r) => Array.isArray(r))).toBe(true);
    expect(results[1]?.[0]).toMatchObject({ name: 'Königsallee' });
  });

  it('returns null without an index file', async () => {
    pool = new SearchPool(join(dir, 'missing.sqlite'), 1);
    expect(await pool.search({ q: 'Kö', limit: 3 })).toBeNull();
  });

  it('passes on an unusable index as IndexUnavailableError', async () => {
    const old = join(dir, 'old.sqlite');
    await copyFile(fixture.path, old);
    const db = new DatabaseSync(old);
    db.exec(`UPDATE meta SET value = '6' WHERE key = 'schema_version'`);
    db.close();
    pool = new SearchPool(old, 1);
    const error = await pool.search({ q: 'Kö', limit: 3 }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(IndexUnavailableError);
    expect((error as IndexUnavailableError).foundSchemaVersion).toBe(6);
  });

  it('switches every worker to a swapped index on reload', async () => {
    const path = join(dir, 'swap.sqlite');
    await copyFile(fixture.path, path);
    const swapping = new SearchPool(path, 2);
    pool = swapping;
    // Open the index in both workers.
    await Promise.all([1, 2, 3, 4].map(() => swapping.search({ q: 'Kö', limit: 1 })));

    const input = join(dir, 'testweg.geojsonseq');
    await writeFile(
      input,
      JSON.stringify({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [6.78, 51.22],
            [6.781, 51.22],
          ],
        },
        properties: { '@type': 'way', '@id': 1, highway: 'residential', name: 'Testweg' },
      }),
    );
    const next = join(dir, 'swap.next.sqlite');
    await importFromGeoJsonSeq(input, next);
    await rename(next, path);

    expect(await pool.reload()).toBe(true);
    for (let i = 0; i < 4; i++) {
      expect(await pool.search({ q: 'Testweg', limit: 1 })).toMatchObject([{ name: 'Testweg' }]);
    }
    expect(await pool.reload()).toBe(false);
  });

  it('refuses requests after close', async () => {
    const closed = new SearchPool(fixture.path, 1);
    await closed.close();
    await expect(closed.search({ q: 'Kö', limit: 1 })).rejects.toThrow(/closed/);
  });
});
