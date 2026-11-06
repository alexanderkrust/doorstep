import { copyFile, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importFromGeoJsonSeq, INDEX_FILE } from '../../src/import/pipeline.js';
import {
  buildTestServer,
  createFixtureIndex,
  type FeatureCollection,
  type FixtureIndex,
} from '../helpers/fixture-index.js';

const LARGE = join(import.meta.dirname, '..', 'fixtures', 'duesseldorf.geojsonseq');

/** The API with SEARCH_WORKERS: searches run in worker threads. */
describe('SEARCH_WORKERS', () => {
  let fixture: FixtureIndex;
  let dir: string;
  let app: FastifyInstance;
  let inMain: FastifyInstance;

  beforeAll(async () => {
    fixture = await createFixtureIndex();
    dir = await mkdtemp(join(tmpdir(), 'doorstep-workers-'));
    await copyFile(fixture.path, join(dir, INDEX_FILE));
    app = buildTestServer(dir, { SEARCH_WORKERS: '2', CACHE_SIZE: '0' });
    inMain = buildTestServer(fixture.dir, { CACHE_SIZE: '0' });
  });

  afterAll(async () => {
    await app.close();
    await inMain.close();
    await fixture.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  const get = (server: FastifyInstance, url: string) => server.inject({ method: 'GET', url });

  it('answers /api and /reverse like the search in the main thread', async () => {
    for (const url of [
      '/api?q=K%C3%B6nigsall',
      '/api?q=K%C3%B6nigsallee&lat=51.2195&lon=6.7805&types=street,address',
      '/reverse?lat=51.2235&lon=6.7795&limit=3',
    ]) {
      const [a, b] = await Promise.all([get(app, url), get(inMain, url)]);
      expect(a.statusCode).toBe(200);
      expect(a.json()).toEqual(b.json());
      expect(a.headers['server-timing']).toMatch(/^search;dur=/);
    }
  });

  it('answers 503 without an index', async () => {
    const empty = buildTestServer(join(dir, 'nothing-here'), { SEARCH_WORKERS: '1' });
    try {
      expect((await get(empty, '/api?q=K%C3%B6nigsall')).statusCode).toBe(503);
    } finally {
      await empty.close();
    }
  });

  it('serves the new index after a swap, without failed requests', async () => {
    const next = join(dir, 'index.next.sqlite');
    await importFromGeoJsonSeq(LARGE, next);
    const requests = Array.from({ length: 40 }, () => get(app, '/api?q=K%C3%B6nigsall'));
    await rename(next, join(dir, INDEX_FILE));
    expect(app.reloadIndex()).toBe(true);
    const during = await Promise.all(requests);
    expect(during.every((r) => r.statusCode === 200)).toBe(true);

    // The Düsseldorf index knows the Rheinturm; the Königsallee excerpt does not.
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (let i = 0; i < 4; i++) {
      const res = await get(app, '/api?q=Rheinturm');
      expect(res.json<FeatureCollection>().features[0]?.properties['name']).toBe('Rheinturm');
    }
  });
});
