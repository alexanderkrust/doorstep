import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { IndexUnavailableError } from '../search/search-index.js';
import { SearchOverloadedError, SearchTimeoutError } from '../search/search-pool.js';
import type { Metrics } from './metrics.js';
import { formatIssues } from './params.js';

/**
 * The index only changes on updates; identical requests may be cached by clients and CDNs
 * for `maxAgeSeconds` (CACHE_MAX_AGE). 0 forbids it.
 */
export function sendCached(
  reply: FastifyReply,
  body: unknown,
  maxAgeSeconds: number,
): FastifyReply {
  return reply
    .header(
      'cache-control',
      maxAgeSeconds > 0 ? `public, max-age=${String(maxAgeSeconds)}` : 'no-store',
    )
    .send(body);
}

export function sendBadRequest(reply: FastifyReply, error: z.ZodError): FastifyReply {
  return reply
    .code(400)
    .header('cache-control', 'no-store')
    .send({
      statusCode: 400,
      error: 'Bad Request',
      message: formatIssues(error),
    });
}

export function sendNoIndex(
  reply: FastifyReply,
  message = 'No index available. Please run the import first.',
): FastifyReply {
  return reply.code(503).header('cache-control', 'no-store').send({
    statusCode: 503,
    error: 'Service Unavailable',
    message,
  });
}

/**
 * Runs an index query (in the main thread or in a search worker). If the index is missing or
 * unusable, or the search workers are overloaded or too slow, sends 503 and returns `null`.
 * The duration goes into the `Server-Timing` header.
 */
export async function queryIndex<T>(
  reply: FastifyReply,
  metrics: Metrics,
  run: () => Promise<T | null>,
): Promise<T | null> {
  const started = performance.now();
  let result: T | null;
  try {
    result = await run();
  } catch (err) {
    if (err instanceof IndexUnavailableError) {
      reply.log.error(err.message);
      void sendNoIndex(reply, err.message);
      return null;
    }
    if (err instanceof SearchTimeoutError || err instanceof SearchOverloadedError) {
      const reason = err instanceof SearchTimeoutError ? 'timeout' : 'overloaded';
      metrics.searchRejected[reason]++;
      reply.log.warn({ reason }, err.message);
      void reply.header('retry-after', '1');
      void sendNoIndex(reply, err.message);
      return null;
    }
    throw err;
  }
  if (result === null) {
    void sendNoIndex(reply);
    return null;
  }
  void reply.header('server-timing', `search;dur=${(performance.now() - started).toFixed(2)}`);
  return result;
}
