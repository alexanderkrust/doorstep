# Project: self-hosted autosuggest API based on OSM

## Goal

Address autosuggest API. Shipped as ONE Docker image.

## Hard rules

- No docker-compose, neither in the repo nor in the docs. Only a Dockerfile.
- No external services (no Elasticsearch, Typesense, Redis, Postgres).
- Index = SQLite (FTS5 + R\*Tree), the file lives under /data.
- Configuration only via environment variables, validated in src/config.
- TypeScript strict, Fastify, Vitest. No new dependencies without a reason.
- Everything technical is in English: code, comments, log and error messages, API responses,
  tests, docs, commit messages and PR descriptions.

## Commands

- npm run dev | build | test | lint | typecheck
- npm run ci (lint, typecheck, test, build – before every commit)
- npm run import -- --region <url> (from phase 2 on)

## Structure

- src/index.ts: CLI entry point (`serve`, `import`, `update`)
- src/config: env schema (zod), `loadConfig(env)`; new variables only here
- src/api: Fastify server (`buildServer(config)`), routes under src/api/routes
- src/import: OSM import (phase 2)
- src/search: search and ranking logic (phases 3/4)
- test/: Vitest tests, API tests via `app.inject`
- docker/: entry point and helper scripts for the Dockerfile (phase 5)

## Way of working

- Work phase by phase according to ROADMAP.md, only the phase named.
- Write tests first, then code. A phase is done when its "Done when" criterion is met.
- API response format: GeoJSON.
- OSM attribution (ODbL) must be in the README and in API responses.
