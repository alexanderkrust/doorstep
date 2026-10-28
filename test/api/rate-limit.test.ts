import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestServer as buildServer } from '../helpers/fixture-index.js';

// Ohne Index antwortet /api mit 503 – für das Zählen reicht das.
const NO_INDEX = '/gibt/es/nicht';

let app: FastifyInstance | undefined;

/** Wie im Betrieb: Rate-Limiting an, sofern `env` nichts anderes sagt. */
const buildTestServer = (dataDir: string, env: NodeJS.ProcessEnv) =>
  buildServer(dataDir, { RATE_LIMIT_ENABLED: 'true', ...env });

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function get(url: string, options: { ip?: string; headers?: Record<string, string> } = {}) {
  if (!app) throw new Error('Server fehlt');
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

describe('Rate-Limiting', () => {
  it('begrenzt Anfragen pro IP und meldet 429 mit Retry-After', async () => {
    app = buildTestServer(NO_INDEX, { RATE_LIMIT: '3' });

    expect(await statuses(3, '/api?q=ab')).toEqual([503, 503, 503]);
    const blocked = await get('/api?q=ab');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['cache-control']).toBe('no-store');
    expect(blocked.json()).toMatchObject({ statusCode: 429, error: 'Too Many Requests' });

    // Eine andere IP hat ihr eigenes Kontingent.
    expect((await get('/api?q=ab', { ip: '10.0.0.2' })).statusCode).toBe(503);
  });

  it('setzt die üblichen RateLimit-Header', async () => {
    app = buildTestServer(NO_INDEX, { RATE_LIMIT: '5' });
    const res = await get('/api?q=ab');
    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBe('4');
  });

  it('gilt auch für /reverse', async () => {
    app = buildTestServer(NO_INDEX, { RATE_LIMIT: '1' });
    expect(await statuses(2, '/reverse?lat=51&lon=6')).toEqual([503, 429]);
  });

  it('zählt /health und /metrics nicht mit', async () => {
    app = buildTestServer(NO_INDEX, { RATE_LIMIT: '1' });
    expect(await statuses(3, '/health')).toEqual([200, 200, 200]);
    expect(await statuses(3, '/metrics')).toEqual([200, 200, 200]);
    expect((await get('/api?q=ab')).statusCode).toBe(503);
  });

  it('lässt sich mit RATE_LIMIT_ENABLED=false abschalten', async () => {
    app = buildTestServer(NO_INDEX, { RATE_LIMIT: '1', RATE_LIMIT_ENABLED: 'false' });
    expect(await statuses(5, '/api?q=ab')).toEqual([503, 503, 503, 503, 503]);
    expect((await get('/api?q=ab')).headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('ist mit RATE_LIMIT=0 ebenfalls aus', async () => {
    app = buildTestServer(NO_INDEX, { RATE_LIMIT: '0' });
    expect(await statuses(5, '/api?q=ab')).toEqual([503, 503, 503, 503, 503]);
  });

  describe('mit API-Key', () => {
    const env = { RATE_LIMIT: '1', API_KEYS: 'geheim1,geheim2', RATE_LIMIT_API_KEY: '3' };

    it('zählt pro Key mit eigenem Limit (Header X-API-Key)', async () => {
      app = buildTestServer(NO_INDEX, env);
      const headers = { 'x-api-key': 'geheim1' };
      expect(await statuses(3, '/api?q=ab', { headers })).toEqual([503, 503, 503]);
      expect((await get('/api?q=ab', { headers })).statusCode).toBe(429);
      expect((await get('/api?q=ab', { headers })).headers['x-ratelimit-limit']).toBe('3');

      // Derselbe Key von einer anderen IP teilt sich das Kontingent.
      expect((await get('/api?q=ab', { headers, ip: '10.9.9.9' })).statusCode).toBe(429);
      // Ein anderer Key hat sein eigenes.
      expect((await get('/api?q=ab', { headers: { 'x-api-key': 'geheim2' } })).statusCode).toBe(
        503,
      );
    });

    it('akzeptiert den Key auch als Query-Parameter api_key', async () => {
      app = buildTestServer(NO_INDEX, env);
      expect(await statuses(3, '/api?q=ab&api_key=geheim1')).toEqual([503, 503, 503]);
      expect((await get('/api?q=ab&api_key=geheim1')).statusCode).toBe(429);
    });

    it('behandelt unbekannte Keys wie Anfragen ohne Key (Limit pro IP)', async () => {
      app = buildTestServer(NO_INDEX, env);
      const headers = { 'x-api-key': 'falsch' };
      expect(await statuses(2, '/api?q=ab', { headers })).toEqual([503, 429]);
    });

    it('verbraucht nicht das Kontingent der IP', async () => {
      app = buildTestServer(NO_INDEX, env);
      await statuses(3, '/api?q=ab', { headers: { 'x-api-key': 'geheim1' } });
      expect((await get('/api?q=ab')).statusCode).toBe(503);
    });
  });

  describe('hinter einem Reverse-Proxy', () => {
    const forwarded = (ip: string) => ({ headers: { 'x-forwarded-for': ip }, ip: '172.17.0.1' });

    it('zählt mit TRUST_PROXY=true die Client-IP aus X-Forwarded-For', async () => {
      app = buildTestServer(NO_INDEX, { RATE_LIMIT: '1', TRUST_PROXY: 'true' });
      expect((await get('/api?q=ab', forwarded('203.0.113.1'))).statusCode).toBe(503);
      expect((await get('/api?q=ab', forwarded('203.0.113.2'))).statusCode).toBe(503);
      expect((await get('/api?q=ab', forwarded('203.0.113.1'))).statusCode).toBe(429);
    });

    it('ignoriert X-Forwarded-For ohne TRUST_PROXY (nicht fälschbar)', async () => {
      app = buildTestServer(NO_INDEX, { RATE_LIMIT: '1' });
      expect((await get('/api?q=ab', forwarded('203.0.113.1'))).statusCode).toBe(503);
      expect((await get('/api?q=ab', forwarded('203.0.113.2'))).statusCode).toBe(429);
    });
  });
});
