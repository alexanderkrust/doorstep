import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestServer as buildServer } from '../helpers/fixture-index.js';

// Without an index, /api answers 503 – good enough for counting.
const NO_INDEX = '/does/not/exist';

let app: FastifyInstance | undefined;

/** As in production: rate limiting on, unless `env` says otherwise. */
const buildTestServer = (dataDir: string, env: NodeJS.ProcessEnv) =>
  buildServer(dataDir, { RATE_LIMIT_ENABLED: 'true', ...env });

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function get(url: string, options: { ip?: string; headers?: Record<string, string> } = {}) {
  if (!app) throw new Error('Server missing');
  return app.inject({
    method: 'GET',
    url,
    remoteAddress: options.ip ?? '10.0.0.1',
    ...(options.headers ? { headers: options.headers } : {}),
  });
}

async function statuses(count: number, url: string, options?: Parameters<typeof get>[1]) {
  const result: number[] = [];
  for (let i = 0; i < count; i++) result.push((await get(url, options)).statusCode);
  return result;
}

describe('rate limiting', () => {
  it('limits requests per IP and answers 429 with Retry-After', async () => {
    app = buildTestServer(NO_INDEX, { RATE_LIMIT: '3' });

    expect(await statuses(3, '/api?q=ab')).toEqual([503, 503, 503]);
    const blocked = await get('/api?q=ab');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['cache-control']).toBe('no-store');
    expect(blocked.json()).toMatchObject({ statusCode: 429, error: 'Too Many Requests' });

    // Another IP has its own quota.
    expect((await get('/api?q=ab', { ip: '10.0.0.2' })).statusCode).toBe(503);
  });

  it('sets the usual RateLimit headers', async () => {
    app = buildTestServer(NO_INDEX, { RATE_LIMIT: '5' });
    const res = await get('/api?q=ab');
    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBe('4');
  });

  it('also applies to /reverse', async () => {
    app = buildTestServer(NO_INDEX, { RATE_LIMIT: '1' });
    expect(await statuses(2, '/reverse?lat=51&lon=6')).toEqual([503, 429]);
  });

  it('does not count /health and /metrics', async () => {
    app = buildTestServer(NO_INDEX, { RATE_LIMIT: '1' });
    expect(await statuses(3, '/health')).toEqual([200, 200, 200]);
    expect(await statuses(3, '/metrics')).toEqual([200, 200, 200]);
    expect((await get('/api?q=ab')).statusCode).toBe(503);
  });

  it('can be turned off with RATE_LIMIT_ENABLED=false', async () => {
    app = buildTestServer(NO_INDEX, { RATE_LIMIT: '1', RATE_LIMIT_ENABLED: 'false' });
    expect(await statuses(5, '/api?q=ab')).toEqual([503, 503, 503, 503, 503]);
    expect((await get('/api?q=ab')).headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('is also off with RATE_LIMIT=0', async () => {
    app = buildTestServer(NO_INDEX, { RATE_LIMIT: '0' });
    expect(await statuses(5, '/api?q=ab')).toEqual([503, 503, 503, 503, 503]);
  });

  describe('with an API key', () => {
    const env = { RATE_LIMIT: '1', API_KEYS: 'geheim1,geheim2', RATE_LIMIT_API_KEY: '3' };

    it('counts per key with its own limit (X-API-Key header)', async () => {
      app = buildTestServer(NO_INDEX, env);
      const headers = { 'x-api-key': 'geheim1' };
      expect(await statuses(3, '/api?q=ab', { headers })).toEqual([503, 503, 503]);
      expect((await get('/api?q=ab', { headers })).statusCode).toBe(429);
      expect((await get('/api?q=ab', { headers })).headers['x-ratelimit-limit']).toBe('3');

      // The same key from another IP shares the quota.
      expect((await get('/api?q=ab', { headers, ip: '10.9.9.9' })).statusCode).toBe(429);
      // Another key has its own.
      expect((await get('/api?q=ab', { headers: { 'x-api-key': 'geheim2' } })).statusCode).toBe(
        503,
      );
    });

    it('also accepts the key as the api_key query parameter', async () => {
      app = buildTestServer(NO_INDEX, env);
      expect(await statuses(3, '/api?q=ab&api_key=geheim1')).toEqual([503, 503, 503]);
      expect((await get('/api?q=ab&api_key=geheim1')).statusCode).toBe(429);
    });

    it('treats unknown keys like requests without a key (limit per IP)', async () => {
      app = buildTestServer(NO_INDEX, env);
      const headers = { 'x-api-key': 'falsch' };
      expect(await statuses(2, '/api?q=ab', { headers })).toEqual([503, 429]);
    });

    it('does not use up the IP quota', async () => {
      app = buildTestServer(NO_INDEX, env);
      await statuses(3, '/api?q=ab', { headers: { 'x-api-key': 'geheim1' } });
      expect((await get('/api?q=ab')).statusCode).toBe(503);
    });
  });

  describe('behind a reverse proxy', () => {
    const forwarded = (ip: string) => ({ headers: { 'x-forwarded-for': ip }, ip: '172.17.0.1' });

    it('counts the client IP from X-Forwarded-For with TRUST_PROXY=true', async () => {
      app = buildTestServer(NO_INDEX, { RATE_LIMIT: '1', TRUST_PROXY: 'true' });
      expect((await get('/api?q=ab', forwarded('203.0.113.1'))).statusCode).toBe(503);
      expect((await get('/api?q=ab', forwarded('203.0.113.2'))).statusCode).toBe(503);
      expect((await get('/api?q=ab', forwarded('203.0.113.1'))).statusCode).toBe(429);
    });

    it('ignores X-Forwarded-For without TRUST_PROXY (cannot be spoofed)', async () => {
      app = buildTestServer(NO_INDEX, { RATE_LIMIT: '1' });
      expect((await get('/api?q=ab', forwarded('203.0.113.1'))).statusCode).toBe(503);
      expect((await get('/api?q=ab', forwarded('203.0.113.2'))).statusCode).toBe(429);
    });
  });
});
