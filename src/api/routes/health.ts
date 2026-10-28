import type { FastifyPluginAsync } from 'fastify';
import { ATTRIBUTION } from '../attribution.js';
import { VERSION } from '../version.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['status', 'version', 'uptime', 'attribution'],
            properties: {
              status: { type: 'string', enum: ['ok'] },
              version: { type: 'string' },
              uptime: { type: 'number' },
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
      attribution: ATTRIBUTION,
    }),
  );
  await Promise.resolve();
};
