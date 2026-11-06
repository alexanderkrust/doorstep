import type { Config } from '../config/index.js';
import { RESULT_TYPES } from '../search/result-type.js';
import { ATTRIBUTION } from './attribution.js';
import {
  DEFAULT_REVERSE_RADIUS_KM,
  DEFAULT_SEARCH_LIMIT,
  MAX_LIMIT,
  MAX_QUERY_LENGTH,
  MAX_REVERSE_RADIUS_KM,
  MIN_QUERY_LENGTH,
} from './params.js';
import { healthResponseSchema } from './routes/health.js';
import { VERSION } from './version.js';

type Json = Record<string, unknown>;

/**
 * Written by hand: the zod schemas in params.ts turn strings into numbers, which JSON Schema
 * cannot express. The limits come from the same constants, and a test checks that the
 * parameter names match the zod schemas.
 */
function queryParameter(name: string, description: string, schema: Json, required = false): Json {
  return { name, in: 'query', required, description, schema };
}

const typesParameter = queryParameter(
  'types',
  `Only these result types, comma-separated (e.g. \`street,poi\`). One of: ${RESULT_TYPES.join(', ')}.`,
  { type: 'string' },
);

function langParameter(defaultLang: string): Json {
  return queryParameter('lang', 'Two-letter language code for names and countries.', {
    type: 'string',
    pattern: '^[a-zA-Z]{2}$',
    default: defaultLang,
  });
}

function limitParameter(fallback: number): Json {
  return queryParameter('limit', 'Number of results.', {
    type: 'integer',
    minimum: 1,
    maximum: MAX_LIMIT,
    default: fallback,
  });
}

const latitude = { type: 'number', minimum: -90, maximum: 90 };
const longitude = { type: 'number', minimum: -180, maximum: 180 };

function error(description: string): Json {
  return {
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  };
}

const geoJson = {
  description: 'GeoJSON FeatureCollection, sorted by relevance or distance.',
  headers: {
    'Cache-Control': {
      description: '`public, max-age=<CACHE_MAX_AGE>`, `private` with REQUIRE_API_KEY.',
      schema: { type: 'string' },
    },
    'Server-Timing': {
      description: 'Search time, e.g. `search;dur=2.31`.',
      schema: { type: 'string' },
    },
  },
  content: {
    'application/json': { schema: { $ref: '#/components/schemas/FeatureCollection' } },
  },
};

const schemas = {
  FeatureCollection: {
    type: 'object',
    required: ['type', 'features', 'attribution'],
    properties: {
      type: { const: 'FeatureCollection' },
      features: { type: 'array', items: { $ref: '#/components/schemas/Feature' } },
      attribution: {
        type: 'string',
        description: 'Required by the ODbL: show it next to the results.',
        example: ATTRIBUTION,
      },
    },
  },
  Feature: {
    type: 'object',
    required: ['type', 'geometry', 'properties'],
    properties: {
      type: { const: 'Feature' },
      geometry: {
        type: 'object',
        required: ['type', 'coordinates'],
        properties: {
          type: { const: 'Point' },
          coordinates: {
            type: 'array',
            description: '`[lon, lat]` in WGS84.',
            prefixItems: [longitude, latitude],
            minItems: 2,
            maxItems: 2,
            example: [6.7795, 51.2235],
          },
        },
      },
      properties: { $ref: '#/components/schemas/Properties' },
    },
  },
  Properties: {
    type: 'object',
    required: ['id', 'type', 'label', 'main_text', 'address'],
    properties: {
      id: {
        type: 'string',
        description: 'Stable ID of the OSM object.',
        example: 'way/42',
      },
      type: { type: 'string', enum: [...RESULT_TYPES] },
      category: {
        type: 'string',
        description: 'OSM tag that makes the object what it is.',
        example: 'shop=supermarket',
      },
      name: {
        type: 'string',
        description: 'Name in the requested language; missing for plain addresses.',
      },
      label: { type: 'string', description: 'One line for display: `main_text, secondary_text`.' },
      main_text: { type: 'string', description: 'The part the user is looking for.' },
      secondary_text: {
        type: 'string',
        description: 'Where it is, e.g. "40212 Düsseldorf, Deutschland".',
      },
      address: { $ref: '#/components/schemas/Address' },
      distance_m: {
        type: 'number',
        description: "Distance to the request's location (`lat`/`lon`), in meters.",
      },
    },
  },
  Address: {
    type: 'object',
    properties: {
      street: { type: 'string' },
      housenumber: { type: 'string' },
      postcode: { type: 'string' },
      city: { type: 'string' },
      district: { type: 'string' },
      state: { type: 'string' },
      country: { type: 'string', description: 'Country name in the requested language.' },
      country_code: { type: 'string', description: 'ISO 3166-1 alpha-2.', example: 'DE' },
    },
  },
  Error: {
    type: 'object',
    required: ['statusCode', 'error', 'message'],
    properties: {
      statusCode: { type: 'integer' },
      error: { type: 'string' },
      message: { type: 'string', example: 'q: must be at least 2 characters long' },
    },
  },
  Health: healthResponseSchema,
};

