import { join } from 'node:path';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config/index.js';
import { INDEX_FILE } from '../import/pipeline.js';
import { SearchIndex } from '../search/search-index.js';
import { healthRoutes } from './routes/health.js';
import { reverseRoutes } from './routes/reverse.js';
import { searchRoutes } from './routes/search.js';

export interface ServerOptions {
  /** Läuft gerade ein Import im Hintergrund? Erscheint in `/health`. */
  importing?: () => boolean;
}

/** Baut die Fastify-Instanz, ohne sie zu starten (testbar per inject). */
export function buildServer(config: Config, options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
  });

  const index = new SearchIndex(join(config.dataDir, INDEX_FILE));
  app.addHook('onClose', () => {
    index.close();
    return Promise.resolve();
  });

  void app.register(cors, {
    origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins,
    methods: ['GET', 'HEAD', 'OPTIONS'],
  });
  void app.register(healthRoutes, { index, importing: options.importing ?? (() => false) });
  void app.register(searchRoutes, { index, defaultLang: config.defaultLang });
  void app.register(reverseRoutes, { index, defaultLang: config.defaultLang });

  return app;
}
