import type { FastifyPluginAsync } from 'fastify';
import type { SearchIndex } from '../../search/search-index.js';
import { toFeatureCollection } from '../geojson.js';
import { DEFAULT_REVERSE_RADIUS_KM, reverseParams } from '../params.js';
import { queryIndex, sendBadRequest, sendCached } from '../replies.js';

export interface ReverseRoutesOptions {
  index: SearchIndex;
  defaultLang: string;
}

/** `GET /reverse?lat=&lon=&limit=&radius=&lang=` – nearest objects to a point. */
export const reverseRoutes: FastifyPluginAsync<ReverseRoutesOptions> = async (
  app,
  { index, defaultLang },
) => {
  app.get('/reverse', (request, reply) => {
    const parsed = reverseParams.safeParse(request.query);
    if (!parsed.success) return sendBadRequest(reply, parsed.error);
    const {
      lat,
      lon,
      limit = 1,
      radius = DEFAULT_REVERSE_RADIUS_KM,
      lang = defaultLang,
    } = parsed.data;

    const rows = queryIndex(reply, () => index.reverse({ lat, lon, limit, radiusKm: radius }));
    if (rows === null) return reply;
    return sendCached(reply, toFeatureCollection(rows, lang));
  });
  await Promise.resolve();
};
