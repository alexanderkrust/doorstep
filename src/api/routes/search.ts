import type { FastifyPluginAsync } from 'fastify';
import type { LruCache } from '../../search/cache.js';
import { normalizeTokens } from '../../search/normalize.js';
import type { SearchIndex } from '../../search/search-index.js';
import { toFeatureCollection, type FeatureCollection } from '../geojson.js';
import type { Metrics } from '../metrics.js';
import { DEFAULT_SEARCH_LIMIT, searchParams } from '../params.js';
import { queryIndex, sendBadRequest, sendCached } from '../replies.js';

/**
 * Nur kurze Anfragen gehen in den Cache: Sie kommen beim Tippen am häufigsten
 * vor und sind am teuersten (viele Kandidaten). Länge der normalisierten Anfrage.
 */
export const CACHE_MAX_QUERY_LENGTH = 10;

export interface SearchRoutesOptions {
  index: SearchIndex;
  defaultLang: string;
  cache: LruCache<string, FeatureCollection>;
  metrics: Metrics;
}

/** `GET /api?q=&lat=&lon=&limit=&lang=` – Autosuggest. */
export const searchRoutes: FastifyPluginAsync<SearchRoutesOptions> = async (
  app,
  { index, defaultLang, cache, metrics },
) => {
  app.get('/api', (request, reply) => {
    const parsed = searchParams.safeParse(request.query);
    if (!parsed.success) return sendBadRequest(reply, parsed.error);
    const { q, limit = DEFAULT_SEARCH_LIMIT, lat, lon, lang = defaultLang } = parsed.data;

    const started = performance.now();
    let cacheKey: string | undefined;
    if (cache.maxSize > 0) {
      const normalized = normalizeTokens(q).join(' ');
      if (normalized.length <= CACHE_MAX_QUERY_LENGTH) {
        cacheKey = [normalized, limit, lang, lat ?? '', lon ?? ''].join('|');
        const hit = cache.get(cacheKey);
        if (hit) {
          metrics.cacheHits++;
          return sendCached(
            reply
              .header('x-cache', 'HIT')
              .header('server-timing', `search;dur=${(performance.now() - started).toFixed(2)}`),
            hit,
          );
        }
        metrics.cacheMisses++;
        void reply.header('x-cache', 'MISS');
      } else {
        void reply.header('x-cache', 'BYPASS');
      }
    }

    const rows = queryIndex(reply, () =>
      index.search({
        q,
        limit,
        ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}),
      }),
    );
    if (rows === null) return reply;
    const body = toFeatureCollection(rows, lang);
    if (cacheKey !== undefined) cache.set(cacheKey, body);
    return sendCached(reply, body);
  });
  await Promise.resolve();
};
