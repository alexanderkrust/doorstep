import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildTestServer,
  createFixtureIndex,
  type FixtureIndex,
} from '../helpers/fixture-index.js';

let fixture: FixtureIndex;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  fixture = await createFixtureIndex();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

afterAll(async () => {
  await fixture.cleanup();
});

describe('CACHE_MAX_AGE', () => {
  const cacheControl = async (env: NodeJS.ProcessEnv, url: string) => {
    app = buildTestServer(fixture.dir, env);
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    return res.headers['cache-control'];
  };

  it('defaults to an hour', async () => {
    expect(await cacheControl({}, '/api?q=K%C3%B6nigsall')).toBe('public, max-age=3600');
  });

  it('sets max-age for /api and /reverse', async () => {
    const env = { CACHE_MAX_AGE: '300' };
    expect(await cacheControl(env, '/api?q=K%C3%B6nigsall')).toBe('public, max-age=300');
    await app?.close();
    expect(await cacheControl(env, '/reverse?lat=51.2235&lon=6.7795')).toBe('public, max-age=300');
  });

  it('forbids caching with 0, also for answers from the server cache', async () => {
    const env = { CACHE_MAX_AGE: '0' };
    expect(await cacheControl(env, '/api?q=K%C3%B6nigsall')).toBe('no-store');
    const again = await app?.inject({ method: 'GET', url: '/api?q=K%C3%B6nigsall' });
    expect(again?.headers['x-cache']).toBe('HIT');
    expect(again?.headers['cache-control']).toBe('no-store');
  });
});

describe('METRICS_TOKEN', () => {
  const TOKEN = 'metrics-token-for-tests';
  const metrics = async (env: NodeJS.ProcessEnv, headers: Record<string, string> = {}) => {
    app = buildTestServer(fixture.dir, env);
    return app.inject({ method: 'GET', url: '/metrics', headers });
  };

  it('leaves /metrics open without METRICS_TOKEN', async () => {
    expect((await metrics({})).statusCode).toBe(200);
  });

  it('answers 401 without or with a wrong token', async () => {
    const missing = await metrics({ METRICS_TOKEN: TOKEN });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');
    expect(missing.headers['cache-control']).toBe('no-store');
    await app?.close();
    const wrong = await metrics({ METRICS_TOKEN: TOKEN }, { authorization: 'Bearer falsch' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).not.toContain('doorstep_');
  });

  it('answers 200 with the token as a bearer token', async () => {
    const res = await metrics({ METRICS_TOKEN: TOKEN }, { authorization: `Bearer ${TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('doorstep_index_available 1');
  });

  it('does not protect /health', async () => {
    app = buildTestServer(fixture.dir, { METRICS_TOKEN: TOKEN });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});
