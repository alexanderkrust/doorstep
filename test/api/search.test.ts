import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildTestServer,
  createFixtureIndex,
  distanceMeters,
  type FeatureCollection,
  type FixtureIndex,
} from '../helpers/fixture-index.js';

let fixture: FixtureIndex;
let app: FastifyInstance;

beforeAll(async () => {
  fixture = await createFixtureIndex();
  app = buildTestServer(fixture.dir);
});

afterAll(async () => {
  await app.close();
  await fixture.cleanup();
});

async function search(query: string) {
  const res = await app.inject({ method: 'GET', url: `/api?${query}` });
  return { res, body: res.json<FeatureCollection>() };
}

const q = (text: string, extra = '') => `q=${encodeURIComponent(text)}${extra}`;

describe('GET /api', () => {
  it('returns Königsallee for "Königsall" among the first results', async () => {
    const { res, body } = await search(q('Königsall'));

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(body.type).toBe('FeatureCollection');
    const top = body.features.slice(0, 3).map((f) => f.properties['name']);
    expect(top).toContain('Königsallee');
  });

  it('returns GeoJSON features with attribution', async () => {
    const { body } = await search(q('Königsallee 60d'));

    expect(body.attribution).toBe('© OpenStreetMap contributors');
    const feature = body.features[0];
    expect(feature?.type).toBe('Feature');
    expect(feature?.geometry.type).toBe('Point');
    const [lon, lat] = feature?.geometry.coordinates ?? [];
    expect(lon).toBeCloseTo(6.781, 2);
    expect(lat).toBeCloseTo(51.222, 2);
    expect(feature?.properties).toMatchObject({
      street: 'Königsallee',
      postcode: '40212',
      city: 'Düsseldorf',
      country: 'DE',
      osm_id: expect.any(Number) as unknown,
      osm_type: expect.stringMatching(/^[NWR]$/) as unknown,
    });
    // Missing values are left out instead of returned as null.
    expect(Object.values(feature?.properties ?? {})).not.toContain(null);
  });

  it('finds a street with a house number', async () => {
    const { body } = await search(q('Königsallee 60d'));

    expect(body.features.length).toBeGreaterThan(0);
    for (const f of body.features) {
      expect(f.properties['street']).toBe('Königsallee');
      expect(String(f.properties['housenumber'])).toMatch(/^60d$/i);
    }
  });

  it('finds house numbers by prefix', async () => {
    const { body } = await search(q('Königsallee 6', '&limit=10'));
    // Hits without a house number are possible (e.g. POI name "… Königsallee 62").
    const numbers = body.features
      .map((f) => f.properties['housenumber'])
      .filter((n): n is string => typeof n === 'string');
    expect(numbers.length).toBeGreaterThan(5);
    expect(numbers.every((n) => n.startsWith('6'))).toBe(true);
  });

  it('finds a city and ranks it before streets and addresses', async () => {
    const { body } = await search(q('Düsseldorf'));
    expect(body.features[0]?.properties).toMatchObject({ name: 'Düsseldorf', type: 'city' });
  });

  it('tolerates typos at the end of a word', async () => {
    for (const typo of ['Königsalleh', 'Königsallle', 'Königsalleee']) {
      const { body } = await search(q(typo));
      const names = body.features.map((f) => f.properties['name']);
      expect(names, typo).toContain('Königsallee');
    }
  });

  it('is case-insensitive', async () => {
    const { body } = await search(q('königsall'));
    expect(body.features.map((f) => f.properties['name'])).toContain('Königsallee');
  });

  it('returns an empty FeatureCollection without hits', async () => {
    const { res, body } = await search(q('Xyzzyquux'));
    expect(res.statusCode).toBe(200);
    expect(body.features).toEqual([]);
  });

  it('respects limit (default 5)', async () => {
    expect((await search(q('Königsallee'))).body.features).toHaveLength(5);
    expect((await search(q('Königsallee', '&limit=3'))).body.features).toHaveLength(3);
    expect((await search(q('Königsallee', '&limit=10'))).body.features).toHaveLength(10);
  });

  it('returns the nearest segment of a street with lat/lon', async () => {
    // Northern and southern end of the Kö (about 750 m apart)
    for (const [lat, lon] of [
      [51.2261, 6.7796],
      [51.2195, 6.7805],
    ] as const) {
      const { body } = await search(q('Königsallee', `&lat=${String(lat)}&lon=${String(lon)}`));
      const streets = body.features.filter((f) => f.properties['type'] === 'street');
      // Segments of the same street are merged into one hit.
      expect(streets).toHaveLength(1);
      const [sLon, sLat] = streets[0]?.geometry.coordinates ?? [0, 0];
      expect(distanceMeters(lat, lon, sLat, sLon)).toBeLessThan(250);
    }
  });

  it('sets Cache-Control for successful responses', async () => {
    const { res } = await search(q('Königsall'));
    expect(res.headers['cache-control']).toMatch(/public, max-age=\d+/);
  });

  describe('validation', () => {
    it.each([
      ['', 'q'],
      ['q=', 'q'],
      ['q=a', 'q'],
      ['q=%20%20a%20', 'q'],
      ['q=!!', 'q'],
      [q('Königsallee', '&limit=11'), 'limit'],
      [q('Königsallee', '&limit=0'), 'limit'],
      [q('Königsallee', '&limit=abc'), 'limit'],
      [q('Königsallee', '&limit=2.5'), 'limit'],
      [q('Königsallee', '&lat=51.2'), 'lon'],
      [q('Königsallee', '&lon=6.7'), 'lat'],
      [q('Königsallee', '&lat=91&lon=6.7'), 'lat'],
      [q('Königsallee', '&lat=51&lon=-181'), 'lon'],
      [q('Königsallee', '&lang=deutsch'), 'lang'],
      ['q=foo&q=bar', 'q'],
    ])('rejects "%s" with 400 (%s)', async (query, param) => {
      const { res, body } = await search(query);
      expect(res.statusCode).toBe(400);
      expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect((body as unknown as { message: string }).message).toContain(param);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('accepts lang in upper and lower case', async () => {
      expect((await search(q('Königsall', '&lang=EN'))).res.statusCode).toBe(200);
    });
  });
});

describe('CORS', () => {
  it('allows all origins by default', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api?${q('Königsall')}`,
      headers: { origin: 'https://irgendwo.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('allows only the configured origins', async () => {
    const restricted = buildTestServer(fixture.dir, {
      CORS_ORIGINS: 'https://shop.example, https://admin.example',
    });
    try {
      const get = (origin: string) =>
        restricted.inject({ method: 'GET', url: `/api?${q('Königsall')}`, headers: { origin } });

      expect((await get('https://shop.example')).headers['access-control-allow-origin']).toBe(
        'https://shop.example',
      );
      expect((await get('https://admin.example')).headers['access-control-allow-origin']).toBe(
        'https://admin.example',
      );
      expect((await get('https://evil.example')).headers['access-control-allow-origin']).toBe(
        undefined,
      );

      const preflight = await restricted.inject({
        method: 'OPTIONS',
        url: '/api',
        headers: { origin: 'https://shop.example', 'access-control-request-method': 'GET' },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('https://shop.example');
    } finally {
      await restricted.close();
    }
  });
});

describe('without an index', () => {
  it('answers 503', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'doorstep-empty-'));
    const server = buildTestServer(empty);
    try {
      for (const url of [`/api?${q('Königsall')}`, '/reverse?lat=51.22&lon=6.78']) {
        const res = await server.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(503);
        expect(res.json()).toMatchObject({ statusCode: 503, error: 'Service Unavailable' });
        expect(res.headers['cache-control']).toBe('no-store');
      }
      // Validation still comes first
      expect((await server.inject({ method: 'GET', url: '/api?q=a' })).statusCode).toBe(400);
    } finally {
      await server.close();
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('phase 4: normalization, fallback, language', () => {
  const names = async (text: string, extra = '') =>
    (await search(q(text, extra))).body.features.map((f) => f.properties['name']);

  it.each(['Koenigsallee', 'KÖNIGSALLEE', 'koenigsall', 'Königsallee'])(
    'also finds Königsallee as "%s"',
    async (text) => {
      expect(await names(text)).toContain('Königsallee');
    },
  );

  it('understands "Str." as Straße', async () => {
    const { body } = await search(q('Graf-Adolf-Str.'));
    expect(body.features[0]?.properties['name']).toBe('Graf-Adolf-Straße');
  });

  it('finds an address with a separate house number suffix', async () => {
    const { body } = await search(q('Königsallee 60 d'));
    expect(body.features[0]?.properties['street']).toBe('Königsallee');
    expect(String(body.features[0]?.properties['housenumber'])).toMatch(/^60d$/i);
  });

  it('returns the street for an unknown house number', async () => {
    const { res, body } = await search(q('Königsallee 999'));
    expect(res.statusCode).toBe(200);
    expect(body.features.length).toBeGreaterThan(0);
    expect(body.features[0]?.properties).toMatchObject({ name: 'Königsallee', type: 'street' });
    expect(body.features.some((f) => f.properties['type'] === 'house')).toBe(false);
  });

  it('picks the name by lang (fallback to name)', async () => {
    expect((await names('Düsseldorf', '&lang=en'))[0]).toBe('Dusseldorf');
    expect((await names('Düsseldorf', '&lang=de'))[0]).toBe('Düsseldorf');
    expect((await names('Düsseldorf', '&lang=fr'))[0]).toBe('Düsseldorf');
    // Ohne lang gilt DEFAULT_LANG (de)
    expect((await names('Düsseldorf'))[0]).toBe('Düsseldorf');
  });

  it('also finds places by their English name', async () => {
    expect((await names('Dusseldorf'))[0]).toBe('Düsseldorf');
  });

  it('uses DEFAULT_LANG when lang is missing', async () => {
    const english = buildTestServer(fixture.dir, { DEFAULT_LANG: 'en' });
    try {
      const res = await english.inject({ method: 'GET', url: `/api?${q('Düsseldorf')}` });
      expect(res.json<FeatureCollection>().features[0]?.properties['name']).toBe('Dusseldorf');
    } finally {
      await english.close();
    }
  });

  it('reports the search duration in the Server-Timing header', async () => {
    const { res } = await search(q('Königsall'));
    expect(res.headers['server-timing']).toMatch(/^search;dur=\d+(\.\d+)?$/);
  });
});

describe('index with an old schema', () => {
  it('answers 503 with a hint to import again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doorstep-old-'));
    const db = new DatabaseSync(join(dir, 'index.sqlite'));
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO meta VALUES ('schema_version', '1');`);
    db.close();
    const server = buildTestServer(dir);
    try {
      const res = await server.inject({ method: 'GET', url: `/api?${q('Königsall')}` });
      expect(res.statusCode).toBe(503);
      expect(res.json<{ message: string }>().message).toMatch(/schema.*import again/);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
