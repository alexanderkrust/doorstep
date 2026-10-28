import type { FastifyPluginAsync } from 'fastify';
import type { SearchIndex } from '../../search/search-index.js';
import { toFeatureCollection } from '../geojson.js';
import { DEFAULT_SEARCH_LIMIT, searchParams } from '../params.js';
import { sendBadRequest, sendCached, sendNoIndex } from '../replies.js';

export interface SearchRoutesOptions {
  index: SearchIndex;
}

/** `GET /api?q=&lat=&lon=&limit=&lang=` – Autosuggest. */
export const searchRoutes: FastifyPluginAsync<SearchRoutesOptions> = async (app, { index }) => {
  app.get('/api', (request, reply) => {
    const parsed = searchParams.safeParse(request.query);
    if (!parsed.success) return sendBadRequest(reply, parsed.error);
    // `lang` wird validiert, aber erst in Phase 4 (name:de, name:en, …) ausgewertet.
    const { q, limit = DEFAULT_SEARCH_LIMIT, lat, lon } = parsed.data;

    const rows = index.search({
      q,
      limit,
      ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}),
    });
    if (rows === null) return sendNoIndex(reply);
    return sendCached(reply, toFeatureCollection(rows));
  });
  await Promise.resolve();
};
