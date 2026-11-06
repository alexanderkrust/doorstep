import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { securityWarnings } from '../../src/api/startup.js';
import { MAX_QUERY_LENGTH } from '../../src/api/params.js';
import { loadConfig } from '../../src/config/index.js';
import {
  buildTestServer,
  createFixtureIndex,
  type FixtureIndex,
} from '../helpers/fixture-index.js';

const KEY = 'key-for-tests-0123456789';
const SEARCH = '/api?q=K%C3%B6nigsall';
const REVERSE = '/reverse?lat=51.2235&lon=6.7795';

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

function get(url: string, headers: Record<string, string> = {}) {
  if (!app) throw new Error('Server missing');
  return app.inject({ method: 'GET', url, headers });
}

describe('REQUIRE_API_KEY', () => {
  const required = { API_KEYS: `other-key, ${KEY}`, REQUIRE_API_KEY: 'true' };

  it('answers 401 without a key or with an unknown one', async () => {
    app = buildTestServer(fixture.dir, required);
    for (const res of [
      await get(SEARCH),
      await get(SEARCH, { 'x-api-key': 'wrong' }),
      await get(REVERSE),
    ]) {
      expect(res.statusCode).toBe(401);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['www-authenticate']).toBe('ApiKey');
      expect(res.json()).toMatchObject({ statusCode: 401, error: 'Unauthorized' });
    }
  });

  it('answers with a valid key in the header or the query', async () => {
    app = buildTestServer(fixture.dir, required);
    expect((await get(SEARCH, { 'x-api-key': KEY })).statusCode).toBe(200);
    expect((await get(`${REVERSE}&api_key=${KEY}`)).statusCode).toBe(200);
  });

  it('ignores the query parameter with API_KEY_IN_QUERY=false', async () => {
    app = buildTestServer(fixture.dir, { ...required, API_KEY_IN_QUERY: 'false' });
    expect((await get(`${SEARCH}&api_key=${KEY}`)).statusCode).toBe(401);
    expect((await get(SEARCH, { 'x-api-key': KEY })).statusCode).toBe(200);
  });

  it('marks answers as private, so shared caches do not hand them to clients without a key', async () => {
    app = buildTestServer(fixture.dir, required);
    const res = await get(SEARCH, { 'x-api-key': KEY });
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
    // Also for answers from the server's own cache.
    const again = await get(SEARCH, { 'x-api-key': KEY });
    expect(again.headers['x-cache']).toBe('HIT');
    expect(again.headers['cache-control']).toBe('private, max-age=3600');
  });

  it('leaves /health, /metrics and CORS preflights open', async () => {
    app = buildTestServer(fixture.dir, required);
    expect((await get('/health')).statusCode).toBe(200);
    expect((await get('/metrics')).statusCode).toBe(200);
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api',
      headers: { origin: 'https://www.example.com', 'access-control-request-method': 'GET' },
    });
    expect(preflight.statusCode).toBe(204);
  });

  it('also works with rate limiting turned off', async () => {
    app = buildTestServer(fixture.dir, { ...required, RATE_LIMIT_ENABLED: 'false' });
    expect((await get(SEARCH)).statusCode).toBe(401);
  });

  it('keeps counting requests without a key against the rate limit of their IP', async () => {
    app = buildTestServer(fixture.dir, {
      ...required,
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT: '2',
    });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await get(SEARCH)).statusCode);
    expect(codes).toEqual([401, 401, 429]);
  });

  it('leaves the API open without REQUIRE_API_KEY, also with API_KEYS', async () => {
    app = buildTestServer(fixture.dir, { API_KEYS: KEY });
    const res = await get(SEARCH);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
  });
});

describe('query length', () => {
  it(`rejects q longer than ${String(MAX_QUERY_LENGTH)} characters`, async () => {
    app = buildTestServer(fixture.dir);
    const ok = await get(`/api?q=${encodeURIComponent('a'.repeat(MAX_QUERY_LENGTH))}`);
    expect(ok.statusCode).toBe(200);
    const res = await get(`/api?q=${encodeURIComponent('a'.repeat(MAX_QUERY_LENGTH + 1))}`);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      message: `q: must be at most ${String(MAX_QUERY_LENGTH)} characters long`,
    });
  });
});

describe('securityWarnings', () => {
  it('warns about an open /metrics, rate limiting turned off and CORS for all origins', () => {
    const warnings = securityWarnings(loadConfig({ RATE_LIMIT_ENABLED: 'false' }));
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/METRICS_TOKEN/);
    expect(warnings[1]).toMatch(/rate limiting is off/i);
    expect(warnings[2]).toMatch(/CORS_ORIGINS/);
  });

  it('warns about RATE_LIMIT=0 like about RATE_LIMIT_ENABLED=false', () => {
    expect(securityWarnings(loadConfig({ RATE_LIMIT: '0' })).join('\n')).toMatch(
      /rate limiting is off/i,
    );
  });

  it('has nothing to say about a locked-down configuration', () => {
    const config = loadConfig({
      METRICS_TOKEN: 'metrics-token-for-tests',
      CORS_ORIGINS: 'https://www.example.com',
    });
    expect(securityWarnings(config)).toEqual([]);
  });
});
