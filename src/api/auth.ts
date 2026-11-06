import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config/index.js';

/**
 * The configured API keys (API_KEYS), kept only as SHA-256 hashes. A lookup compares hashes,
 * so its time does not depend on how many leading characters of a guessed key are right, and
 * the rate limiter's store never holds a key in plain text.
 */
export class ApiKeys {
  private readonly hashes: Set<string>;

  constructor(
    keys: readonly string[],
    private readonly inQuery: boolean,
  ) {
    this.hashes = new Set(keys.map(hash));
  }

  /**
   * Hash of the request's key if it is valid, otherwise `null`. The key comes from the
   * `X-API-Key` header or, with API_KEY_IN_QUERY, from the `api_key` query parameter.
   */
  validKeyOf(request: FastifyRequest): string | null {
    const key = this.keyOf(request);
    if (key === undefined) return null;
    const hashed = hash(key);
    return this.hashes.has(hashed) ? hashed : null;
  }

  private keyOf(request: FastifyRequest): string | undefined {
    const header = request.headers['x-api-key'];
    if (typeof header === 'string' && header !== '') return header;
    if (!this.inQuery) return undefined;
    const query = request.query as Record<string, unknown> | undefined;
    const param = query?.['api_key'];
    return typeof param === 'string' && param !== '' ? param : undefined;
  }
}

function hash(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * With REQUIRE_API_KEY, every route except those with `config: { public: true }` (/health,
 * /metrics) answers 401 without a valid key. CORS preflights (OPTIONS) stay open: browsers
 * send them without custom headers. Runs as `preHandler`, after the rate limit, so that
 * guessing keys counts against the IP's quota.
 */
export function registerApiKeyCheck(app: FastifyInstance, config: Config, keys: ApiKeys): void {
  if (!config.requireApiKey) return;
  app.addHook('preHandler', async (request, reply) => {
    if (request.method === 'OPTIONS' || request.routeOptions.config.public === true) return;
    if (keys.validKeyOf(request) !== null) return;
    await reply
      .code(401)
      .header('www-authenticate', 'ApiKey')
      .header('cache-control', 'no-store')
      .send({
        statusCode: 401,
        error: 'Unauthorized',
        message: config.apiKeyInQuery
          ? 'A valid API key is required: send it as the X-API-Key header or the api_key parameter'
          : 'A valid API key is required: send it as the X-API-Key header',
      });
    return reply;
  });
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Reachable without an API key, also with REQUIRE_API_KEY. */
    public?: boolean;
  }
}
