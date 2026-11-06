import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';

export interface DocsRoutesOptions {
  /** The OpenAPI document for `/openapi.json`. */
  document: Record<string, unknown>;
}

/** Swagger UI's files come from the package in node_modules: no CDN, works offline. */
const SWAGGER_UI_DIR = dirname(
  createRequire(import.meta.url).resolve('swagger-ui-dist/swagger-ui-bundle.js'),
);

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>doorstep API</title>
    <link rel="stylesheet" href="/docs/swagger-ui.css" />
    <link rel="icon" type="image/png" href="/docs/favicon-32x32.png" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/docs/swagger-ui-bundle.js"></script>
    <script src="/docs/init.js"></script>
  </body>
</html>
`;

/** A separate file instead of an inline script, so the page works with `script-src 'self'`. */
const INIT = `window.ui = SwaggerUIBundle({
  url: '/openapi.json',
  dom_id: '#swagger-ui',
  deepLinking: true,
  tryItOutEnabled: true,
});
`;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Swagger UI sets styles inline and shows images as data URLs.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

const FILES: Record<string, { type: string; read: () => Buffer | string }> = {
  'swagger-ui-bundle.js': {
    type: 'application/javascript; charset=utf-8',
    read: () => readFileSync(join(SWAGGER_UI_DIR, 'swagger-ui-bundle.js')),
  },
  'swagger-ui.css': {
    type: 'text/css; charset=utf-8',
    read: () => readFileSync(join(SWAGGER_UI_DIR, 'swagger-ui.css')),
  },
  'favicon-32x32.png': {
    type: 'image/png',
    read: () => readFileSync(join(SWAGGER_UI_DIR, 'favicon-32x32.png')),
  },
  'init.js': { type: 'application/javascript; charset=utf-8', read: () => INIT },
};

/** Files are read on first use and then kept in memory (about 1.9 MB). */
const loaded = new Map<string, Buffer | string>();

/**
 * `GET /openapi.json` – the API description; `GET /docs` – Swagger UI for it. Both are open
 * also with REQUIRE_API_KEY: they describe the API, the searches themselves still need a key.
 */
export const docsRoutes: FastifyPluginAsync<DocsRoutesOptions> = async (app, { document }) => {
  const body = JSON.stringify(document);

  app.get('/openapi.json', { config: { public: true } }, (_request, reply) =>
    reply
      .type('application/json; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .send(body),
  );

  app.get('/docs', { config: { public: true } }, (_request, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .header('content-security-policy', CSP)
      .header('cache-control', 'public, max-age=300')
      .send(PAGE),
  );

  app.get<{ Params: { file: string } }>(
    '/docs/:file',
    { config: { public: true } },
    (request, reply) => {
      const { file } = request.params;
      const entry = Object.hasOwn(FILES, file) ? FILES[file] : undefined;
      if (!entry) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Route GET:${request.url} not found`,
        });
      }
      let content = loaded.get(file);
      if (content === undefined) {
        content = entry.read();
        loaded.set(file, content);
      }
      return reply.type(entry.type).header('cache-control', 'public, max-age=86400').send(content);
    },
  );
  await Promise.resolve();
};
