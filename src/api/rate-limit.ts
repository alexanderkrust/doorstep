import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config/index.js';

/** API key from the `X-API-Key` header or the `api_key` query parameter. */
function apiKeyOf(request: FastifyRequest): string | undefined {
  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header !== '') return header;
  const query = request.query as Record<string, unknown> | undefined;
  const param = query?.['api_key'];
  return typeof param === 'string' && param !== '' ? param : undefined;
}

/**
 * Rate limiting per IP (RATE_LIMIT per minute) or per valid API key
 * (RATE_LIMIT_API_KEY per minute). Unknown keys count like requests without a key.
 * Routes with `config: { rateLimit: false }` (/health, /metrics) do not count.
 */
export function registerRateLimit(app: FastifyInstance, config: Config): void {
  if (!config.rateLimitEnabled || config.rateLimit === 0) return;
  const keys = new Set(config.apiKeys);

  void app.register(rateLimit, {
    global: true,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      const key = apiKeyOf(request);
      return key !== undefined && keys.has(key) ? `key:${key}` : `ip:${request.ip}`;
    },
    max: (_request, key) => (key.startsWith('key:') ? config.apiKeyRateLimit : config.rateLimit),
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Too many requests (at most ${String(context.max)} per minute). Retry in ${context.after}.`,
    }),
  });
}
