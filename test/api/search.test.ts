import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('liefert die Königsallee für "Königsall" in den ersten Ergebnissen', async () => {
    const { res, body } = await search(q('Königsall'));

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(body.type).toBe('FeatureCollection');
    const top = body.features.slice(0, 3).map((f) => f.properties['name']);
    expect(top).toContain('Königsallee');
  });

  it('liefert GeoJSON-Features mit Attribution', async () => {
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
    // Fehlende Werte werden weggelassen statt als null geliefert.
    expect(Object.values(feature?.properties ?? {})).not.toContain(null);
  });

  it('findet Straße mit Hausnummer', async () => {
    const { body } = await search(q('Königsallee 60d'));

    expect(body.features.length).toBeGreaterThan(0);
    for (const f of body.features) {
      expect(f.properties['street']).toBe('Königsallee');
      expect(String(f.properties['housenumber'])).toMatch(/^60d$/i);
    }
  });

  it('findet Hausnummern per Präfix', async () => {
    const { body } = await search(q('Königsallee 6', '&limit=10'));
    // Treffer ohne Hausnummer sind möglich (z. B. POI-Name "… Königsallee 62").
    const numbers = body.features
      .map((f) => f.properties['housenumber'])
      .filter((n): n is string => typeof n === 'string');
    expect(numbers.length).toBeGreaterThan(5);
    expect(numbers.every((n) => n.startsWith('6'))).toBe(true);
  });

  it('findet einen Ort und rankt ihn vor Straßen und Adressen', async () => {
    const { body } = await search(q('Düsseldorf'));
    expect(body.features[0]?.properties).toMatchObject({ name: 'Düsseldorf', type: 'city' });
  });

  it('toleriert Tippfehler am Wortende', async () => {
    for (const typo of ['Königsalleh', 'Königsallle', 'Königsalleee']) {
      const { body } = await search(q(typo));
      const names = body.features.map((f) => f.properties['name']);
      expect(names, typo).toContain('Königsallee');
    }
  });

  it('ist unabhängig von Groß-/Kleinschreibung', async () => {
    const { body } = await search(q('königsall'));
    expect(body.features.map((f) => f.properties['name'])).toContain('Königsallee');
  });

  it('liefert eine leere FeatureCollection ohne Treffer', async () => {
    const { res, body } = await search(q('Xyzzyquux'));
    expect(res.statusCode).toBe(200);
    expect(body.features).toEqual([]);
  });

  it('beachtet limit (Default 5)', async () => {
    expect((await search(q('Königsallee'))).body.features).toHaveLength(5);
    expect((await search(q('Königsallee', '&limit=3'))).body.features).toHaveLength(3);
    expect((await search(q('Königsallee', '&limit=10'))).body.features).toHaveLength(10);
  });

  it('bevorzugt bei gleichem Typ nahe Treffer, wenn lat/lon gesetzt sind', async () => {
    // Nördliches und südliches Ende der Kö
    for (const [lat, lon] of [
      [51.2261, 6.7796],
      [51.2195, 6.7805],
    ] as const) {
      const { body } = await search(q('Königsallee', `&lat=${String(lat)}&lon=${String(lon)}`));
      const streets = body.features.filter((f) => f.properties['type'] === 'street');
      const dist = streets.map((f) =>
        distanceMeters(lat, lon, f.geometry.coordinates[1], f.geometry.coordinates[0]),
      );
      expect(dist.length).toBeGreaterThan(1);
      expect(dist).toEqual([...dist].sort((a, b) => a - b));
    }
  });

  it('setzt Cache-Control für erfolgreiche Antworten', async () => {
    const { res } = await search(q('Königsall'));
    expect(res.headers['cache-control']).toMatch(/public, max-age=\d+/);
  });

  describe('Validierung', () => {
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
    ])('lehnt "%s" mit 400 ab (%s)', async (query, param) => {
      const { res, body } = await search(query);
      expect(res.statusCode).toBe(400);
      expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect((body as unknown as { message: string }).message).toContain(param);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('akzeptiert lang in Groß- und Kleinschreibung', async () => {
      expect((await search(q('Königsall', '&lang=EN'))).res.statusCode).toBe(200);
    });
  });
});

describe('CORS', () => {
  it('erlaubt per Default alle Origins', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api?${q('Königsall')}`,
      headers: { origin: 'https://irgendwo.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('erlaubt nur die konfigurierten Origins', async () => {
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

describe('ohne Index', () => {
  it('antwortet mit 503', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'doorstep-empty-'));
    const server = buildTestServer(empty);
    try {
      for (const url of [`/api?${q('Königsall')}`, '/reverse?lat=51.22&lon=6.78']) {
        const res = await server.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(503);
        expect(res.json()).toMatchObject({ statusCode: 503, error: 'Service Unavailable' });
        expect(res.headers['cache-control']).toBe('no-store');
      }
      // Validierung greift trotzdem zuerst
      expect((await server.inject({ method: 'GET', url: '/api?q=a' })).statusCode).toBe(400);
    } finally {
      await server.close();
      await rm(empty, { recursive: true, force: true });
    }
  });
});
