import { join } from 'node:path';
import cors from '@fastify/cors';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { Config } from '../config/index.js';
import { INDEX_FILE } from '../import/pipeline.js';
import { LruCache } from '../search/cache.js';
import { IndexUnavailableError, SearchIndex } from '../search/search-index.js';
import type { FeatureCollection } from './geojson.js';
import { Metrics } from './metrics.js';
import { registerRateLimit } from './rate-limit.js';
import { healthRoutes } from './routes/health.js';
import { metricsRoutes } from './routes/metrics.js';
import { reverseRoutes } from './routes/reverse.js';
import { searchRoutes } from './routes/search.js';

/** So oft prüft der Server, ob ein Update die Indexdatei ersetzt hat. */
export const DEFAULT_RELOAD_INTERVAL_MS = 5000;

export interface ServerOptions {
  /** Läuft gerade ein Import im Hintergrund? Erscheint in `/health`. */
  importing?: () => boolean;
  /**
   * Abstand, in dem die Indexdatei auf einen Tausch geprüft wird; 0 = nie
   * (Neuladen dann nur über `app.reloadIndex()`). Default: 0, `serve` setzt
   * `DEFAULT_RELOAD_INTERVAL_MS`.
   */
  reloadIntervalMs?: number;
  /** Kennzahlen; `serve` reicht eigene herein, um Updates mitzuzählen. */
  metrics?: Metrics;
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Wechselt auf eine neue Indexdatei, falls ein Update sie ersetzt hat, und
     * leert dann den Cache. `true` nach einem Wechsel.
     */
    reloadIndex(): boolean;
  }
}

/** Baut die Fastify-Instanz, ohne sie zu starten (testbar per inject). */
export function buildServer(config: Config, options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
    // Eigene, kompakte Zeile pro Anfrage (siehe onResponse), ohne Query-String:
    // Suchtexte sind oft Adressen und gehören nicht ins Log.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy,
  });

  const metrics = options.metrics ?? new Metrics();
  const index = new SearchIndex(join(config.dataDir, INDEX_FILE));
  const cache = new LruCache<string, FeatureCollection>(config.cacheSize);

  app.decorate('reloadIndex', () => {
    try {
      if (!index.reloadIfChanged()) return false;
    } catch (err) {
      if (!(err instanceof IndexUnavailableError)) throw err;
      metrics.indexReloadErrors++;
      app.log.error({ err }, 'Neuer Index ist unbrauchbar, der bisherige bleibt aktiv');
      return false;
    }
    cache.clear();
    metrics.indexReloads++;
    app.log.info({ index: index.meta() }, 'Neuer Index geladen');
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
    // Fehler (auch 404 und 429 der Plugins) nie cachen lassen.
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
      'Anfrage beantwortet',
    );
    done();
  });

  void app.register(cors, {
    origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins,
    methods: ['GET', 'HEAD', 'OPTIONS'],
  });
  registerRateLimit(app, config);
  void app.register(healthRoutes, { index, importing: options.importing ?? (() => false) });
  void app.register(metricsRoutes, { index, metrics });
  void app.register(searchRoutes, { index, defaultLang: config.defaultLang, cache, metrics });
  void app.register(reverseRoutes, { index, defaultLang: config.defaultLang });

  return app;
}
