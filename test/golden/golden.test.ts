import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importFromGeoJsonSeq, INDEX_FILE } from '../../src/import/pipeline.js';
import {
  buildTestServer,
  distanceMeters,
  type FeatureCollection,
  type PointFeature,
} from '../helpers/fixture-index.js';

interface GoldenQuery {
  q: string;
  lat?: number;
  lon?: number;
  lang?: string;
  /** Erwarteter Treffer muss unter den ersten `top` sein (Default 1). */
  top?: number;
  expect: Record<string, string>;
  /** [lat, lon, maxMeter]: der Treffer muss so nah an diesem Punkt liegen. */
  near?: [number, number, number];
  /** Begründung für eine gelockerte Erwartung. */
  note?: string;
}

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'duesseldorf.geojsonseq');
const golden = JSON.parse(
  await readFile(join(import.meta.dirname, 'duesseldorf.json'), 'utf8'),
) as { queries: GoldenQuery[] };

let dir: string;
let app: FastifyInstance;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doorstep-golden-'));
  await importFromGeoJsonSeq(FIXTURE, join(dir, INDEX_FILE));
  app = buildTestServer(dir);
}, 60_000);

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const text = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

function matches(feature: PointFeature, query: GoldenQuery): boolean {
  const fits = Object.entries(query.expect).every(
    ([key, value]) => text(feature.properties[key]).toLowerCase() === value.toLowerCase(),
  );
  if (!fits || !query.near) return fits;
  const [lat, lon, maxMeters] = query.near;
  const [fLon, fLat] = feature.geometry.coordinates;
  return distanceMeters(lat, lon, fLat, fLon) <= maxMeters;
}

const label = (g: GoldenQuery) =>
  [
    g.q,
    g.lat !== undefined ? `@${String(g.lat)},${String(g.lon)}` : '',
    g.lang ? `[${g.lang}]` : '',
  ]
    .filter(Boolean)
    .join(' ');

describe('Golden-Queries', () => {
  it('enthält 30 bis 50 Anfragen', () => {
    expect(golden.queries.length).toBeGreaterThanOrEqual(30);
    expect(golden.queries.length).toBeLessThanOrEqual(50);
  });

  it.each(golden.queries.map((g) => [label(g), g] as const))('%s', async (_, g) => {
    const params = new URLSearchParams({ q: g.q, limit: '10' });
    if (g.lat !== undefined && g.lon !== undefined) {
      params.set('lat', String(g.lat));
      params.set('lon', String(g.lon));
    }
    if (g.lang) params.set('lang', g.lang);
    const res = await app.inject({ method: 'GET', url: `/api?${params.toString()}` });
    expect(res.statusCode).toBe(200);

    const features = res.json<FeatureCollection>().features;
    const top = features.slice(0, g.top ?? 1);
    const summary = features
      .slice(0, 5)
      .map((f) => {
        const p = f.properties;
        const where = `${text(p['street'])} ${text(p['housenumber'])}`.trim();
        return `${text(p['type'])}: ${text(p['name']) || where}`;
      })
      .join(' | ');
    expect(
      top.some((f) => matches(f, g)),
      `Treffer: ${summary}`,
    ).toBe(true);
  });
});
