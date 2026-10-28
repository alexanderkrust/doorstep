# Projekt: Self-hosted Autosuggest-API auf OSM-Basis

## Ziel

Adress-Autosuggest-API. Auslieferung als EIN Docker-Image.

## Harte Regeln

- Kein docker-compose, weder im Repo noch in der Doku. Nur ein Dockerfile.
- Keine externen Dienste (kein Elasticsearch, Typesense, Redis, Postgres).
- Index = SQLite (FTS5 + R*Tree), Datei liegt unter /data.
- Konfiguration nur per Umgebungsvariablen, validiert in src/config.
- TypeScript strict, Fastify, Vitest. Keine neuen Abhängigkeiten ohne Begründung.

## Befehle

- npm run dev | build | test | lint | typecheck
- npm run ci (lint, typecheck, test, build – vor jedem Commit)
- npm run import -- --region <url> (ab Phase 2)

## Struktur

- src/index.ts: CLI-Einstieg (`serve`, `import`)
- src/config: ENV-Schema (zod), `loadConfig(env)`; neue Variablen nur hier
- src/api: Fastify-Server (`buildServer(config)`), Routen unter src/api/routes
- src/import: OSM-Import (Phase 2)
- src/search: Such- und Ranking-Logik (Phase 3/4)
- test/: Vitest-Tests, API-Tests per `app.inject`
- docker/: Entrypoint und Hilfsskripte für das Dockerfile (Phase 5)

## Arbeitsweise

- Arbeite phasenweise gemäß ROADMAP.md, nur die jeweils genannte Phase.
- Schreibe zuerst Tests, dann Code. Eine Phase ist fertig, wenn ihr Kriterium "Fertig, wenn" erfüllt ist.
- Antwortformat der API: GeoJSON.
- OSM-Attribution (ODbL) muss in README und API-Antworten enthalten sein.
