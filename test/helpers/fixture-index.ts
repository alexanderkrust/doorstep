import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer, type ServerOptions } from '../../src/api/server.js';
import { loadConfig } from '../../src/config/index.js';
import { importFromGeoJsonSeq, INDEX_FILE } from '../../src/import/pipeline.js';

const GEOJSONSEQ = join(import.meta.dirname, '..', 'fixtures', 'koenigsallee.geojsonseq');

export interface FixtureIndex {
  dir: string;
  path: string;
  cleanup: () => Promise<void>;
}

/** Baut den Test-Index (Königsallee) in ein temporäres DATA_DIR. */
export async function createFixtureIndex(): Promise<FixtureIndex> {
  const dir = await mkdtemp(join(tmpdir(), 'doorstep-api-'));
  const path = join(dir, INDEX_FILE);
  await importFromGeoJsonSeq(GEOJSONSEQ, path);
  return { dir, path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Server gegen ein DATA_DIR, ohne Logausgabe. Rate-Limiting ist aus, solange
 * `env` es nicht einschaltet; Tests schicken viele Anfragen von derselben IP.
 */
export function buildTestServer(
  dataDir: string,
  env: NodeJS.ProcessEnv = {},
  options: ServerOptions = {},
): FastifyInstance {
  return buildServer(
    loadConfig({ LOG_LEVEL: 'silent', DATA_DIR: dataDir, RATE_LIMIT_ENABLED: 'false', ...env }),
    options,
  );
}

export interface PointFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, unknown>;
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: PointFeature[];
  attribution: string;
}

/** Entfernung in Metern (Haversine). */
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a));
}
