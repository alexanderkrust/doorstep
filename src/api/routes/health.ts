import type { FastifyPluginAsync } from 'fastify';
import { IndexUnavailableError, type SearchIndex } from '../../search/search-index.js';
import { ATTRIBUTION } from '../attribution.js';
import { VERSION } from '../version.js';

export interface HealthRoutesOptions {
  index: SearchIndex;
  /** Läuft gerade ein Import im Hintergrund? */
  importing: () => boolean;
}

/** Ist ein nutzbarer Index da? Ein Index mit altem Schema zählt nicht. */
function indexAvailable(index: SearchIndex): boolean {
  try {
    return index.open();
  } catch (err) {
    if (err instanceof IndexUnavailableError) return false;
    throw err;
  }
}

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (
  app,
  { index, importing },
) => {
  app.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['status', 'version', 'uptime', 'index', 'importing', 'attribution'],
            properties: {
              status: { type: 'string', enum: ['ok'] },
              version: { type: 'string' },
              uptime: { type: 'number' },
              index: { type: 'boolean' },
              importing: { type: 'boolean' },
              attribution: { type: 'string' },
            },
          },
        },
      },
    },
    () => ({
      status: 'ok' as const,
      version: VERSION,
      uptime: process.uptime(),
      index: indexAvailable(index),
      importing: importing(),
      attribution: ATTRIBUTION,
    }),
  );
  await Promise.resolve();
};
