import type { FastifyPluginAsync } from 'fastify';
import type { SearchIndex } from '../../search/search-index.js';
import { toFeatureCollection } from '../geojson.js';
import { DEFAULT_REVERSE_RADIUS_KM, reverseParams } from '../params.js';
import { sendBadRequest, sendCached, sendNoIndex } from '../replies.js';

export interface ReverseRoutesOptions {
  index: SearchIndex;
}

/** `GET /reverse?lat=&lon=&limit=&radius=` – nächstes Objekt zum Punkt. */
export const reverseRoutes: FastifyPluginAsync<ReverseRoutesOptions> = async (app, { index }) => {
  app.get('/reverse', (request, reply) => {
    const parsed = reverseParams.safeParse(request.query);
    if (!parsed.success) return sendBadRequest(reply, parsed.error);
    const { lat, lon, limit = 1, radius = DEFAULT_REVERSE_RADIUS_KM } = parsed.data;

    const rows = index.reverse({ lat, lon, limit, radiusKm: radius });
    if (rows === null) return sendNoIndex(reply);
    return sendCached(reply, toFeatureCollection(rows));
  });
  await Promise.resolve();
};
