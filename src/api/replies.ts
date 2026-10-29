import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { IndexUnavailableError } from '../search/search-index.js';
import { formatIssues } from './params.js';

/** The index only changes on updates; identical requests may be cached. */
export const CACHE_MAX_AGE_SECONDS = 3600;

export function sendCached(reply: FastifyReply, body: unknown): FastifyReply {
  return reply
    .header('cache-control', `public, max-age=${String(CACHE_MAX_AGE_SECONDS)}`)
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
 * Runs an index query. If the index is missing or unusable, sends 503 and returns
 * `null`. The duration goes into the `Server-Timing` header.
 */
export function queryIndex<T>(reply: FastifyReply, run: () => T | null): T | null {
  const started = performance.now();
  let result: T | null;
  try {
    result = run();
  } catch (err) {
    if (err instanceof IndexUnavailableError) {
      reply.log.error(err.message);
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
