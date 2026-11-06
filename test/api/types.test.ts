import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkIndexAtStart } from '../../src/api/startup.js';
import { loadConfig } from '../../src/config/index.js';
import { INDEX_FILE } from '../../src/import/pipeline.js';
import {
  buildTestServer,
  createFixtureIndex,
  type FeatureCollection,
  type FixtureIndex,
} from '../helpers/fixture-index.js';

/** Result types the client asks for with `types=` (Königsallee test index). */
describe('types parameter', () => {
  let fixture: FixtureIndex;
  let app: FastifyInstance;

  beforeAll(async () => {
    fixture = await createFixtureIndex();
    app = buildTestServer(fixture.dir);
  });

  afterAll(async () => {
    await app.close();
    await fixture.cleanup();
  });

  const get = async (url: string) => {
    const res = await app.inject({ method: 'GET', url });
    return { res, body: res.json<FeatureCollection>() };
  };
  const typesOf = (body: FeatureCollection) => body.features.map((f) => f.properties['type']);

  it('returns all kinds of hits without types', async () => {
    const { body } = await get('/api?q=K%C3%B6nigsallee&limit=10');
    expect(new Set(typesOf(body)).size).toBeGreaterThan(1);
  });

  it('returns only streets with types=street', async () => {
    const { res, body } = await get('/api?q=K%C3%B6nigsallee&limit=10&types=street');
    expect(res.statusCode).toBe(200);
    expect(body.features.length).toBeGreaterThan(0);
    expect(new Set(typesOf(body))).toEqual(new Set(['street']));
  });

  it('finds addresses even though more important hits come first', async () => {
    const { body } = await get('/api?q=K%C3%B6nigsallee&limit=10&types=address');
    expect(body.features).toHaveLength(10);
    expect(new Set(typesOf(body))).toEqual(new Set(['address']));
  });

  it('takes several types, also with a location', async () => {
    const { body } = await get(
      '/api?q=K%C3%B6nigsallee&limit=10&types=street,address&lat=51.2235&lon=6.7795',
    );
    expect(body.features.length).toBeGreaterThan(0);
    for (const type of typesOf(body)) expect(['street', 'address']).toContain(type);
  });

  it('keeps the cache apart per types', async () => {
    const streets = await get('/api?q=K%C3%B6nigsallee&types=street');
    const addresses = await get('/api?q=K%C3%B6nigsallee&types=address');
    expect(typesOf(streets.body)).not.toEqual(typesOf(addresses.body));
  });

  it.each(['streets', 'street,house', ''])('rejects types=%j with 400', async (types) => {
    const { res } = await get(`/api?q=K%C3%B6nigsallee&types=${types}`);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/types: .*address, street, poi, locality, sublocality, place/);
  });

  it('filters /reverse by type', async () => {
    const { res, body } = await get('/reverse?lat=51.2235&lon=6.7795&limit=5&types=street');
    expect(res.statusCode).toBe(200);
    expect(body.features.length).toBeGreaterThan(0);
    expect(new Set(typesOf(body))).toEqual(new Set(['street']));
  });

  it('reports the indexed types in /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({
      types: ['address', 'street', 'poi', 'locality', 'sublocality', 'place'],
    });
  });
});

describe('INDEX_TYPES at startup', () => {
  let fixture: FixtureIndex;
  let dir: string;

  beforeAll(async () => {
    fixture = await createFixtureIndex();
    dir = await mkdtemp(join(tmpdir(), 'doorstep-types-start-'));
    await copyFile(fixture.path, join(dir, INDEX_FILE));
    const db = new DatabaseSync(join(dir, INDEX_FILE));
    db.exec(`UPDATE meta SET value = 'street' WHERE key = 'types'`);
    db.close();
  });

  afterAll(async () => {
    await fixture.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it('warns when the index holds other types than INDEX_TYPES', () => {
    const result = checkIndexAtStart(loadConfig({ DATA_DIR: dir, INDEX_TYPES: 'street,poi' }));
    expect(result).toMatchObject({ level: 'warn', exit: false });
    expect(result.message).toMatch(/street.*street, poi.*import/);
  });

  it('is content when the types match', () => {
    const result = checkIndexAtStart(loadConfig({ DATA_DIR: dir, INDEX_TYPES: 'street' }));
    expect(result).toMatchObject({ level: 'info', exit: false });
  });

  it('does not compare in mounted mode, where the index decides', () => {
    const config = loadConfig({ DATA_DIR: dir, INDEX_MODE: 'mounted', INDEX_TYPES: 'poi' });
    expect(checkIndexAtStart(config)).toMatchObject({ level: 'info', exit: false });
  });
});
