# doorstep

Self-hosted, address autosuggest API based on OpenStreetMap.
One Docker image, no external services: the index is a SQLite file (FTS5 + R\*Tree) under `/data`.

Data: © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).
Every API response contains this notice in the `attribution` field.

> Status: phase 6 (updates and operations). See [ROADMAP.md](ROADMAP.md).

## Contents

- [Quick start](#quick-start)
- [System requirements](#system-requirements)
- [Operations](#operations)
  - [Updates without downtime](#updates-without-downtime)
  - [Using a prebuilt index](#using-a-prebuilt-index)
  - [Choosing what is searchable](#choosing-what-is-searchable)
  - [Rate limiting and API keys](#rate-limiting-and-api-keys)
  - [Timeouts and overload](#timeouts-and-overload)
  - [Cache](#cache)
  - [Logs](#logs)
  - [Metrics](#metrics)
  - [Healthcheck](#healthcheck)
- [Configuration (environment variables)](#configuration-environment-variables)
- [API](#api)
  - [`GET /api` – autosuggest](#get-api--autosuggest)
  - [`GET /reverse` – nearest object to a point](#get-reverse--nearest-object-to-a-point)
  - [Other endpoints](#other-endpoints)
- [Docker](#docker)
  - [Commands](#commands)
  - [Smoke test](#smoke-test)
- [CI and releases](#ci-and-releases)
- [Load test](#load-test)
- [Search quality and latency](#search-quality-and-latency)
- [Development](#development)
- [Import](#import)
- [Data license](#data-license)

## Quick start

Requirement: Docker. Nothing else, no docker-compose either.

```bash
docker build -t doorstep-api .
docker run -d --name doorstep --restart unless-stopped \
  -p 2322:2322 -v data:/data doorstep-api
```

On the first start there is no index in the volume yet. The API starts right away anyway,
downloads the extract from `REGION_URL` in the background (default: Germany, about 4.5 GB) and
builds the index. Until then `/api` answers `503`, also after the download: indexing the Germany
extract takes about half an hour. `docker logs -f doorstep` and `/health`
(`"index": false, "importing": true`) show the progress. The log names every step with its number
and duration and reports long steps every 15 seconds:

```text
Step 4/5: Reading features (osmium export)
Reading features: 1,850,098 (123,340/s), currently ways
Step 5/5: Building the index (sorting, assigning streets, search index)
Assigning streets: 1,200,000 / 4,170,155 (28 %), about 3 min 10 s left
Building search index: 18,000,000 / 25,568,099 (70 %), about 2 min 5 s left
```

While reading the features, the total is unknown in advance (osmium delivers them as a stream);
there the log shows the count, the rate and the object type currently being read (nodes first,
then ways, then relations). After that the API returns suggestions:

```bash
curl 'http://localhost:2322/api?q=K%C3%B6nigsall&limit=3'
```

For a quick test, pick a smaller region (Bremen: 21 MB, import in seconds):

```bash
docker run -d --name doorstep -p 2322:2322 -v data-bremen:/data \
  -e REGION_URL=https://download.geofabrik.de/europe/germany/bremen-latest.osm.pbf \
  doorstep-api
```

The automatic import only runs while the volume contains no index. For a different region, use a
new volume or run `import --region <url>` (see [Commands](#commands)).

A typical production start with a daily update at 3 am (UTC), an API key for your own frontend,
and running behind a reverse proxy:

```bash
docker run -d --name doorstep --restart unless-stopped \
  -p 127.0.0.1:2322:2322 -v data:/data \
  -e UPDATE_CRON='0 3 * * *' \
  -e TRUST_PROXY=true \
  -e RATE_LIMIT=60 \
  -e API_KEYS=a-long-random-key \
  -e RATE_LIMIT_API_KEY=1200 \
  -e CORS_ORIGINS=https://www.example.com \
  -e METRICS_TOKEN=a-long-random-metrics-token \
  doorstep-api
```

At startup, `serve` logs a warning for each setting that is risky in public operation: an open
`/metrics` (no `METRICS_TOKEN`), rate limiting turned off, and `CORS_ORIGINS=*`.

## System requirements

Guide values for the Germany extract. Only the Düsseldorf administrative region was measured
(217 MB PBF → 389 MB index); the values for Germany are extrapolated from it.

| Resource          | Germany (estimate)                     | Note                                                                                                                                                                                                        |
| ----------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disk (volume)     | **at least 30 GB free**                | Extract about 4.9 GB, index about 10 GB. During an update, the filtered intermediate file, `index.next.sqlite` and its staging file are on the volume as well, and while diffs are applied a second extract |
| RAM, API          | 1 GB for the process, **better 8 GB+** | The process itself needs little; SQLite reads the index from disk. For response times below 50 ms, the index should fit into the system's page cache                                                        |
| RAM, import       | **4–8 GB**                             | `osmium export` keeps the node coordinates in memory; the import runs as a separate process next to the API. With less, set `IMPORT_NODE_INDEX=file` (see [Import](#import))                                |
| CPU               | 2 cores, more for more throughput      | Searches run in worker threads, one per core except the main thread's (`SEARCH_WORKERS`); import and update run as a separate process                                                                       |
| First import time | about 15–30 min plus download          | Düsseldorf administrative region: 45 s for 1.4 million entries                                                                                                                                              |

## Operations

### Updates without downtime

An update brings the extract up to date with the daily diffs (see below), builds
`index.next.sqlite` next to the running index and replaces `index.sqlite` with an atomic `rename`.
Until then the API keeps reading the old index unchanged. Every 5 seconds it checks whether a new
file lies at `index.sqlite`, opens it, switches over and clears the cache. No restart, no failed
requests. If the new file is unusable, the old index stays active and the log shows an error.

Two ways to trigger an update:

```bash
# Automatically on a schedule (cron format, container time zone, default UTC)
docker run … -e UPDATE_CRON='0 3 * * *' doorstep-api

# By hand in the running container
docker exec doorstep doorstep update
```

- `UPDATE_CRON` understands five fields (minute, hour, day, month, weekday) with `*`, numbers,
  lists (`1,15`), ranges (`1-5`) and steps (`*/15`). Names like `mon` do not work.
  Different time zone: `-e TZ=Europe/Berlin`.
- Never more than one import at a time: a file lock on `/data/import.lock.sqlite` keeps a
  scheduled and a manual update from getting in each other's way. The second one stops with exit
  code 75 and a message. When the importing process ends, the operating system releases the lock
  immediately, even if the container is replaced in the middle of an import. The file itself stays
  and never needs to be deleted. An `import.lock` from older versions is removed on the next
  import. The volume must support POSIX file locks (local Docker volume or bind mount, not NFS).
- Reload right away instead of waiting up to 5 seconds: `docker kill -s HUP doorstep`.
- Checking: `/health` shows in `importedAt` when the active index was built; `/metrics` counts
  `doorstep_index_reloads_total` and `doorstep_updates_total`.

Geofabrik updates the extracts daily; a daily or weekly update is enough.

**Diff updates** (`DIFF_UPDATES`, on by default): instead of downloading the whole extract again
(Germany 4.9 GB), `update` loads only the daily change files that Geofabrik publishes for every
extract (Germany about 5.6 MB per day) and applies them with `osmium apply-changes`. Where they
are and which sequence number the extract has comes from its PBF header
(`osmosis_replication_base_url`, `osmosis_replication_sequence_number`).

- Nothing new on the server: the update ends after one request for `state.txt`, without a
  rebuild, if the index was built from the same state of the extract with the current schema
  and `INDEX_TYPES` (`Index … is up to date, nothing to rebuild`). `import` always rebuilds.
- The whole extract is downloaded instead when it has no replication header, `REGION_URL`
  changed, more than 30 diffs are missing, the last full download is older than 30 days (applied
  diffs can drift slightly from a fresh extract, mostly at the region's border), or downloading or
  applying a diff fails. The old extract stays until the new one is complete; the date of the
  last full download is in `extract.state.json`.
- Applying the diffs writes a new extract next to the old one (Germany about 5 GB more for a
  short time). Measured on the Düsseldorf administrative region (217 MB): one daily diff of
  0.2 MB downloaded in 0.4 s and applied in 3.3 s.

### Using a prebuilt index

The index can be built somewhere else (another machine, a CI job) and mounted into the container.
With `INDEX_MODE=mounted`, the container only serves it: no download, no import, no scheduled
update. That saves the import on every machine (Germany: about 34 min, 3.3 GB RAM) and works
without internet access.

```bash
# 1. Build the index once (writes ./index/index.sqlite, about 10 GB for Germany)
docker run --rm -v "$PWD/index:/data" doorstep-api import

# 2. Serve it, read-only
docker run -p 2322:2322 -v "$PWD/index:/index:ro" \
  -e INDEX_MODE=mounted -e INDEX_PATH=/index/index.sqlite doorstep-api
```

- **Mount the directory, not the file.** With `-v ./index/index.sqlite:/…`, Docker pins the file
  that existed at the start; a file replaced on the host later is not visible in the container.
- **Updating:** build the new index next to the old one in the same directory and swap it with
  `mv` (atomic on the same filesystem). The API loads it within 5 seconds, right away after
  `docker kill -s HUP <container>`. Never use `cp` onto the live file: that changes it while
  queries are reading it.
  ```bash
  docker run --rm -v "$PWD/next:/data" doorstep-api import
  mv next/index.sqlite index/index.next.sqlite && mv index/index.next.sqlite index/index.sqlite
  ```
  `next/` and `index/` must be on the same filesystem for the last `mv` to be atomic.
- **Schema version:** the index must have been built by an image with the same schema version (see
  `schemaVersion` and `indexSchemaVersion` in `/health`). With a mismatch the container stops at
  startup with an error naming both versions. Pin the image tag that built the index.
- **Missing file:** the container starts anyway, logs a warning and answers `503` until the file
  appears.
- `UPDATE_CRON` is rejected with `INDEX_MODE=mounted`, and `import`/`update` refuse to run unless
  `--force` is given. `AUTO_IMPORT` is ignored; `REGION_URL` is not needed.
- Works with a read-only container (`docker run --read-only`); nothing is written.
- Several containers can share one mounted index. Keep it on a local disk: SQLite on NFS/SMB is
  slow and unreliable.

### Choosing what is searchable

What can be found is set on two levels, both with the result types of the response (`type`):
`address`, `street`, `poi`, `locality` (city, town, village), `sublocality` (district),
`place` (other named places).

- **`INDEX_TYPES` at import:** only these types end up in the index. For an API that only
  suggests streets:

  ```bash
  docker run -p 2322:2322 -v data:/data -e INDEX_TYPES=street doorstep-api
  ```

  The index gets much smaller (most entries are addresses) and searches have fewer candidates.
  The import still reads everything: streets take their city and postcode from the addresses
  and boundaries before the addresses are dropped, so the import time barely changes. A change
  of `INDEX_TYPES` applies with the next `import` or `update`; until then the container warns at
  startup. `/health` shows the types of the active index in `types`. With
  `INDEX_MODE=mounted`, the mounted index decides.

- **`types` per request:** `/api?q=Kö&types=street,poi` and `/reverse?…&types=street` return only
  these types, within what the index holds. The filter is part of the full-text query, so it
  does not lose hits that more important ones would push out of the candidates. Unknown values
  return `400`.

### Rate limiting and API keys

- Without an API key: at most `RATE_LIMIT` requests per minute and IP on `/api` and `/reverse`.
- With a valid API key (header `X-API-Key: <key>` or parameter `api_key=<key>`): at most
  `RATE_LIMIT_API_KEY` requests per minute and key, regardless of the IP. Unknown keys count like
  requests without a key.
- **Requiring a key:** with `REQUIRE_API_KEY=true`, `/api` and `/reverse` answer `401` (with
  `WWW-Authenticate: ApiKey`) unless the request carries a key from `API_KEYS`. `/health`,
  `/metrics` and CORS preflights stay open. Requests without a valid key still count against the
  rate limit of their IP, so guessing keys is slowed down. Answers then carry
  `Cache-Control: private`, so that a CDN or proxy does not hand them to clients without a key.
  This protects server-to-server use; a key in a browser frontend is visible to every visitor.
- **Keys in the URL:** URLs end up in the logs of proxies, CDNs and browsers. With
  `API_KEY_IN_QUERY=false`, only the `X-API-Key` header is accepted.
- The server keeps only SHA-256 hashes of the keys in memory and compares those.
- Above that, the API answers `429` with `Retry-After`. Every response carries
  `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`.
- `/health` and `/metrics` do not count.
- Turning it off: `RATE_LIMIT_ENABLED=false` (or `RATE_LIMIT=0`).
- **Behind a reverse proxy** (nginx, Traefik, Caddy), set `TRUST_PROXY=true`; otherwise all
  requests count for the proxy's IP. Without a proxy, leave `TRUST_PROXY` off; otherwise any
  client can claim any IP via `X-Forwarded-For`.

The counters live in the process's memory and start over after a restart.

### Timeouts and overload

- **Searches** (only with worker threads, `SEARCH_WORKERS` ≥ 1): a search that has not been
  answered after `SEARCH_TIMEOUT_MS` (default 2000, waiting in the queue included) gets `503`.
  If every worker already has `SEARCH_QUEUE_LIMIT` searches pending (default 100), new ones get
  `503` right away instead of waiting ever longer. Both answers carry `Retry-After: 1` and count
  in `doorstep_search_rejected_total{reason="timeout|overloaded"}`. SQLite cannot cancel a running
  query: the worker finishes it and drops the answer. In the main thread (`SEARCH_WORKERS=0`) there
  is neither a timeout nor a queue limit.
- **Clients** have `REQUEST_TIMEOUT_MS` (default 10,000) to send their request; slow clients
  cannot hold connections open.
- **Shutdown:** after `SIGTERM`, open requests get `SHUTDOWN_TIMEOUT_MS` (default 10,000); then
  the process ends with exit code 1. Keep it below the orchestrator's grace period (Docker: 10 s
  with `docker stop`, Kubernetes: 30 s).
- **Downloads** of the extract, its `.md5`, the replication state and the diffs are aborted when
  the server sends no response or no data for `DOWNLOAD_TIMEOUT_MS` (default 60,000). There is no
  limit on the whole download, which takes a while for Germany. An aborted extract download stays
  as `extract.osm.pbf.part` and is resumed by the next run; an aborted diff leads to the full
  download as usual. If the `.md5` does not answer in time, the extract is downloaded without
  verifying it.

### Cache

An in-memory LRU cache keeps the results of search requests (`CACHE_SIZE` entries, default
10,000, roughly 20–50 MB). Keys are the normalized query, `limit`, `lang` and the location. Short
prefixes ("Ha", "Kö") recur most often while typing and therefore stay in the cache; long queries
with a location are the most expensive on large indexes and are cached as well. The `X-Cache`
header shows `HIT` or `MISS`. The cache is cleared after an update.

### Logs

All logs are JSON lines in pino format on stdout (`level`, `time`, `pid`, `hostname`, `msg`),
including those of `import` and `update` (with `component`). There is one line per request with
`method`, `route`, `status`, `durationMs` and `cache`. Search texts and IP addresses are not
logged, because address input can be personal data. `LOG_LEVEL=warn` turns off the per-request
lines.

### Metrics

`GET /metrics` returns metrics in Prometheus format:

| Metric                                                                                  | Type      | Content                                                  |
| --------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------- |
| `doorstep_http_requests_total`                                                          | counter   | Requests by `method`, `route`, `status`                  |
| `doorstep_http_request_duration_seconds`                                                | histogram | Response time by `route`                                 |
| `doorstep_search_cache_hits_total`, `…misses_total`                                     | counter   | Cache hits and misses                                    |
| `doorstep_rate_limited_total`                                                           | counter   | Requests rejected with `429`                             |
| `doorstep_search_rejected_total`                                                        | counter   | Searches answered `503` by `reason` (timeout/overloaded) |
| `doorstep_index_available`                                                              | gauge     | 1 if a usable index is loaded                            |
| `doorstep_index_places`                                                                 | gauge     | Entries in the active index                              |
| `doorstep_index_imported_timestamp_seconds`                                             | gauge     | Build time of the active index (alert if too old)        |
| `doorstep_index_reloads_total`, `…reload_errors_total`                                  | counter   | Index switches without a restart, and failed ones        |
| `doorstep_updates_total`                                                                | counter   | Scheduled updates by `result` (success/failure/skipped)  |
| `process_resident_memory_bytes`, `nodejs_heap_used_bytes`, `process_start_time_seconds` | gauge     | Process                                                  |

`/metrics` is open by default. With `METRICS_TOKEN` (at least 16 characters) it answers `401`
unless the request sends `Authorization: Bearer <token>`; in Prometheus that is
`authorization: { credentials: <token> }` in the scrape config. `/health` stays open for the
`HEALTHCHECK`.

### Healthcheck

`GET /health` answers `200` as soon as the API is running, also during the first import:
`status`, `version`, `uptime`, `index` (usable index available), `importing` (import or update
running), `importedAt` (build time of the active index), `source` (region or file the index was
built from), `indexMode` (`build` or `mounted`), `schemaVersion` (schema this image reads),
`indexSchemaVersion` (schema of the index file, also when it does not match), `types` (result
types in the index, see [Choosing what is searchable](#choosing-what-is-searchable)) and
`attribution`. The image uses this for
its `HEALTHCHECK`.

## Configuration (environment variables)

Configuration happens exclusively via environment variables. Invalid values lead to an error
message at startup listing all affected variables.

| Variable              | Default                                                       | Description                                                                                     |
| --------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `REGION_URL`          | `https://download.geofabrik.de/europe/germany-latest.osm.pbf` | Geofabrik extract for import and update (not needed when `mounted`)                             |
| `HOST`                | `0.0.0.0`                                                     | Bind address of the API                                                                         |
| `PORT`                | `2322`                                                        | Port of the API                                                                                 |
| `DATA_DIR`            | `/data`                                                       | Directory for extract and index (absolute path)                                                 |
| `INDEX_MODE`          | `build`                                                       | `build`: the container builds the index; `mounted`: prebuilt, see above                         |
| `INDEX_TYPES`         | all                                                           | Result types the import puts into the index, e.g. `street`; see below                           |
| `INDEX_PATH`          | `$DATA_DIR/index.sqlite`                                      | Path of the index file (absolute path)                                                          |
| `DEFAULT_LANG`        | `de`                                                          | Default language (two-letter code)                                                              |
| `DIFF_UPDATES`        | `true`                                                        | `update` applies the daily diffs instead of downloading the whole extract                       |
| `AUTO_IMPORT`         | `false` (`true` in the Docker image)                          | `serve` imports in the background if no index exists                                            |
| `UPDATE_CRON`         | – (no updates)                                                | Schedule for automatic updates in cron format, e.g. `0 3 * * *`                                 |
| `RATE_LIMIT_ENABLED`  | `true`                                                        | Rate limiting on or off                                                                         |
| `RATE_LIMIT`          | `60`                                                          | Requests per minute and IP, `0` = off                                                           |
| `API_KEYS`            | –                                                             | Comma-separated API keys                                                                        |
| `REQUIRE_API_KEY`     | `false`                                                       | `/api` and `/reverse` answer `401` without a valid key (needs `API_KEYS`)                       |
| `API_KEY_IN_QUERY`    | `true`                                                        | Also accept the key as the `api_key` parameter, not only as the `X-API-Key` header              |
| `RATE_LIMIT_API_KEY`  | `600`                                                         | Requests per minute and API key                                                                 |
| `TRUST_PROXY`         | `false`                                                       | Take the client IP from `X-Forwarded-For` (only behind a reverse proxy)                         |
| `SEARCH_WORKERS`      | `auto`                                                        | Worker threads for `/api` and `/reverse`; `auto` = cores − 1 (max 8), `0` = main thread         |
| `SEARCH_TIMEOUT_MS`   | `2000`                                                        | `503` for a search in a worker that takes longer, `0` = no limit                                |
| `SEARCH_QUEUE_LIMIT`  | `100`                                                         | Pending searches per worker; above that `503` right away, `0` = no limit                        |
| `REQUEST_TIMEOUT_MS`  | `10000`                                                       | Time a client may take to send its request                                                      |
| `SHUTDOWN_TIMEOUT_MS` | `10000`                                                       | Time open requests get after `SIGTERM`                                                          |
| `IMPORT_NODE_INDEX`   | `memory`                                                      | Where `osmium export` keeps the node locations during the import: `memory` or `file` (less RAM) |
| `DOWNLOAD_TIMEOUT_MS` | `60000`                                                       | Abort a download after this long without a response or data (at least 1000)                     |
| `CACHE_SIZE`          | `10000`                                                       | Entries in the cache for search requests, `0` = off                                             |
| `CORS_ORIGINS`        | `*`                                                           | Comma-separated list of allowed origins                                                         |
| `CACHE_MAX_AGE`       | `3600`                                                        | `Cache-Control: max-age` of `/api` and `/reverse` in seconds, `0` = none                        |
| `METRICS_TOKEN`       | – (open)                                                      | Bearer token that `/metrics` requires, at least 16 characters                                   |
| `LOG_LEVEL`           | `info`                                                        | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`                                    |
| `TZ`                  | `UTC` (container)                                             | Time zone for `UPDATE_CRON`                                                                     |

Flags (`AUTO_IMPORT`, `RATE_LIMIT_ENABLED`, `TRUST_PROXY`) accept `true`/`false`, `1`/`0` and
`yes`/`no`.

## API

All responses are GeoJSON `FeatureCollection`s and contain the `attribution` field
("© OpenStreetMap contributors"). Successful responses carry
`Cache-Control: public, max-age=3600` (`CACHE_MAX_AGE`; with `0` they carry `no-store`), errors
`no-store`. After an update, browsers and CDNs may show old suggestions for up to that long.

### `GET /api` – autosuggest

| Parameter    | Required | Description                                             |
| ------------ | -------- | ------------------------------------------------------- |
| `q`          | yes      | Search text, 2–200 characters                           |
| `limit`      | no       | 1–10, default 5                                         |
| `lat`, `lon` | no       | Only together; nearby hits are boosted (location bias)  |
| `lang`       | no       | Two-letter language code, default `DEFAULT_LANG`        |
| `types`      | no       | Only these result types, comma-separated (`street,poi`) |
| `api_key`    | no       | API key (alternatively the `X-API-Key` header)          |

The last word is searched as a prefix, all others exactly. If the query finds nothing, these are
tried in order: without single letters (`Frankfurt a.M.`, `Mülheim a.d. Ruhr`), the street
without the house number (if the house number does not exist, the street is returned), and only
then the last word trimmed by up to two characters (typo at the end of a word). So when a house
number is missing, the street in the named city comes before a house number in a similarly
spelled city (`… 1 Bonn` does not return `… 1 Bönen`).

**Response:** every hit is a `Feature` with a `Point` geometry and these properties (missing
values are left out, never `null`):

| Property         | Example                                     | Description                                                                                                        |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`             | `node/4474544994`                           | Stable ID of the OSM object (`node/…`, `way/…`, `relation/…`)                                                      |
| `type`           | `address`                                   | `address`, `street`, `poi`, `locality` (city, town, village), `sublocality` (district), `place`                    |
| `category`       | `amenity=restaurant`                        | OSM tag that makes the object what it is; missing for plain addresses                                              |
| `name`           | `Ratskeller`                                | Name in the language from `lang`; missing for plain addresses                                                      |
| `label`          | `Marienplatz 8, 80331 München, Deutschland` | One line for display: `main_text, secondary_text`                                                                  |
| `main_text`      | `Marienplatz 8`                             | What the user is looking for (name, or street and house number)                                                    |
| `secondary_text` | `80331 München, Deutschland`                | Where it is                                                                                                        |
| `address`        | `{ "street": "Marienplatz", … }`            | `street`, `housenumber`, `postcode`, `city`, `district`, `state`, `country` (name in `lang`), `country_code` (ISO) |
| `distance_m`     | `120`                                       | Distance to `lat`/`lon` in meters, only if given (always for `/reverse`)                                           |

```json
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [11.5752, 48.1376] },
  "properties": {
    "id": "way/42",
    "type": "address",
    "label": "Marienplatz 8, 80331 München, Deutschland",
    "main_text": "Marienplatz 8",
    "secondary_text": "80331 München, Deutschland",
    "address": {
      "street": "Marienplatz",
      "housenumber": "8",
      "postcode": "80331",
      "city": "München",
      "district": "Altstadt-Lehel",
      "state": "Bayern",
      "country": "Deutschland",
      "country_code": "DE"
    }
  }
}
```

The texts depend on the type: a POI shows its address in `secondary_text`
(`Ratskeller` – `Marienplatz 8, 80331 München, Deutschland`), a street its district and city
(`Sendlinger Straße` – `Altstadt-Lehel, München, Deutschland`), a district its city
(`Ehrenfeld` – `Köln, Deutschland`), a city its state.

Where the data comes from: `street`, `housenumber`, `city` (the postal town), `postcode` and
`district` come from the address tags (`addr:*`; `district` from `addr:suburb`, otherwise
`addr:hamlet`; addresses without a street carry `addr:place` in `street`). Where they are
missing, the import fills city, district and postcode from OSM boundaries: municipalities
(`admin_level=8`, or cities marked `de:place=city` such as Köln or Berlin), districts
(`admin_level=10`, else `9`) and postcode areas (`boundary=postal_code`). Villages and other
settlements get their municipality as `city`. `country` and `state` always come from the
boundaries, see below.

POIs are named objects with `amenity`, `shop`, `tourism`, `healthcare`, `office`, `leisure`,
`historic` or `craft`, plus railway stations, airports and landmarks (`man_made`: towers,
lighthouses, windmills, watermills, water towers, observatories, obelisks, bridges, piers,
gasometers; `natural`: peaks and cave entrances). Left out are things nobody searches for:
signposts and information boards (tourist offices stay), Stolpersteine, benches, waste bins,
vending machines, parking spaces and hunting stands, and subway, light rail and tram stops (like
bus stops, they are mostly named after a street and would crowd it out). Streets come only from
OSM ways, not from named nodes such as bus stops; a street with a generic POI tag such as
`tourism=yes` stays a street. Stations and airports rank above other POIs. The same place
found twice (e.g. a city as a boundary and as a place node) is shown once. For queries with a house number, the plain address comes before shops and businesses
that are only located there.

**Normalization** (the same for import and search, `src/search/normalize.ts`): lowercase,
`ä` ↔ `ae`, `ß` ↔ `ss`, other accents removed, `Str.` ↔ `Straße`, `Schlosstr.` ↔
`Schloßstraße`, `St.` ↔ `Sankt`, `60 d` and `60d` equivalent, `Hauptstraße12` →
`Hauptstraße 12`. In addition, the spelling without umlaut e is indexed, so `Dusseldorf` also
finds Düsseldorf. Names with the base words `Straße`, `Allee`, `Platz`, `Gasse`, `Damm`, `Ring`
and `Weg` are also indexed split and joined: `Friedrich Straße` finds Friedrichstraße,
`Konrad-Adenauerstraße` finds Konrad-Adenauer-Straße.

**Ranking** (`src/search/ranking.ts`): from up to 200 candidates (with `lat/lon` also up to 200
within 25 km, found via one grid cell per entry in the FTS index), a score is computed from FTS
relevance (`bm25`), match with the name, `importance` (city before district before street before
house number) and – if given – proximity to the location. Well-known objects get a higher
`importance`: +0.1 with a `wikidata` or `wikipedia` tag, and places up to +0.05 more by
population (log scale from 1,000 to 1 million inhabitants); near the top the bonus is squeezed
so that nothing exceeds 1. Addresses get no bonus. The segments of a street are merged during
the import (see [Import](#import)); with a location, a street points to its segment nearest to
it. Hits with the same name within 2 km that are still separate (e.g. pieces of a street that
do not touch) are merged into one; streets only with the same postcode, so a street in two
postcode areas is shown once per area (the Königsallee as 40212 and 40215).

**Languages:** `name:de` and `name:en` are stored separately during the import, and all variants
are searched. `lang=de|en` selects the displayed name; otherwise `name` applies.

The search duration is in the `Server-Timing` response header (e.g. `search;dur=1.84`).

```bash
curl 'http://localhost:2322/api?q=K%C3%B6nigsall&limit=3'
```

**Limits when checking delivery addresses** (measured on the Germany extract):

- **Country and state come from the administrative boundaries**, not from
  `addr:country`/`addr:state` (missing on 29 % and almost all addresses respectively, sometimes
  wrong: Riezlern and Jungholz are often tagged `DE`). The import loads the boundaries
  (`boundary=administrative`, `admin_level=2` and `4`) and assigns country and state to every
  entry, including streets without addresses, via point in polygon. So a shop checks
  `country == "DE"` and `state` if needed.
  - The Geofabrik extract contains addresses from neighboring countries (Kerkrade, Zgorzelec,
    Strasbourg, Kreuzlingen …), but their boundaries are only cut off. If a point lies outside
    Germany, the nearest boundary way determines the neighboring country; `state` then stays empty
    (unless the country matches `addr:country`, in which case `addr:state` applies).
  - Uncertain only near a tripoint (e.g. Vaals/Aachen/Kelmis): there a point in a neighboring
    country can be assigned to the wrong neighbor. German addresses are not affected; they lie in
    the complete area of Germany.
  - With an extract that contains no complete country (e.g. an administrative region), there are
    no areas; then `addr:country`/`addr:state` apply as before.
  - Checked on the Germany extract: all deviations from an existing `addr:country` are
    corrections; for addresses without `addr:country`, the postcode format always matches the
    determined country.
- **Special cases with German postcodes:** Büsingen am Hochrhein (78266, Swiss customs territory),
  Helgoland (27498, outside the EU customs territory), Kleinwalsertal (87567–87569) and Jungholz
  (87491) belong to Austria. A shop is best off checking such rules by postcode.
- **Typos in the middle of a word** (`Friedrichstrase`, `Kastanineallee`) are not recognized,
  only at the end of a word.

### `GET /reverse` – nearest object to a point

| Parameter    | Required | Description                               |
| ------------ | -------- | ----------------------------------------- |
| `lat`, `lon` | yes      | Coordinate in WGS84                       |
| `limit`      | no       | 1–10, default 1                           |
| `radius`     | no       | Search radius in km, > 0 to 10, default 1 |
| `lang`       | no       | As for `/api`                             |
| `types`      | no       | As for `/api`                             |

Invalid parameters return `400` with a message like `q: must be at least 2 characters long`.
With `REQUIRE_API_KEY`, a missing or unknown key returns `401`. Overloaded or too slow search
workers return `503` with `Retry-After: 1` (see [Timeouts and overload](#timeouts-and-overload)).
As long as there is no index at `INDEX_PATH` (default `$DATA_DIR/index.sqlite`), both endpoints answer `503`. This also
applies to an index with an old schema (currently version 11, since street segments are merged
during the import; version 10 brought the result type in the full-text index for `types` and
`INDEX_TYPES`, version 9 brought popularity in `importance` and
landmarks, version 8 categories, more POI kinds and city/district/postcode from boundaries,
version 7 split and joined street names, version
6 the word statistics for bm25, version 5 country and state from administrative boundaries): then
please import again or wait for the next update.

### Other endpoints

- `GET /health` – status, see [Healthcheck](#healthcheck)
- `GET /metrics` – Prometheus metrics, see [Metrics](#metrics)

## Docker

The `Dockerfile` builds in several stages: TypeScript build, production dependencies and a slim
runtime image on `node:24.22.2-trixie-slim` (Debian 13) with `osmium-tool`. SQLite is built into
Node as `node:sqlite` (with FTS5 and R\*Tree); no native modules are compiled.

- The runtime image installs Debian's security updates at build time and contains no npm, npx,
  corepack or yarn: they are only needed to build, and the npm bundled with Node ships outdated
  packages that the vulnerability scan reports. Run commands in the container with `doorstep`
  or `node`, not `npm`.

- Runs as user `node` (uid 1000), not as root.
- `/data` is a `VOLUME` and contains `extract.osm.pbf`, `index.sqlite` and, during an update,
  `index.next.sqlite`; also the lock file `import.lock.sqlite` (with `import.lock.sqlite.json`
  while an import is running). With a bind mount (`-v $PWD/data:/data`), the directory must be
  writable for uid 1000.
- Port `2322`, `HEALTHCHECK` against `/health` (every 30 s).
- If the automatic first import fails, the container exits with code 1. With
  `--restart unless-stopped`, Docker restarts it and the import is repeated; an interrupted
  download is resumed. A failed scheduled update does not stop the container; the current index
  stays active.

### Commands

| Command                                    | Description                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `serve` (default)                          | Start the API; without an index, the import runs in the background (`AUTO_IMPORT`), updates per `UPDATE_CRON` |
| `import [--region <url>] [--input <file>]` | Build the index (download, filter, import) and swap it in atomically                                          |
| `update`                                   | Bring the extract up to date with the daily diffs, rebuild the index if anything changed, swap it in          |
| `--force` (with `import`/`update`)         | Run even with `INDEX_MODE=mounted`                                                                            |

```bash
# Import up front, without starting the API
docker run --rm -v data:/data doorstep-api import --region https://download.geofabrik.de/europe/germany/bremen-latest.osm.pbf

# Update in the running container; the API switches to the new index by itself
docker exec doorstep doorstep update
```

### Smoke test

```bash
npm run smoke
```

Builds the image, starts it with an empty volume and the mini extract from `test/fixtures/`
(automatic import via `REGION_URL`, served by a helper container), queries `/health`, `/api`,
`/reverse` and `/metrics`, checks the `HEALTHCHECK`, runs `update` in the running container under
constant requests and checks that none fails and that the API loads the new index without a
restart. Finally, a second container serves the built index with `INDEX_MODE=mounted`,
read-only (`--read-only`, volume mounted `:ro`) and without network, and must neither download
nor import. Needs only Docker and `curl`, no internet access except for the image build.

## CI and releases

**CI** (`.github/workflows/ci.yml`, on every push to `main` and every pull request):

- `npm run ci` (lint, type check, tests, build) with `osmium-tool` installed, so the import tests
  on the PBF fixture run too, and `npm audit` of the production dependencies (fails from `high`).
- Builds the image, runs the [smoke test](#smoke-test) against it and scans it with Trivy; fixable
  `HIGH` or `CRITICAL` vulnerabilities fail the run.

**Releases** (`.github/workflows/release.yml`, on a tag `v<major>.<minor>.<patch>`):

1. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [1.2.3] - <date>`; set `"version": "1.2.3"`
   in `package.json` (`npm version 1.2.3 --no-git-tag-version`). Commit both.
2. `git tag v1.2.3 && git push origin v1.2.3`.
3. The workflow checks that tag, `package.json` and `CHANGELOG.md` agree, runs the same checks as
   CI, then pushes the image to `ghcr.io/alexanderkrust/doorstep` with the tags `1.2.3`, `1.2`
   and `1` (no `1` for `0.x`, never `latest`), with an SBOM and provenance attestation, signs it
   with cosign (keyless, GitHub OIDC) and creates a GitHub release with the changelog section and
   the image digest. `0.x` versions and versions like `1.2.3-rc.1` are marked as pre-releases.

Verifying the signature before a deployment:

```bash
cosign verify ghcr.io/alexanderkrust/doorstep:1.2.3 \
  --certificate-identity-regexp '^https://github.com/alexanderkrust/doorstep/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Showing the SBOM: `docker buildx imagetools inspect ghcr.io/alexanderkrust/doorstep:1.2.3 --format '{{ json .SBOM }}'`.

Dependabot (`.github/dependabot.yml`) proposes weekly updates for npm packages and the pinned
GitHub Actions. The base image (`ARG NODE_IMAGE` in the Dockerfile) is updated by hand; the Trivy
scan flags it when it has fixable vulnerabilities.

The package is private on GHCR after the first release; make it public or grant access under the
repository's package settings.

## Load test

```bash
npm run loadtest -- --url http://127.0.0.1:2322 --duration 20 --connections 50 [--location]
```

Sends every typing prefix of typical inputs ("Kö", "Kön", "Köni", …) with
[autocannon](https://github.com/mcollina/autocannon), in turn across all connections. Exits with
code 1 if a request fails. For this, set `RATE_LIMIT_ENABLED=false` on the server or use a key
with a high limit via `--api-key`.

Results (2026-11-06, Apple M3 with 8 cores, Node 24, index from
`test/fixtures/duesseldorf.geojsonseq` with 20,318 entries, schema 11, 50 connections,
`LOG_LEVEL=info`; the load test runs on the same machine). Each scenario with search workers
(`SEARCH_WORKERS=auto`, 7 workers) and in the main thread only (`SEARCH_WORKERS=0`):

| Scenario                                         | Workers | Requests/s | p50   | p90   | p99    | Errors |
| ------------------------------------------------ | ------- | ---------- | ----- | ----- | ------ | ------ |
| Without cache (`CACHE_SIZE=0`), without location | 7       | 4,285      | 10 ms | 19 ms | 30 ms  | 0      |
|                                                  | 0       | 1,262      | 40 ms | 66 ms | 88 ms  | 0      |
| Without cache, with location                     | 7       | 3,460      | 13 ms | 24 ms | 36 ms  | 0      |
|                                                  | 0       | 1,080      | 50 ms | 80 ms | 108 ms | 0      |
| With cache, with location                        | 7       | 35,390     | 1 ms  | 1 ms  | 3 ms   | 0      |
|                                                  | 0       | 39,290     | 1 ms  | 1 ms  | 2 ms   | 0      |
| With cache, index swapped meanwhile (20 s)       | 7       | 34,938     | 1 ms  | 1 ms  | 3 ms   | 0      |
|                                                  | 0       | 33,867     | 1 ms  | 1 ms  | 3 ms   | 0      |
| Without cache, index swapped twice (75 s)        | 7       | 3,161      | 15 ms | 25 ms | 38 ms  | 0      |
|                                                  | 0       | 1,071      | 49 ms | 82 ms | 110 ms | 0      |

How to read this: without cache, the workers search in parallel and triple the throughput; in the
main thread alone, the requests mostly wait for each other (a single search takes under 1 ms, see
`Server-Timing`). With cache, the main thread answers from the cache itself, so the workers do not
matter there; the test repeats 117 or 234 different requests, so the cache share is higher than in
real operation. For the swaps, the index was rebuilt next to the running one and swapped in via
`rename`; not a single one of the 698,697 (with cache) and 237,007 (without cache) requests during
the swaps failed. Before the search workers and with the cache only for short queries
(2026-10-28, 17,618 entries): 1,200, 1,033 and 4,090 requests/s for the first three scenarios.

**Search workers** (`SEARCH_WORKERS`, 2026-11-06, Apple M3 with 8 cores, index of the Düsseldorf
administrative region with 1.32 million entries, schema 11, without cache, 50 connections for
15 s; the load test runs on the same machine):

| Scenario                             | Requests/s | p50   | p90    | p99    | Errors |
| ------------------------------------ | ---------- | ----- | ------ | ------ | ------ |
| `SEARCH_WORKERS=0`, without location | 711        | 68 ms | 90 ms  | 132 ms | 0      |
| `SEARCH_WORKERS=0`, with location    | 542        | 91 ms | 129 ms | 176 ms | 0      |
| `auto` (7 workers), without location | 2,301      | 20 ms | 30 ms  | 42 ms  | 0      |
| `auto` (7 workers), with location    | 1,537      | 31 ms | 46 ms  | 64 ms  | 0      |

Each worker opens the index file itself (read-only) and searches in parallel; the main thread
parses requests, keeps the cache and sends the answers. With a single connection, both answer in
1 ms (p50) and 2 ms (p99): handing a search to a worker costs nothing measurable. After an index
swap, the server tells the workers and clears the cache again once they have switched.

**Germany index** (schema 7, 25.6 million entries, 9.3 GB, one API process without search
workers, otherwise as above, warm page cache):

| Scenario                                         | Requests/s | p50    | p90    | p99    | Errors |
| ------------------------------------------------ | ---------- | ------ | ------ | ------ | ------ |
| Without cache (`CACHE_SIZE=0`), without location | 411        | 81 ms  | 258 ms | 584 ms | 0      |
| Without cache, with location                     | 221        | 169 ms | 429 ms | 927 ms | 0      |
| With cache, without location                     | 40,163     | 1 ms   | 1 ms   | 2 ms   | 0      |
| With cache, with location                        | 31,397     | 1 ms   | 1 ms   | 4 ms   | 0      |

A search takes 2.4 ms on average here without and 4.5 ms with a location; with 50 connections,
the requests without cache mostly wait for each other. The values with cache are an upper bound:
the test repeats 234 requests, 99.98 % come from the cache (process at 264 MB RSS afterwards). In
real operation, long queries are mostly unique, so the throughput lies between both rows. Until
2026-10-28 the cache only took queries up to 10 characters; with that, the test with a location
reached 545 requests/s. Not measured again with search workers; on the smaller indexes above they
triple the throughput without cache.

## Search quality and latency

- **Golden queries:** `test/golden/duesseldorf.json` contains search queries with expected top
  hits against an excerpt of Düsseldorf and Neuss. They run with `npm test`.
- **Benchmark:** measures the search duration directly on an index without HTTP (golden queries
  plus every typing prefix of typical inputs, with and without a location). Target: p95 below
  50 ms.

```bash
npm run bench -- --index $PWD/data/index.sqlite
```

Measured on a MacBook, Node 24, 5 rounds. **Germany, current schema 8** (Geofabrik extract from
2026-10-27, 4.9 GB PBF → 26.0 million entries including 2.0 million POIs, 10.1 GB index, import
34 min, max 3.3 GB RAM): **p50 2.9 ms, p95 19.5 ms, p99 33 ms**, max 69 ms with a warm cache.
Earlier: p50 2.8 ms, p95 16.5 ms, p99 29 ms, max 41–91 ms, measured with
schema 5 without boundaries; before that (up to schema 4) p95 was 194 ms. Schema 7 with boundaries
and spelling variants: p50 2.5 ms, p95 16.9 ms, max 56 ms with a warm cache. Import sizes: schema
5 without boundaries 8.5 GB index, 30 min, max 5.4 GB RAM; with boundaries 8.8 GB, 39 min, max
4.2 GB RAM; schema 7 9.3 GB, 28 min, max 4.2 GB RAM. The slowest case is a search with a location
for very frequent words (`Am Markt 1` 41 ms, `Friedrichstraße 3` 20–90 ms). Düsseldorf
administrative region (217 MB PBF, Geofabrik 2026-11-05 → 1.32 million entries, 547 MB index,
import 58 s), schema 11 (2026-11-06): p50 1.6 ms, p95 3.3 ms, p99 3.9 ms, max 5.3 ms; with
schema 4: p50 2.0 ms, p95 10.1 ms, p99 16.6 ms. The benchmark measures the search itself, in one
thread; search workers do not change it, they run several such searches at the same time.

What keeps the search fast: the hit list in FTS5 is sorted by importance, and only the first 200
candidates are read per query. `bm25` is computed in JS with word statistics precomputed during
the import (tables `terms` and `prefixes`), instead of counting all documents of every search word
on every query. Long prefixes with a very frequent word ("stras…" → "strasse") are expanded into
the exact word and longer sub-prefixes, because FTS5 otherwise merges prefixes over 4 characters
completely up front. The nearby search reads only hits within the radius, via the grid cells.

## Development

Requirements: Node.js ≥ 24 (built-in `node:sqlite` with FTS5 and R\*Tree) and, for the import,
[`osmium-tool`](https://osmcode.org/osmium-tool/) (macOS: `brew install osmium-tool`, Debian:
`apt install osmium-tool`).

```bash
npm install
npm run dev        # API with auto-reload on port 2322
npm test           # Vitest
npm run lint       # ESLint + Prettier check
npm run build      # TypeScript to dist/
npm run ci         # lint, typecheck, test, build
```

## Import

```bash
DATA_DIR=$PWD/data npm run import -- --region https://download.geofabrik.de/europe/germany/bremen-latest.osm.pbf
DATA_DIR=$PWD/data npm run import -- --input ./my-extract.osm.pbf   # local file, no download
```

Without `--region`, `REGION_URL` applies. Steps:

1. Take the lock `$DATA_DIR/import.lock.sqlite` (never two imports at the same time).
2. Bring `$DATA_DIR/extract.osm.pbf` up to date: with an existing extract, apply the daily
   diffs (see [Updates without downtime](#updates-without-downtime)); otherwise download it.
   Interrupted downloads are resumed (`extract.osm.pbf.part`), the Geofabrik `.md5` is
   verified. If an existing file matches the `.md5`, it is not downloaded again.
3. Load the boundaries: `osmium tags-filter` on `admin_level=2,4–10` and `boundary=postal_code`,
   then areas and boundary ways via `osmium export`, relation members via `osmium cat` (OPL).
   Countries, states, municipalities, districts and postcode areas are then in memory; the
   outlines of the small areas are simplified to about 10 m.
4. `osmium tags-filter` on addresses, places (`place=*`), streets (`highway` with a name) and
   POIs (`amenity`, `shop`, `tourism`, `healthcare`, `office`, `leisure`, `historic`, `craft`,
   stations, airports, landmarks; `TAG_FILTERS` in `src/import/osmium.ts`).
5. `osmium export` as a GeoJSON sequence that is read line by line (constant memory use). Every
   entry gets country and state, and missing city, district and postcode, from the boundaries on
   insert.
6. Merge street segments: segments with the same name, postcode, city and district that share
   an end point become one entry (the segment closest to the middle, with the highest
   importance). The midpoints of all its segments are kept in `street_points`, so that the
   location bias and `/reverse` still work along the whole street.
7. Build `index.next.sqlite` (table `places`, FTS5 table `places_fts` with a prefix index and a
   grid cell (0.25°) per entry, R\*Tree `places_rtree`, table `meta`) and swap it in atomically
   for `index.sqlite`.

Guide value: the Bremen extract (21 MB) yields about 177,000 entries in about 5 seconds.

### Out of memory during the import

`osmium export` keeps the locations of all nodes in memory while it builds the geometries; for
Germany that is the largest part of the import's memory use. If the container or host runs out
of memory, the kernel kills osmium, and the import fails with
`osmium export was killed by SIGKILL: this usually means it ran out of memory`, typically during
"Reading features" while osmium reads the nodes. Either give the container more memory (check
for a `--memory` limit or the Docker Desktop VM size), or set `IMPORT_NODE_INDEX=file`: osmium
then keeps the node locations in `$DATA_DIR/node-locations.idx` (deleted after the import), which
needs far less memory and some more disk space and time. The file mode was only tested on the
test extract, not measured on Germany.

## Data license

The data comes from OpenStreetMap: © OpenStreetMap contributors, available under the
[Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/). Anyone who offers the
API publicly or displays results must make this notice visible; the `attribution` field in every
response carries it.
