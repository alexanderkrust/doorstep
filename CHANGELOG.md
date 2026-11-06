# Changelog

All notable changes to doorstep. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[Semantic Versioning](https://semver.org/). Every release names the index schema version it
reads; an image only serves an index with that schema (see "Using a prebuilt index" in the
README).

To release, rename `Unreleased` to the new version with the date, set the same `version` in
`package.json`, commit, and push the tag `v<version>` (see "Releases" in the README).

## [Unreleased]

First version. Index schema 11.

### Added

- Autosuggest `GET /api` and reverse geocoding `GET /reverse` as GeoJSON, with labels, a
  structured address, result types, location bias and the OSM attribution in every answer.
- Import from a Geofabrik extract with osmium into SQLite (FTS5 and R\*Tree), with boundaries
  for country, state, city, district and postcode; `INDEX_TYPES` and the `types` parameter.
- Updates without downtime: atomic index swap, `UPDATE_CRON`, daily diff updates
  (`DIFF_UPDATES`), and a prebuilt, read-only mounted index (`INDEX_MODE=mounted`).
- Search in worker threads (`SEARCH_WORKERS`), LRU cache, `CACHE_MAX_AGE`.
- Operations: rate limiting per IP and per API key, `/health`, Prometheus `/metrics` with
  optional `METRICS_TOKEN`, JSON logs without search texts.
- Security: `REQUIRE_API_KEY`, `API_KEY_IN_QUERY`, keys kept as SHA-256 hashes, `q` limited to
  200 characters, startup warnings for risky settings.
- Timeouts and overload: `DOWNLOAD_TIMEOUT_MS`, `SEARCH_TIMEOUT_MS`, `SEARCH_QUEUE_LIMIT`,
  `REQUEST_TIMEOUT_MS`, `SHUTDOWN_TIMEOUT_MS`; metric `doorstep_search_rejected_total`.
- `IMPORT_NODE_INDEX=file` keeps the node locations of `osmium export` on disk instead of in
  memory, for imports on machines with little RAM. Errors of osmium name the signal that ended
  it, with a hint to memory for `SIGKILL`.
- Disk space during the import: a warning before it starts when less than about 4 times the
  extract's size is free, `DiskFullError` naming the directory and the free space instead of
  SQLite's `database or disk is full`, SQLite's sort files next to the index instead of in
  `/tmp`, and the filtered extract deleted as soon as osmium is done.
- Lookahead search: if the query finds nothing with the earlier words exact, they are searched
  as prefixes too (`gneis 62 düss` → Gneisenaustraße 62, Düsseldorf). House numbers before the
  end and words under 3 characters stay exact.
- SymSpell for the typo tolerance: up to 2 edits from 7 letters, 1 edit from 4 letters, also for
  partly typed words (`gxexsenau 62 düss`, `zeli 106 frankfurt`). The import adds the table
  `fuzzy_deletes`; older indexes keep working with 1 edit from 5 letters. `/health` reports
  `fuzzy`.
- Typo tolerance in every word: when nothing else finds a hit, words of at least 5 letters
  that are not in the index are replaced by the words one edit away (`gnies 62 düs` →
  Gneisenaustraße 62, Düsseldorf). House numbers and postcodes are never corrected.
- API documentation: Swagger UI under `/docs` and an OpenAPI 3.1 document under
  `/openapi.json` that follows the configuration (API key, default language);
  `DOCS_ENABLED`. Swagger UI comes with the image, without a CDN.
- CI on GitHub Actions (checks, Docker smoke test, vulnerability scan) and a release workflow
  that publishes signed images with SBOM and provenance to the GitHub Container Registry.