/** The OpenAPI 3.1 document for `/openapi.json`, matching this configuration. */
export function buildOpenApiDocument(config: Config): Json {
  const securitySchemes: Json = {
    ApiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    ...(config.apiKeyInQuery
      ? { ApiKeyQuery: { type: 'apiKey', in: 'query', name: 'api_key' } }
      : {}),
  };
  const keyOptions = Object.keys(securitySchemes).map((name) => ({ [name]: [] }));
  // `{}`: without a key, at the rate limit per IP.
  const security = config.requireApiKey ? keyOptions : [{}, ...keyOptions];

  const searchResponses = {
    200: geoJson,
    400: error('Invalid parameters.'),
    ...(config.requireApiKey ? { 401: error('Missing or unknown API key.') } : {}),
    429: error('Rate limit exceeded.'),
    503: error(
      'No index yet (import running), or the search is overloaded or too slow (with `Retry-After`).',
    ),
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'doorstep',
      version: VERSION,
      description:
        'Address autosuggest and reverse geocoding on OpenStreetMap data. Answers are GeoJSON. ' +
        `Data ${ATTRIBUTION}, available under the Open Database License (ODbL).`,
      license: { name: 'Data: ODbL-1.0', url: 'https://opendatacommons.org/licenses/odbl/' },
    },
    // Relative: the API answers on the host and path the document was loaded from.
    servers: [{ url: '/' }],
    paths: {
      '/api': {
        get: {
          summary: 'Autosuggest',
          description:
            'Suggestions for a search text as you type. The last word is searched as a prefix; ' +
            'if that finds nothing, the earlier words too (`gneis 62 düss`), then typos in any word ' +
            'are corrected (`gnies 62 düs`).',
          operationId: 'search',
          tags: ['Search'],
          security,
          parameters: [
            queryParameter(
              'q',
              'Search text.',
              {
                type: 'string',
                minLength: MIN_QUERY_LENGTH,
                maxLength: MAX_QUERY_LENGTH,
                example: 'Königsallee 1 Düsseldorf',
              },
              true,
            ),
            limitParameter(DEFAULT_SEARCH_LIMIT),
            queryParameter(
              'lat',
              'Latitude for the location bias; only together with `lon`.',
              latitude,
            ),
            queryParameter(
              'lon',
              'Longitude for the location bias; only together with `lat`.',
              longitude,
            ),
            langParameter(config.defaultLang),
            typesParameter,
          ],
          responses: searchResponses,
        },
      },
      '/reverse': {
        get: {
          summary: 'Reverse geocoding',
          description: 'The nearest objects to a point.',
          operationId: 'reverse',
          tags: ['Search'],
          security,
          parameters: [
            queryParameter('lat', 'Latitude in WGS84.', { ...latitude, example: 51.2235 }, true),
            queryParameter('lon', 'Longitude in WGS84.', { ...longitude, example: 6.7795 }, true),
            limitParameter(1),
            queryParameter('radius', 'Search radius in km.', {
              type: 'number',
              exclusiveMinimum: 0,
              maximum: MAX_REVERSE_RADIUS_KM,
              default: DEFAULT_REVERSE_RADIUS_KM,
            }),
            langParameter(config.defaultLang),
            typesParameter,
          ],
          responses: searchResponses,
        },
      },
      '/health': {
        get: {
          summary: 'Status',
          operationId: 'health',
          tags: ['Operations'],
          security: [{}],
          responses: {
            200: {
              description: 'Status of the server and the index.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } },
            },
          },
        },
      },
      '/metrics': {
        get: {
          summary: 'Prometheus metrics',
          operationId: 'metrics',
          tags: ['Operations'],
          security: config.metricsToken !== null ? [{ MetricsToken: [] }] : [{}],
          responses: {
            200: {
              description: 'Metrics in the Prometheus text format.',
              content: { 'text/plain': { schema: { type: 'string' } } },
            },
            ...(config.metricsToken !== null
              ? { 401: error('Missing or wrong METRICS_TOKEN.') }
              : {}),
          },
        },
      },
    },
    components: {
      schemas,
      securitySchemes: {
        ...securitySchemes,
        ...(config.metricsToken !== null
          ? { MetricsToken: { type: 'http', scheme: 'bearer' } }
          : {}),
      },
    },
  };
}
