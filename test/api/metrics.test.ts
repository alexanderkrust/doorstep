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

/** Wert einer Zeile `name{labels} value` aus dem Prometheus-Text. */
function sample(text: string, series: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

describe('GET /metrics', () => {
  it('liefert Prometheus-Text mit HELP und TYPE', async () => {
    app = buildTestServer(fixture.dir);
    const res = await get('/metrics');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatch(/^# HELP doorstep_http_requests_total /m);
    expect(res.body).toMatch(/^# TYPE doorstep_http_requests_total counter$/m);
    expect(res.body).toMatch(/^# TYPE doorstep_http_request_duration_seconds histogram$/m);
    expect(res.body.endsWith('\n')).toBe(true);
  });

  it('zählt Anfragen pro Route und Status, ohne die Query im Label', async () => {
    app = buildTestServer(fixture.dir);
    await get('/api?q=K%C3%B6nigsall');
    await get('/api?q=Bilk');
    await get('/api?q=x');
    await get('/gibt-es-nicht');
    const text = (await get('/metrics')).body;

    expect(
      sample(text, 'doorstep_http_requests_total{method="GET",route="/api",status="200"}'),
    ).toBe(2);
    expect(
      sample(text, 'doorstep_http_requests_total{method="GET",route="/api",status="400"}'),
    ).toBe(1);
    expect(
      sample(text, 'doorstep_http_requests_total{method="GET",route="unmatched",status="404"}'),
    ).toBe(1);
    expect(text).not.toContain('nigsall');
  });

  it('enthält ein Histogramm der Antwortzeiten', async () => {
    app = buildTestServer(fixture.dir);
    await get('/api?q=K%C3%B6nigsall');
    const text = (await get('/metrics')).body;

    expect(sample(text, 'doorstep_http_request_duration_seconds_count{route="/api"}')).toBe(1);
    expect(
      sample(text, 'doorstep_http_request_duration_seconds_bucket{route="/api",le="+Inf"}'),
    ).toBe(1);
    expect(
      sample(text, 'doorstep_http_request_duration_seconds_sum{route="/api"}'),
    ).toBeGreaterThan(0);
  });

  it('meldet Cache-Treffer, Index-Zustand und Neuladen', async () => {
    app = buildTestServer(fixture.dir);
    await get('/api?q=K%C3%B6');
    await get('/api?q=K%C3%B6');
    let text = (await get('/metrics')).body;

    expect(sample(text, 'doorstep_search_cache_hits_total')).toBe(1);
    expect(sample(text, 'doorstep_search_cache_misses_total')).toBe(1);
    expect(sample(text, 'doorstep_index_available')).toBe(1);
    expect(sample(text, 'doorstep_index_places')).toBeGreaterThan(0);
    expect(sample(text, 'doorstep_index_imported_timestamp_seconds')).toBeGreaterThan(1.7e9);
    expect(sample(text, 'doorstep_index_reloads_total')).toBe(0);
    expect(sample(text, 'process_resident_memory_bytes')).toBeGreaterThan(0);

    app.reloadIndex();
    text = (await get('/metrics')).body;
    expect(sample(text, 'doorstep_index_reloads_total')).toBe(0); // gleiche Datei, kein Tausch
  });

  it('meldet einen fehlenden Index', async () => {
    app = buildTestServer('/gibt/es/nicht');
    const text = (await get('/metrics')).body;
    expect(sample(text, 'doorstep_index_available')).toBe(0);
  });

  it('zählt abgewiesene Anfragen (Rate-Limit)', async () => {
    app = buildTestServer('/gibt/es/nicht', { RATE_LIMIT_ENABLED: 'true', RATE_LIMIT: '1' });
    await get('/api?q=ab');
    await get('/api?q=ab');
    const text = (await get('/metrics')).body;
    expect(sample(text, 'doorstep_rate_limited_total')).toBe(1);
    expect(
      sample(text, 'doorstep_http_requests_total{method="GET",route="/api",status="429"}'),
    ).toBe(1);
  });
});
