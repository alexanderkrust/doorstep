import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importFromGeoJsonSeq, INDEX_FILE, loadBoundaryFiles } from '../../src/import/pipeline.js';
import { buildTestServer, type FeatureCollection } from '../helpers/fixture-index.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

/** Grenzstraße Herzogenrath/Kerkrade: beide Seiten heißen fast gleich, liegen ca. 50 m auseinander. */
const FEATURES = [
  {
    coordinates: [6.075014, 50.8517797],
    properties: {
      'addr:street': 'Nieuwstraat',
      'addr:housenumber': '60',
      'addr:postcode': '6462GL',
      'addr:city': 'Kerkrade',
      // falsch getaggt
      'addr:country': 'DE',
    },
  },
  {
    coordinates: [6.075576, 50.8520063],
    properties: {
      'addr:street': 'Neustraße',
      'addr:housenumber': '127',
      'addr:postcode': '52134',
      'addr:city': 'Herzogenrath',
    },
  },
  {
    coordinates: [10.184858, 47.3558401],
    properties: {
      'addr:street': 'Walserstraße',
      'addr:housenumber': '77',
      'addr:postcode': '6991',
      'addr:city': 'Riezlern',
    },
  },
];

let dir: string;
let app: FastifyInstance;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doorstep-search-boundaries-'));
  const input = join(dir, 'places.geojsonseq');
  await writeFile(
    input,
    FEATURES.map(({ coordinates, properties }, i) =>
      JSON.stringify({
        type: 'Feature',
        geometry: { type: 'Point', coordinates },
        properties: { '@type': 'node', '@id': i + 1, ...properties },
      }),
    ).join('\n'),
  );
  const boundaries = await loadBoundaryFiles(
    join(FIXTURES, 'grenzen.geojsonseq'),
    join(FIXTURES, 'grenzen.opl'),
  );
  await importFromGeoJsonSeq(input, join(dir, INDEX_FILE), { boundaries });
  app = buildTestServer(dir);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function first(q: string): Promise<Record<string, unknown> | undefined> {
  const res = await app.inject({ method: 'GET', url: `/api?q=${encodeURIComponent(q)}` });
  expect(res.statusCode).toBe(200);
  return res.json<FeatureCollection>().features[0]?.properties;
}

describe('Land und Bundesland in Suchergebnissen', () => {
  it('Adresse in Herzogenrath: Deutschland, Nordrhein-Westfalen', async () => {
    expect(await first('Neustraße 127 Herzogenrath')).toMatchObject({
      street: 'Neustraße',
      housenumber: '127',
      state: 'Nordrhein-Westfalen',
      country: 'DE',
    });
  });

  it('Adresse in Kerkrade: Niederlande, auch bei falschem addr:country', async () => {
    const properties = await first('Nieuwstraat 60 Kerkrade');
    expect(properties).toMatchObject({ street: 'Nieuwstraat', country: 'NL' });
    expect(properties).not.toHaveProperty('state');
  });

  it('Adresse im Kleinwalsertal: Österreich', async () => {
    expect(await first('Walserstraße 77 Riezlern')).toMatchObject({ country: 'AT' });
  });
});
