import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config/index.js';

/** API-Key aus Header `X-API-Key` oder Query-Parameter `api_key`. */
function apiKeyOf(request: FastifyRequest): string | undefined {
  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header !== '') return header;
  const query = request.query as Record<string, unknown> | undefined;
  const param = query?.['api_key'];
  return typeof param === 'string' && param !== '' ? param : undefined;
}

/**
 * Rate-Limiting pro IP (RATE_LIMIT pro Minute) bzw. pro gültigem API-Key
 * (RATE_LIMIT_API_KEY pro Minute). Unbekannte Keys zählen wie Anfragen ohne Key.
 * Routen mit `config: { rateLimit: false }` (/health, /metrics) zählen nicht.
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
      message: `Zu viele Anfragen (höchstens ${String(context.max)} pro Minute). Erneut versuchen in ${context.after}.`,
    }),
  });
}
