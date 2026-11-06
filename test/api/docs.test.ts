import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_LIMIT,
  MAX_QUERY_LENGTH,
  MAX_REVERSE_RADIUS_KM,
  MIN_QUERY_LENGTH,
  reverseParams,
  searchParams,
} from '../../src/api/params.js';
import { VERSION } from '../../src/api/version.js';
import {
  buildTestServer,
  createFixtureIndex,
  type FixtureIndex,
} from '../helpers/fixture-index.js';

const KEY = 'key-for-tests-0123456789';

interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  schema: Record<string, unknown>;
}

interface Operation {
  parameters?: Parameter[];
  security?: Record<string, string[]>[];
  responses: Record<string, unknown>;
}

interface OpenApi {
  openapi: string;
  info: { title: string; version: string; license: { name: string } };
  paths: Record<string, { get: Operation }>;
  components: {
    schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
    securitySchemes?: Record<string, { type: string; in: string; name: string }>;
  };
}

let fixture: FixtureIndex;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  fixture = await createFixtureIndex();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

afterAll(async () => {
  await fixture.cleanup();
});

function get(url: string) {
  if (!app) throw new Error('Server missing');
  return app.inject({ method: 'GET', url });
}

async function openApi(env: Record<string, string> = {}): Promise<OpenApi> {
  app = buildTestServer(fixture.dir, env);
  const res = await get('/openapi.json');
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toMatch(/^application\/json/);
  return res.json<OpenApi>();
}

function op(doc: OpenApi, path: string): Operation {
  const found = doc.paths[path]?.get;
  if (!found) throw new Error(`GET ${path} missing`);
  return found;
}

function component(doc: OpenApi, name: string): OpenApi['components']['schemas'][string] {
  const found = doc.components.schemas[name];
  if (!found) throw new Error(`schema ${name} missing`);
  return found;
}

function parameter(operation: Operation, name: string): Parameter {
  const found = operation.parameters?.find((p) => p.name === name);
  if (!found) throw new Error(`parameter ${name} missing`);
  return found;
}

describe('GET /openapi.json', () => {
  it('describes all endpoints as OpenAPI 3.1 with the app version', async () => {
    const doc = await openApi();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe(VERSION);
    expect(doc.info.license.name).toMatch(/ODbL/);
    expect(Object.keys(doc.paths).sort()).toEqual(['/api', '/health', '/metrics', '/reverse']);
  });

  it('lists exactly the query parameters the routes accept', async () => {
    const doc = await openApi();
    const names = (op: Operation) => (op.parameters ?? []).map((p) => p.name).sort();
    // api_key is described as a security scheme, not as a parameter.
    expect(names(op(doc, '/api'))).toEqual(Object.keys(searchParams.shape).sort());
    expect(names(op(doc, '/reverse'))).toEqual(Object.keys(reverseParams.shape).sort());
  });

  it('uses the same limits as the validation', async () => {
    const doc = await openApi();
    const search = op(doc, '/api');
    expect(parameter(search, 'q')).toMatchObject({
      in: 'query',
      required: true,
      schema: { minLength: MIN_QUERY_LENGTH, maxLength: MAX_QUERY_LENGTH },
    });
    expect(parameter(search, 'limit').schema).toMatchObject({ minimum: 1, maximum: MAX_LIMIT });

    const reverse = op(doc, '/reverse');
    expect(parameter(reverse, 'lat')).toMatchObject({ required: true });
    expect(parameter(reverse, 'radius').schema).toMatchObject({
      exclusiveMinimum: 0,
      maximum: MAX_REVERSE_RADIUS_KM,
    });
  });

  it('describes the GeoJSON answer with the fields a real answer has', async () => {
    const doc = await openApi();
    const [collection, featureSchema, properties] = [
      'FeatureCollection',
      'Feature',
      'Properties',
    ].map((name) => component(doc, name));
    const body = (await get('/api?q=K%C3%B6nigsall')).json<{
      features: { properties: Record<string, unknown> }[];
    }>();
    const [feature] = body.features;
    if (!feature || !collection || !featureSchema || !properties) throw new Error('missing');
    for (const key of collection.required ?? []) expect(body).toHaveProperty(key);
    for (const key of featureSchema.required ?? []) expect(feature).toHaveProperty(key);
    for (const key of properties.required ?? []) expect(feature.properties).toHaveProperty(key);
    // Every field of the answer is described.
    for (const key of Object.keys(feature.properties)) {
      expect(properties.properties).toHaveProperty(key);
    }
  });

  it('marks the API key as optional by default', async () => {
    const doc = await openApi();
    expect(op(doc, '/api').security).toContainEqual({});
    expect(doc.components.securitySchemes).toMatchObject({
      ApiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      ApiKeyQuery: { type: 'apiKey', in: 'query', name: 'api_key' },
    });
  });

  it('marks the API key as required with REQUIRE_API_KEY and leaves out the query key', async () => {
    const doc = await openApi({
      API_KEYS: KEY,
      REQUIRE_API_KEY: 'true',
      API_KEY_IN_QUERY: 'false',
    });
    expect(op(doc, '/api').security).toEqual([{ ApiKeyHeader: [] }]);
    expect(op(doc, '/reverse').responses).toHaveProperty('401');
    expect(doc.components.securitySchemes).not.toHaveProperty('ApiKeyQuery');
    // /openapi.json itself stays open (checked by openApi()).
  });
});

describe('GET /docs', () => {
  it('serves Swagger UI from the image, without a CDN', async () => {
    app = buildTestServer(fixture.dir);
    const page = await get('/docs');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(page.body).toContain('/docs/swagger-ui-bundle.js');
    expect(page.body).not.toMatch(/https?:\/\//);

    const script = await get('/docs/swagger-ui-bundle.js');
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toMatch(/javascript/);
    expect((await get('/docs/swagger-ui.css')).headers['content-type']).toMatch(/^text\/css/);
    expect((await get('/docs/init.js')).body).toContain('/openapi.json');
    expect((await get('/docs/../package.json')).statusCode).toBe(404);
    expect((await get('/docs/index.html')).statusCode).toBe(404);
  });

  it('stays open with REQUIRE_API_KEY', async () => {
    app = buildTestServer(fixture.dir, { API_KEYS: KEY, REQUIRE_API_KEY: 'true' });
    expect((await get('/docs')).statusCode).toBe(200);
    expect((await get('/openapi.json')).statusCode).toBe(200);
  });

  it('is gone with DOCS_ENABLED=false', async () => {
    app = buildTestServer(fixture.dir, { DOCS_ENABLED: 'false' });
    expect((await get('/docs')).statusCode).toBe(404);
    expect((await get('/openapi.json')).statusCode).toBe(404);
  });
});
