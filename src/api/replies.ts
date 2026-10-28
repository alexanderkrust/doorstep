import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
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

export function sendNoIndex(reply: FastifyReply): FastifyReply {
  return reply.code(503).header('cache-control', 'no-store').send({
    statusCode: 503,
    error: 'Service Unavailable',
    message: 'Kein Index vorhanden. Bitte zuerst den Import ausführen.',
  });
}
