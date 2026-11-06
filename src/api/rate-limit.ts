import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config/index.js';
import type { ApiKeys } from './auth.js';

/**
 * Rate limiting per IP (RATE_LIMIT per minute) or per valid API key
 * (RATE_LIMIT_API_KEY per minute). Unknown keys count like requests without a key.
 * Routes with `config: { rateLimit: false }` (/health, /metrics) do not count.
 */
export function registerRateLimit(app: FastifyInstance, config: Config, keys: ApiKeys): void {
  if (!config.rateLimitEnabled || config.rateLimit === 0) return;

  void app.register(rateLimit, {
    global: true,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      const key = keys.validKeyOf(request);
      return key !== null ? `key:${key}` : `ip:${request.ip}`;
    },
    max: (_request, key) => (key.startsWith('key:') ? config.apiKeyRateLimit : config.rateLimit),
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Too many requests (at most ${String(context.max)} per minute). Retry in ${context.after}.`,
    }),
  });
}
