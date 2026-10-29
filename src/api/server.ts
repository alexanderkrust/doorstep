import cors from '@fastify/cors';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { Config } from '../config/index.js';
import { LruCache } from '../search/cache.js';
import { IndexUnavailableError, SearchIndex } from '../search/search-index.js';
import type { FeatureCollection } from './geojson.js';
import { Metrics } from './metrics.js';
import { registerRateLimit } from './rate-limit.js';
import { healthRoutes } from './routes/health.js';
import { metricsRoutes } from './routes/metrics.js';
import { reverseRoutes } from './routes/reverse.js';
import { searchRoutes } from './routes/search.js';

/** How often the server checks whether an update replaced the index file. */
export const DEFAULT_RELOAD_INTERVAL_MS = 5000;

export interface ServerOptions {
  /** Is an import running in the background? Shown in `/health`. */
  importing?: () => boolean;
  /**
   * Interval for checking whether the index file was swapped; 0 = never
   * (reload only via `app.reloadIndex()`). Default: 0; `serve` sets
   * `DEFAULT_RELOAD_INTERVAL_MS`.
   */
  reloadIntervalMs?: number;
  /** Metrics; `serve` passes its own to count updates as well. */
  metrics?: Metrics;
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Switches to a new index file if an update replaced it, then clears the
     * cache. `true` after a switch.
     */
    reloadIndex(): boolean;
  }
}

/** Builds the Fastify instance without starting it (testable via inject). */
export function buildServer(config: Config, options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
    // One compact line per request (see onResponse), without the query string:
    // search texts are often addresses and do not belong in the log.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy,
  });

  const metrics = options.metrics ?? new Metrics();
  const index = new SearchIndex(config.indexPath);
  const cache = new LruCache<string, FeatureCollection>(config.cacheSize);

  app.decorate('reloadIndex', () => {
    try {
      if (!index.reloadIfChanged()) return false;
    } catch (err) {
      if (!(err instanceof IndexUnavailableError)) throw err;
      metrics.indexReloadErrors++;
      app.log.error({ err }, 'New index is unusable, keeping the current one');
      return false;
    }
    cache.clear();
    metrics.indexReloads++;
    app.log.info({ index: index.meta() }, 'Loaded new index');
    return true;
  });

  const interval = options.reloadIntervalMs ?? 0;
  if (interval > 0) {
    const timer = setInterval(() => app.reloadIndex(), interval);
    timer.unref();
    app.addHook('onClose', () => {
      clearInterval(timer);
      return Promise.resolve();
    });
  }
  app.addHook('onClose', () => {
    index.close();
    return Promise.resolve();
  });

  app.addHook('onSend', (_request, reply, payload, done) => {
    // Never let errors be cached (including 404 and 429 from plugins).
    if (reply.statusCode >= 400 && !reply.hasHeader('cache-control')) {
      void reply.header('cache-control', 'no-store');
    }
    done(null, payload);
  });

  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const seconds = reply.elapsedTime / 1000;
    metrics.observeRequest(request.method, route, reply.statusCode, seconds);
    request.log.info(
      {
        method: request.method,
        route,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime * 100) / 100,
        cache: reply.getHeader('x-cache'),
      },
      'Request answered',
    );
    done();
  });

  void app.register(cors, {
    origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins,
    methods: ['GET', 'HEAD', 'OPTIONS'],
  });
  registerRateLimit(app, config);
  void app.register(healthRoutes, {
    index,
    importing: options.importing ?? (() => false),
    indexMode: config.indexMode,
  });
  void app.register(metricsRoutes, { index, metrics });
  void app.register(searchRoutes, { index, defaultLang: config.defaultLang, cache, metrics });
  void app.register(reverseRoutes, { index, defaultLang: config.defaultLang });

  return app;
}
