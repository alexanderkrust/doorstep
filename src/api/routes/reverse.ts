import type { FastifyPluginAsync } from 'fastify';
import type { SearchBackend } from '../../search/search-pool.js';
import { toFeatureCollection } from '../geojson.js';
import { DEFAULT_REVERSE_RADIUS_KM, reverseParams } from '../params.js';
import { queryIndex, sendBadRequest, sendCached } from '../replies.js';

export interface ReverseRoutesOptions {
  /** Searches in the main thread or in worker threads (SEARCH_WORKERS). */
  index: SearchBackend;
  defaultLang: string;
  /** CACHE_MAX_AGE in seconds. */
  cacheMaxAge: number;
}

/** `GET /reverse?lat=&lon=&limit=&radius=&lang=` – nearest objects to a point. */
export const reverseRoutes: FastifyPluginAsync<ReverseRoutesOptions> = async (
  app,
  { index, defaultLang, cacheMaxAge },
) => {
  app.get('/reverse', async (request, reply) => {
    const parsed = reverseParams.safeParse(request.query);
    if (!parsed.success) return sendBadRequest(reply, parsed.error);
    const {
      lat,
      lon,
      limit = 1,
      radius = DEFAULT_REVERSE_RADIUS_KM,
      lang = defaultLang,
      types,
    } = parsed.data;

    const rows = await queryIndex(reply, () =>
      index.reverse({ lat, lon, limit, radiusKm: radius, ...(types ? { types } : {}) }),
    );
    if (rows === null) return reply;
    return sendCached(reply, toFeatureCollection(rows, lang, { lat, lon }), cacheMaxAge);
  });
  await Promise.resolve();
};
