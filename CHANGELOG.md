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
- CI on GitHub Actions (checks, Docker smoke test, vulnerability scan) and a release workflow
  that publishes signed images with SBOM and provenance to the GitHub Container Registry.
