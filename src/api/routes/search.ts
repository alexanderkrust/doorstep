import type { FastifyPluginAsync } from 'fastify';
import type { LruCache } from '../../search/cache.js';
import { normalizeTokens } from '../../search/normalize.js';
import type { SearchIndex } from '../../search/search-index.js';
import { toFeatureCollection, type FeatureCollection } from '../geojson.js';
import type { Metrics } from '../metrics.js';
import { DEFAULT_SEARCH_LIMIT, searchParams } from '../params.js';
import { queryIndex, sendBadRequest, sendCached } from '../replies.js';

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
    const { q, limit = DEFAULT_SEARCH_LIMIT, lat, lon, lang = defaultLang, types } = parsed.data;

    const started = performance.now();
    let cacheKey: string | undefined;
    if (cache.maxSize > 0) {
      // All queries, not just short ones: on large indexes, long queries with a location are
      // the most expensive. Frequent short prefixes stay in the LRU because they recur often.
      cacheKey = [
        normalizeTokens(q).join(' '),
        limit,
        lang,
        lat ?? '',
        lon ?? '',
        types?.join(',') ?? '',
      ].join('|');
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
    }

    const rows = queryIndex(reply, () =>
      index.search({
        q,
        limit,
        ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}),
        ...(types ? { types } : {}),
      }),
    );
    if (rows === null) return reply;
    const body = toFeatureCollection(
      rows,
      lang,
      lat !== undefined && lon !== undefined ? { lat, lon } : undefined,
    );
    if (cacheKey !== undefined) cache.set(cacheKey, body);
    return sendCached(reply, body);
  });
  await Promise.resolve();
};
