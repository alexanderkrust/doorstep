import type { FastifyPluginAsync } from 'fastify';
import { IndexUnavailableError, type SearchIndex } from '../../search/search-index.js';
import { METRICS_CONTENT_TYPE, type Metrics } from '../metrics.js';

export interface MetricsRoutesOptions {
  index: SearchIndex;
  metrics: Metrics;
}

/** `GET /metrics` – Kennzahlen im Prometheus-Format. */
export const metricsRoutes: FastifyPluginAsync<MetricsRoutesOptions> = async (
  app,
  { index, metrics },
) => {
  app.get('/metrics', { config: { rateLimit: false } }, (_request, reply) => {
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
