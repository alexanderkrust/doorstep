import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SearchOverloadedError,
  SearchTimeoutError,
  type SearchBackend,
} from '../../src/search/search-pool.js';
import { buildTestServer } from '../helpers/fixture-index.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A search backend whose searches all fail with `error`. */
function failing(error: Error): SearchBackend {
  return {
    search: () => Promise.reject(error),
    reverse: () => Promise.reject(error),
    reload: () => Promise.resolve(false),
    close: () => Promise.resolve(),
  };
}

describe('overloaded or slow searches', () => {
  it.each([
    ['timeout', new SearchTimeoutError(2000)],
    ['overloaded', new SearchOverloadedError()],
  ])('answers 503 with Retry-After and counts it (%s)', async (reason, error) => {
    app = buildTestServer('/does/not/exist', {}, { search: failing(error) });
    for (const url of ['/api?q=K%C3%B6nigsall', '/reverse?lat=51.2&lon=6.7']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('1');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.json()).toMatchObject({ statusCode: 503, error: 'Service Unavailable' });
    }
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain(`doorstep_search_rejected_total{reason="${reason}"} 2`);
  });

  it('does not cache a rejected search', async () => {
    app = buildTestServer('/does/not/exist', {}, { search: failing(new SearchOverloadedError()) });
    await app.inject({ method: 'GET', url: '/api?q=K%C3%B6nigsall' });
    const again = await app.inject({ method: 'GET', url: '/api?q=K%C3%B6nigsall' });
    expect(again.headers['x-cache']).toBe('MISS');
  });
});

describe('REQUEST_TIMEOUT_MS', () => {
  it('sets the request timeout of the HTTP server', async () => {
    app = buildTestServer('/does/not/exist', { REQUEST_TIMEOUT_MS: '4000' });
    await app.ready();
    expect(app.server.requestTimeout).toBe(4000);
  });
});
