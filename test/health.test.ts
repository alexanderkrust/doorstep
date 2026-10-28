import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { loadConfig } from '../src/config/index.js';

describe('GET /health', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('antwortet mit 200 und Status', async () => {
    app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }));
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      status: 'ok',
      version: expect.any(String) as unknown,
      attribution: '© OpenStreetMap contributors',
    });
    expect(typeof body['uptime']).toBe('number');
  });

  it('antwortet auch über einen echten Port', async () => {
    app = buildServer(loadConfig({ LOG_LEVEL: 'silent', HOST: '127.0.0.1', PORT: '2322' }));
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const res = await fetch(`${address}/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  it('liefert 404 für unbekannte Routen', async () => {
    app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }));
    const res = await app.inject({ method: 'GET', url: '/gibt-es-nicht' });
    expect(res.statusCode).toBe(404);
  });
});
