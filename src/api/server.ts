import cors from '@fastify/cors';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { Config } from '../config/index.js';
import { LruCache } from '../search/cache.js';
import { IndexUnavailableError, SearchIndex } from '../search/search-index.js';
import { InProcessSearch, SearchPool, type SearchBackend } from '../search/search-pool.js';
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
  // The server's own connection: /health, /metrics and noticing index swaps. Searches use it
  // too, unless they run in worker threads with their own connections (SEARCH_WORKERS).
  const index = new SearchIndex(config.indexPath);
  const search: SearchBackend =
    config.searchWorkers > 0
      ? new SearchPool(config.indexPath, config.searchWorkers)
      : new InProcessSearch(index);
  const cache = new LruCache<string, FeatureCollection>(config.cacheSize);
  if (config.searchWorkers > 0) {
    // Open now, before the workers: otherwise a swap before the first reload check would go
    // unnoticed here, and the workers would keep the old file.
    try {
      index.open();
    } catch (err) {
      if (!(err instanceof IndexUnavailableError)) throw err;
    }
  }

  app.decorate('reloadIndex', () => {
    try {
      // Searches in workers never open the server's connection; open it to notice a swap.
      if (!index.isOpen) index.open();
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
    // Workers switch a moment later; clear the cache again once they have, so that no answer
    // from the old index stays in it.
    search.reload().then(
      () => {
        cache.clear();
      },
      (err: unknown) => {
        app.log.error({ err }, 'Search workers could not load the new index');
      },
    );
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
  app.addHook('onClose', async () => {
    await search.close();
    index.close();
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
  void app.register(metricsRoutes, { index, metrics, token: config.metricsToken });
  void app.register(searchRoutes, {
    index: search,
    defaultLang: config.defaultLang,
    cache,
    metrics,
    cacheMaxAge: config.cacheMaxAge,
  });
  void app.register(reverseRoutes, {
    index: search,
    defaultLang: config.defaultLang,
    cacheMaxAge: config.cacheMaxAge,
  });

  return app;
}
