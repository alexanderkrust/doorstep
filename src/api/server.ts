import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config/index.js';
import { healthRoutes } from './routes/health.js';

/** Baut die Fastify-Instanz, ohne sie zu starten (testbar per inject). */
export function buildServer(config: Config): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
  });

  void app.register(healthRoutes);

  return app;
}
