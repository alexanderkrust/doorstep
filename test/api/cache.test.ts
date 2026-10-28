import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { importFromGeoJsonSeq } from '../../src/import/pipeline.js';
import {
  buildTestServer,
  createFixtureIndex,
  type FeatureCollection,
  type FixtureIndex,
} from '../helpers/fixture-index.js';
import { join } from 'node:path';

const LARGE = join(import.meta.dirname, '..', 'fixtures', 'duesseldorf.geojsonseq');

let fixture: FixtureIndex;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  fixture = await createFixtureIndex();
});

afterAll(async () => {
  await fixture.cleanup();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const get = (url: string) => {
  if (!app) throw new Error('Server fehlt');
  return app.inject({ method: 'GET', url });
};

describe('Cache für kurze Prefix-Queries', () => {
  it('beantwortet eine wiederholte kurze Anfrage aus dem Cache mit identischem Ergebnis', async () => {
    app = buildTestServer(fixture.dir);
    const first = await get('/api?q=K%C3%B6nigs');
    const second = await get('/api?q=K%C3%B6nigs');

    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(second.headers['cache-control']).toBe(first.headers['cache-control']);
  });

  it('teilt den Eintrag zwischen Schreibweisen mit gleicher Normalisierung', async () => {
    app = buildTestServer(fixture.dir);
    await get('/api?q=K%C3%B6nigs');
    expect((await get('/api?q=%20k%C3%B6NIGS%20')).headers['x-cache']).toBe('HIT');
  });

  it('unterscheidet limit, lang und Standort', async () => {
    app = buildTestServer(fixture.dir);
    await get('/api?q=Kö'.replace('ö', '%C3%B6'));
    expect((await get('/api?q=K%C3%B6&limit=2')).headers['x-cache']).toBe('MISS');
    expect((await get('/api?q=K%C3%B6&lang=en')).headers['x-cache']).toBe('MISS');
    expect((await get('/api?q=K%C3%B6&lat=51.2&lon=6.8')).headers['x-cache']).toBe('MISS');
    expect((await get('/api?q=K%C3%B6&lat=51.2&lon=6.8')).headers['x-cache']).toBe('HIT');
  });

  it('umgeht den Cache bei langen Anfragen', async () => {
    app = buildTestServer(fixture.dir);
    const url = `/api?q=${encodeURIComponent('Königsallee 60d Düsseldorf')}`;
    await get(url);
    expect((await get(url)).headers['x-cache']).toBe('BYPASS');
  });

  it('cacht keine Fehler', async () => {
    app = buildTestServer('/gibt/es/nicht');
    expect((await get('/api?q=ab')).statusCode).toBe(503);
    const again = await get('/api?q=ab');
    expect(again.statusCode).toBe(503);
    expect(again.headers['x-cache']).not.toBe('HIT');
  });

  it('ist mit CACHE_SIZE=0 aus', async () => {
    app = buildTestServer(fixture.dir, { CACHE_SIZE: '0' });
    await get('/api?q=K%C3%B6nigs');
    expect((await get('/api?q=K%C3%B6nigs')).headers['x-cache']).toBeUndefined();
  });

  it('wird beim Neuladen des Index geleert', async () => {
    const { dir, path, cleanup } = await createFixtureIndex();
    try {
      app = buildTestServer(dir);
      const before = (await get('/api?q=Oberbilk')).json<FeatureCollection>();
      expect(before.features.map((f) => f.properties['name'])).not.toContain('Oberbilker Allee');

      await importFromGeoJsonSeq(LARGE, path);
      expect(app.reloadIndex()).toBe(true);

      const after = await get('/api?q=Oberbilk');
      expect(after.headers['x-cache']).toBe('MISS');
      const names = after.json<FeatureCollection>().features.map((f) => f.properties['name']);
      expect(names).toContain('Oberbilker Allee');
    } finally {
      await cleanup();
    }
  });
});
