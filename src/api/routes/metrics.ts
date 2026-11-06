import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { IndexUnavailableError, type SearchIndex } from '../../search/search-index.js';
import { METRICS_CONTENT_TYPE, type Metrics } from '../metrics.js';

export interface MetricsRoutesOptions {
  index: SearchIndex;
  metrics: Metrics;
  /** METRICS_TOKEN: required as `Authorization: Bearer <token>`; `null` = open. */
  token: string | null;
}

/** Compares in constant time, so the answer time does not give away the token. */
function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `GET /metrics` – metrics in Prometheus format. */
export const metricsRoutes: FastifyPluginAsync<MetricsRoutesOptions> = async (
  app,
  { index, metrics, token },
) => {
  app.get('/metrics', { config: { rateLimit: false } }, (request, reply) => {
    if (token !== null) {
      const header = request.headers.authorization ?? '';
      const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
      if (!sameToken(given, token)) {
        return reply
          .code(401)
          .header('www-authenticate', 'Bearer')
          .header('cache-control', 'no-store')
          .send({
            statusCode: 401,
            error: 'Unauthorized',
            message: 'METRICS_TOKEN is set: send it as "Authorization: Bearer <token>"',
          });
      }
    }
    let available: boolean;
    try {
      available = index.open();
    } catch (err) {
      if (!(err instanceof IndexUnavailableError)) throw err;
      available = false;
    }
    return reply
      .header('content-type', METRICS_CONTENT_TYPE)
      .header('cache-control', 'no-store')
      .send(metrics.render({ available, meta: index.meta() }));
  });
  await Promise.resolve();
};
