import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { IndexUnavailableError } from '../search/search-index.js';
import { formatIssues } from './params.js';

/** Index ändert sich nur bei Updates; identische Anfragen dürfen gecacht werden. */
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
  message = 'Kein Index vorhanden. Bitte zuerst den Import ausführen.',
): FastifyReply {
  return reply.code(503).header('cache-control', 'no-store').send({
    statusCode: 503,
    error: 'Service Unavailable',
    message,
  });
}

/**
 * Führt eine Index-Abfrage aus. Fehlt der Index oder ist er nicht nutzbar, wird
 * 503 gesendet und `null` geliefert. Die Dauer geht in den Header `Server-Timing`.
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
