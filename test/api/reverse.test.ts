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

async function reverse(query: string) {
  const res = await app.inject({ method: 'GET', url: `/reverse?${query}` });
  return { res, body: res.json<FeatureCollection>() };
}

const coords = (body: FeatureCollection) =>
  body.features.map((f) => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));

describe('GET /reverse', () => {
  it('finds the object at exactly this spot', async () => {
    // Königsallee 60d (OSM node 309938104)
    const { res, body } = await reverse('lat=51.2220118&lon=6.7810708');

    expect(res.statusCode).toBe(200);
    expect(body.type).toBe('FeatureCollection');
    expect(body.attribution).toBe('© OpenStreetMap contributors');
    expect(body.features).toHaveLength(1);
    const [first] = coords(body);
    expect(distanceMeters(51.2220118, 6.7810708, first?.lat ?? 0, first?.lon ?? 0)).toBeLessThan(1);
    expect(body.features[0]?.properties).toMatchObject({
      street: 'Königsallee',
      city: 'Düsseldorf',
    });
  });

  it('returns a plausible hit nearby', async () => {
    const lat = 51.2235;
    const lon = 6.7801;
    const { body } = await reverse(`lat=${String(lat)}&lon=${String(lon)}`);
    const [first] = coords(body);
    expect(first).toBeDefined();
    expect(distanceMeters(lat, lon, first?.lat ?? 0, first?.lon ?? 0)).toBeLessThan(100);
  });

  it('returns several hits with limit, sorted by distance', async () => {
    const lat = 51.2235;
    const lon = 6.7801;
    const { body } = await reverse(`lat=${String(lat)}&lon=${String(lon)}&limit=5`);
    const dist = coords(body).map((c) => distanceMeters(lat, lon, c.lat, c.lon));
    expect(dist).toHaveLength(5);
    expect(dist).toEqual([...dist].sort((a, b) => a - b));
  });

  it('finds nothing outside the radius', async () => {
    expect((await reverse('lat=0&lon=0')).body.features).toEqual([]);
    // about 1.5 km north of the data: empty with the default radius of 1 km, one hit with 3 km
    expect((await reverse('lat=51.243&lon=6.780')).body.features).toEqual([]);
    expect((await reverse('lat=51.243&lon=6.780&radius=3')).body.features).toHaveLength(1);
  });

  it('sets Cache-Control', async () => {
    const { res } = await reverse('lat=51.2235&lon=6.7801');
    expect(res.headers['cache-control']).toMatch(/public, max-age=\d+/);
  });

  describe('validation', () => {
    it.each([
      ['', 'lat'],
      ['lon=6.78', 'lat'],
      ['lat=51.22', 'lon'],
      ['lat=abc&lon=6.78', 'lat'],
      ['lat=-91&lon=6.78', 'lat'],
      ['lat=51.22&lon=181', 'lon'],
      ['lat=51.22&lon=6.78&limit=11', 'limit'],
      ['lat=51.22&lon=6.78&limit=0', 'limit'],
      ['lat=51.22&lon=6.78&radius=0', 'radius'],
      ['lat=51.22&lon=6.78&radius=11', 'radius'],
      ['lat=51.22&lon=6.78&lang=xyz', 'lang'],
    ])('rejects "%s" with 400 (%s)', async (query, param) => {
      const { res, body } = await reverse(query);
      expect(res.statusCode).toBe(400);
      expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect((body as unknown as { message: string }).message).toContain(param);
    });
  });
});
