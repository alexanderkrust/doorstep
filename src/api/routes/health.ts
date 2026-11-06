import type { FastifyPluginAsync } from 'fastify';
import type { IndexMode } from '../../config/index.js';
import { SCHEMA_VERSION } from '../../import/index-writer.js';
import { IndexUnavailableError, type SearchIndex } from '../../search/search-index.js';
import { ATTRIBUTION } from '../attribution.js';
import { VERSION } from '../version.js';

export interface HealthRoutesOptions {
  index: SearchIndex;
  /** Is an import running in the background? */
  importing: () => boolean;
  indexMode: IndexMode;
}

/**
 * Is a usable index available? An index with an old schema does not count; its
 * version is reported anyway, so that a mismatch is visible.
 */
function indexState(index: SearchIndex): { available: boolean; schemaVersion?: number } {
  try {
    if (!index.open()) return { available: false };
    const version = Number(index.meta()?.['schema_version']);
    return { available: true, ...(Number.isNaN(version) ? {} : { schemaVersion: version }) };
  } catch (err) {
    if (!(err instanceof IndexUnavailableError)) throw err;
    const found = err.foundSchemaVersion;
    return { available: false, ...(found === undefined ? {} : { schemaVersion: found }) };
  }
}

/** Answer of `/health`, also used in the OpenAPI document. */
export const healthResponseSchema = {
  type: 'object',
  required: ['status', 'version', 'uptime', 'index', 'importing', 'attribution'],
  properties: {
    status: { type: 'string', enum: ['ok'] },
    version: { type: 'string' },
    uptime: { type: 'number' },
    index: { type: 'boolean' },
    importing: { type: 'boolean' },
    attribution: { type: 'string' },
    importedAt: { type: 'string' },
    indexMode: { type: 'string', enum: ['build', 'mounted'] },
    /** Schema version this image reads. */
    schemaVersion: { type: 'integer' },
    /** Schema version of the index file, also when it does not match. */
    indexSchemaVersion: { type: 'integer' },
    /** Region or file the index was built from. */
    source: { type: 'string' },
    /** Result types in the index (INDEX_TYPES at import). */
    types: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (
  app,
  { index, importing, indexMode },
) => {
  app.get(
    '/health',
    {
      config: { rateLimit: false, public: true },
      schema: {
        response: {
          200: healthResponseSchema,
        },
      },
    },
    () => {
      const state = indexState(index);
      const available = state.available;
      const meta = available ? index.meta() : null;
      const importedAt = meta?.['imported_at'];
      const source = meta?.['source'];
      return {
        status: 'ok' as const,
        version: VERSION,
        uptime: process.uptime(),
        index: available,
        importing: importing(),
        attribution: ATTRIBUTION,
        ...(importedAt ? { importedAt } : {}),
        indexMode,
        schemaVersion: SCHEMA_VERSION,
        ...(state.schemaVersion === undefined ? {} : { indexSchemaVersion: state.schemaVersion }),
        ...(source ? { source } : {}),
        ...(meta?.['types'] ? { types: meta['types'].split(',') } : {}),
      };
    },
  );
  await Promise.resolve();
};
