import type { FastifyPluginAsync } from 'fastify';
import type { SearchIndex } from '../../search/search-index.js';
import { toFeatureCollection } from '../geojson.js';
import { DEFAULT_SEARCH_LIMIT, searchParams } from '../params.js';
import { queryIndex, sendBadRequest, sendCached } from '../replies.js';

export interface SearchRoutesOptions {
  index: SearchIndex;
  defaultLang: string;
}

/** `GET /api?q=&lat=&lon=&limit=&lang=` – Autosuggest. */
export const searchRoutes: FastifyPluginAsync<SearchRoutesOptions> = async (
  app,
  { index, defaultLang },
) => {
  app.get('/api', (request, reply) => {
    const parsed = searchParams.safeParse(request.query);
    if (!parsed.success) return sendBadRequest(reply, parsed.error);
    const { q, limit = DEFAULT_SEARCH_LIMIT, lat, lon, lang = defaultLang } = parsed.data;

    const rows = queryIndex(reply, () =>
      index.search({
        q,
        limit,
        ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}),
      }),
    );
    if (rows === null) return reply;
    return sendCached(reply, toFeatureCollection(rows, lang));
  });
  await Promise.resolve();
};
