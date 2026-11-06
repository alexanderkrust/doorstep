# Roadmap: self-hosted address autosuggest API

Oct 28, 2026 · @Alex

## Goal and constraints

The goal is a solid address autosuggest API based on OSM, comparable to Google Places Autocomplete, that runs as a single Docker image and is started with `docker run`, without docker-compose and without external services.

This changes the first recommendation (Typesense/OpenSearch as a separate server): a separate search server would need a second container. So the index is embedded in the application.

| Decision             | Choice                                                                        | Reason                                                            |
| -------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Deployment           | One multi-stage `Dockerfile`, started with `docker run`, data on a volume     | Requirement: no docker-compose                                    |
| Language / framework | TypeScript, Fastify                                                           | Fits the existing stack (NestJS, Next.js), fast and lean          |
| Index                | SQLite with FTS5 (prefix search) and R\*Tree (geo)                            | Embedded, one file, no second process to manage                   |
| OSM preparation      | `osmium-tool` in the image, import script in TypeScript                       | Proven filtering, the import stays in the project                 |
| Data source          | Geofabrik extract, configurable via env                                       | Start with Germany, Europe possible later                         |
| Output format        | GeoJSON with display texts and a structured address                           | Standard format, easy to use in maps and forms                    |

## Architecture in one container

The container holds the API, the importer and `osmium-tool`; the index is a SQLite file on a mounted volume.

- **One image, two commands:** `serve` starts the API, `import` downloads the extract and builds the index. On the first start, the default start runs `import` automatically if there is no index on the volume yet.
- **Volume `/data`:** contains `extract.osm.pbf`, `index.sqlite` and, during an update, the new file `index.next.sqlite`.
- **Configuration via env:** `REGION_URL` (Geofabrik link), `PORT`, `DEFAULT_LANG`, `RATE_LIMIT`, `CORS_ORIGINS`.
- **Start:** `docker run -p 2322:2322 -v data:/data doorstep-api`
- **One process:** the API only reads the index; updates build a new file and swap it in atomically (phase 6).

## Phase 1: project setup

**Goal:** A working skeleton with tests that Claude Code can cleanly build every later phase on.

- [x] Create the repository with TypeScript (strict), Fastify, ESLint, Prettier and Vitest
- [x] Folder structure: `src/api`, `src/import`, `src/search`, `src/config`, `test/`, `docker/`
- [x] Configuration module that validates all env variables (e.g. with zod) and sets defaults
- [x] `GET /health` returns `200` with a status
- [x] `CLAUDE.md` with architecture rules and commands (template below)
- [x] CI script: `npm run lint`, `npm run test`, `npm run build`

**Done when:** `npm test` and `npm run build` pass and `/health` answers locally.

## Phase 2: import pipeline

**Goal:** An OSM extract becomes a searchable SQLite file with addresses, streets and places.

- [x] Download the extract from `REGION_URL` to `/data` (with progress, resume and checksum, if Geofabrik provides an `.md5`)
- [x] `osmium tags-filter` on relevant objects: `addr:housenumber`, `addr:street`, `place=*`, `highway` with a name, optionally `amenity`
- [x] Export via `osmium export` as a GeoJSON sequence and streaming import, so memory use stays constant
- [x] Data model of a row: `id`, `osm_type`, `osm_id`, `type`, `name`, `street`, `housenumber`, `postcode`, `city`, `state`, `country`, `lat`, `lon`, `importance` (extended since: `name_de`, `name_en`, `district`, `category` and more)
- [x] Table `places` plus an FTS5 table with a prefix index (`prefix='2 3 4'`) and an R\*Tree table for coordinates (implemented with `prefix = '1 2 3 4'`, so that single-digit house numbers are prefixes too)
- [x] Derive `importance` from the `place` type (city before village before street before house number)
- [x] CLI: `npm run import -- --region <url>` and the Docker command `import`
- [x] Tests with a small sample extract (e.g. a district) that lives in the repo

**Done when:** importing a small extract passes in tests and produces a file in which sample addresses can be found via SQL.

## Phase 3: search API

**Goal:** Autosuggest and reverse geocoding over HTTP, as GeoJSON.

- [x] `GET /api?q=&lat=&lon=&limit=&lang=` returns a GeoJSON `FeatureCollection`
- [x] Every feature has `geometry` (Point) and `properties` with `name`, `street`, `housenumber`, `postcode`, `city`, `state`, `country`, `osm_id`, `osm_type` (superseded by the response format of schema 8, see "Response quality")
- [x] The search query is translated into an FTS5 query: last token as a prefix, preceding tokens exact
- [x] `GET /reverse?lat=&lon=` finds the nearest object via the R\*Tree
- [x] Parameter validation (minimum length of `q`, `limit` at most 10) with clear `400` errors
- [x] CORS via env, `Cache-Control` response header for identical queries
- [ ] OpenAPI description under `/docs` (optional)
- [x] Tests: search for a street, a street with a house number, a place, a typo at the end of a word

**Done when:** against the test index, `/api?q=Königsall` returns the Königsallee among the first results and `/reverse` returns a plausible hit.

## Phase 4: ranking and quality

**Goal:** The suggestions feel like a good autosuggest: the right order, tolerant of spelling, nearby hits first.

- [x] Normalization during import and search: lowercase, umlauts (ä ↔ ae), `ß` ↔ `ss`, "str." ↔ "straße"
- [x] Ranking formula from the FTS score (`bm25`), `importance` and the distance to `lat/lon`, as a pure function with unit tests
- [x] Location bias: hits around the given point are boosted
- [x] Fallback: house number missing in OSM → return hits at street level
- [x] Multiple languages: store `name:de`, `name:en` separately and select by `lang`
- [x] Golden queries: a file with 30 to 50 search queries and expected top hits that runs in the test suite
- [x] Measure the response time per request, target below 50 ms on a Germany index (2026-10-29, schema 8: p95 19.5 ms)

**Done when:** all golden queries pass and the latency on the full Germany index is within the target range. (Latency reached on 2026-10-28: p95 16.5 ms, see below.)

### Open items from phase 4

- [x] **Lower the latency on the Germany index** (2026-10-28, 25.6 million entries, `npm run bench`, 5 rounds, MacBook): before (schema 4) p50 22 ms, p95 194 ms, p99 548 ms; now (schema 5 on the branch, schema 6 on main) **p50 2.8 ms, p95 16.5 ms, p99 29 ms**, max 41–91 ms. Profile of the slowest queries: without `bm25()`, "breite strasse\*" took 170 instead of 400 ms, "am markt 1\*" 2 instead of 240 ms; exact "strasse" instead of the prefix "strasse\*" 0.3 instead of 170 ms. Both suspected causes confirmed, both fixed:
  - **Decision: bm25 in JS instead of FTS5's `bm25()`** (deviates from "FTS score (`bm25`)" above; the formula stays the same). For `bm25()`, FTS5 counts all documents of every search word on every query. The import now builds word statistics (`terms`: documents per word, `prefixes`: per prefix up to 4 characters, meta `fts_tokens`; 826,000 words, about 12 s during the import). `src/search/bm25.ts` computes the same formula with them (k1 = 1.2, b = 0.75, column weights 4/2/1/1/1); the hits in the document come from its columns, generated as during the import. A test compares the result with FTS5's `bm25()`. Deviation: for prefixes, the document count is the sum over the matching words (a document with "koelner" and "kolner" counts twice).
  - **Long prefixes of frequent words are expanded** (`expandPrefix`): FTS5 merges the hit lists of all words of a prefix over 4 characters completely up front. If a prefix has more than 50,000 documents, it is split character by character into OR-joined parts: the frequent word exactly ("strasse"), the rest as longer prefixes ("strassen"\*, …). The parts cover exactly the same words (test: same hits with and without expansion). "breite strasse\*" 169 → 0.5 ms, "graf adolf strasse\*" 180 → 3 ms.
- [ ] **Nearby search with very frequent words** is now the slowest case (all ten slowest queries have a location): "Am Markt 1" 41 ms, "Friedrichstraße 3" 20–90 ms, "Berliner A" 27 ms. FTS5 has to intersect the whole hit list of the rarest word ("markt", 47,000 documents) with "am" and the grid cells when there are fewer than 200 hits within the radius. Only a spatially partitioned index would improve this (e.g. word + cell as a token, a much larger index); not needed for now at p95 16.5 ms.
- [x] **Popularity signal for `importance`** (schema 9, 2026-11-06): +0.1 for objects with `wikidata` or `wikipedia` (once, not added up; `name:etymology:wikidata` does not count), places up to +0.05 more by `population` (log scale, 0 at 1,000, full at 1 million; values like "619 294" or "1.234" are read, others ignored). Near the top the bonus is squeezed into the room left below 1 (Düsseldorf 0.998, a city of 110,000 0.989, a city without tags 0.9). Addresses get no bonus, because `findAddressStart` expects them at the end of the id order. Effect on the golden queries: "Kö" (with location) now finds the Königsallee in second place instead of fifth, behind the shop "Kö 21"; the golden query is tightened to the top 2. Still open: alternative names such as `reg_name=Kö` are not indexed. Not measured on the Germany index (no Germany extract available locally).
- [x] **Landmarks were partly missing from the index** (schema 9, 2026-11-06): the import now also takes named `man_made` landmarks (tower, lighthouse, windmill, watermill, water_tower, observatory, obelisk, bridge, pier, gasometer) and `natural=peak,cave_entrance`; other named `man_made` objects (pipelines, plants) stay out. The Rheinturm is tagged `tourism=viewpoint` and was already a POI since schema 8; the golden query "Rheinturm" now checks it (the fixture area was extended west to 6.755 for it). Regenerating the fixture with all tags the import reads (the old `scripts/slim-fixture.ts` dropped everything but `amenity` among the POI tags) showed two schema-8 problems, both fixed: street segments with `tourism=yes` (Königsallee) became POIs instead of streets, and subway/light rail/tram stops named after streets ("Schadowstraße", "Heinrich-Heine-Allee") ranked above those streets; they are now left out like bus stops. "Hauptbahnhof" now finds the station "Düsseldorf Hauptbahnhof" first.
- [ ] **Merge street segments during the import:** segments with the same name are only merged during the search so far (2 km radius). During the import, the index would be smaller and the candidate set more meaningful.

## Phase 5: Docker

**Goal:** A single `Dockerfile` that builds a slim image that starts right away. No docker-compose, neither in the repo nor in the README.

- [x] Multi-stage build: stage 1 builds TypeScript (`npm ci`, `npm run build`), stage 2 contains only production dependencies, the build output and `osmium-tool`
- [x] Base image with Debian or Alpine, depending on what the native SQLite module (`better-sqlite3`) builds without trouble; SQLite must be compiled with FTS5 (implemented with Debian and the built-in `node:sqlite` instead of `better-sqlite3`)
- [x] Run as a non-root user, `/data` as a `VOLUME`
- [x] `ENTRYPOINT` with the commands `serve` (default), `import` and `update`; the first `serve` without an index imports automatically
- [x] `HEALTHCHECK` against `/health`; `/health` also reports whether an index exists
- [x] `.dockerignore`, pinned versions of the base images, `EXPOSE 2322`
- [x] Configuration exclusively via env, examples in the README
- [x] Smoke test script: build the image, start it with a mini extract, query `/api`

**Done when:** `docker build -t doorstep-api .` and `docker run -p 2322:2322 -v data:/data doorstep-api` lead to working suggestions on a fresh machine.

## Phase 6: updates and operations

**Goal:** The API runs permanently, updates its data without downtime and is secured for public operation.

- [x] Update command: builds `index.next.sqlite` next to the running index and swaps both via an atomic `rename`
- [x] The API reopens the index after the swap, without a restart (signal or internal schedule via `UPDATE_CRON`)
- [x] Rate limiting per IP, optionally per API key (`@fastify/rate-limit`), switchable via env
- [x] In-memory cache (LRU) for frequent short prefix queries
- [x] Structured logs and a `/metrics` endpoint in Prometheus format
- [x] Attribution: responses and README name "© OpenStreetMap contributors" (ODbL)
- [x] README with a quick start, env table, notes on RAM and disk needs (Germany about 4 GB PBF)
- [x] Load test (e.g. with `autocannon`) and documented results

**Done when:** an update runs through in production without any request failing meanwhile, and the README is enough for an installation without further questions.

### Open items from the code review (2026-10-28)

- [x] **Location search with very frequent words:** every entry carries its grid cell (0.25°) as a token in the FTS column `cell` (schema version 3). The nearby search requires one of the box's cells, and FTS5 intersects the hit lists; if at least 10 of the 200 global candidates already lie within the radius, the search runs without cells (both ways return the same rows). Synthetic (1 million distant hits, 500,000 addresses within the radius), full search with a location: "Ha" 108 → 51 ms, "Hauptstr" 76 → 38 ms, "Hafen" 68 → 18 ms; dense queries ("Be", "Hasenheide 12") unchanged. The duration now depends on the density within the radius, no longer on the number of hits in the whole index. Rejected: searching from the R\*Tree (1–20 s, FTS5 restarts the query per row and bm25 counts all hits every time), a narrow coordinate table (about 15 %). The largest remaining share was counting the hits per phrase for bm25 (8–20 ms for frequent prefixes, also without a location); since schema 5, bm25 is computed in JS (see phase 4).
- [x] **City for streets without addresses:** solved with schema 8: the import loads municipality (`admin_level=8`, or `de:place=city` at a higher level), district (`admin_level=10`/`9`) and postcode boundaries (`boundary=postal_code`) and fills missing city, district and postcode from them. Germany (2026-10-29): city and postcode missing on under 1 % of entries (before: streets 15 %, POIs 50 %, districts almost 100 %).

### Open items from phase 6

- [x] **Measurements on the Germany index:** import measured (2026-10-28): schema 4 30 min, max 5.4 GB RAM, index 8.5 GB; schema 5 (with boundaries) 39 min, max 4.2 GB RAM, index 8.8 GB. Schema 8 (municipality/district/postcode boundaries, 2.0 million POIs) 34 min, max 3.3 GB RAM, index 10.1 GB, 26.0 million entries; search p50 2.9 ms, p95 19.5 ms (warm cache). Schema 7 (boundaries, word statistics, spelling variants) 28 min, max 4.2 GB RAM, index 9.3 GB; search p95 16.9 ms (warm cache; cold right after the import, single queries up to 385 ms). Load test schema 7 (`npm run loadtest`, 50 connections, 20 s, one process): without cache 411 requests/s (p50 81 ms, p99 584 ms), without cache with a location 221/s (p50 169 ms, p99 927 ms), with cache and a location 545/s (p50 24 ms, p99 757 ms), 0 errors each. The latency under load is almost only waiting time: one process searches sequentially, on average 2.4 ms (without location) and 4.5 ms (with) per request. Before, on 17,618 entries: about 1,100 requests/s without cache, 0 errors during updates under load.
- [ ] **Throughput on large indexes:** one process manages 220–410 requests/s without cache on the Germany index, because `node:sqlite` searches synchronously on one core. More throughput via worker threads that each only read the index. Done: since 2026-10-28 the cache takes all queries, not only those up to 10 characters (on the Germany index, long ones with a location are the most expensive). Load test with cache: 545 → 31,397 requests/s with a location, 40,163/s without, p99 2–4 ms; that is an upper bound, because the test only repeats 234 different requests. The throughput on cache misses remains open.

### Open items from the test with Germany data (2026-10-28)

Fixed: districts (`addr:suburb`/`addr:hamlet` → `district`, 4.8 million addresses), addresses without a street (`addr:place`, 226,000), "Schlosstr" = "Schloßstraße", "St." = "Sankt", "Hauptstraße12", house number "12 a" = "12a" (71,000), "Frankfurt a.M.", street in the named city before a typo hit in another city, heap overflow while building the FTS index (the Germany import aborted with schema 3).

- [x] **Country and state for delivery checks:** `addr:country` is missing on 29 % of the addresses, `addr:state` almost always. The extract contains addresses from all neighboring countries (about 28,000 with a foreign `addr:country`, plus many without one). Solved (schema 5, `src/import/boundaries.ts`): the import loads the boundaries (`boundary=administrative`, `admin_level=2` and `4`) and assigns country and state to every entry via point in polygon (a grid per area: edge-free cells are entirely inside or outside, otherwise a ray only up to the next such cell). In the Germany extract, only Germany and its 16 states are complete; outside, the nearest boundary way with exactly one neighboring country decides (Moselle: the German and Luxembourg borders run along different banks). Loading the boundaries takes 34 s, about 300 MB. Full Germany import: 39 min instead of 30 min, max 4.2 GB RAM (before 5.4 GB), index 8.8 GB; 25.5 million entries in DE (all with a state), 73,000 in neighboring countries (CH 16,305, NL 14,208, AT 10,470, CZ 9,633, FR 8,800, PL 6,381, LU 3,426, BE 1,272, DK 1,209), 10 without a country. Checked on 2.1 million entries: deviations from `addr:country` are only corrections (Riezlern/Jungholz `DE` → `AT`, Raeren → `BE`); for addresses without `addr:country`, the postcode format always matches the country. Remainder: near tripoints, a point in a neighboring country can fall to the wrong neighbor. This does not solve "City for streets without addresses" (that would need `admin_level=8`).
- [x] **Spelling variants:** split ("Friedrich Straße") and differently joined ("Konrad-Adenauerstraße") spellings are found (schema 7): names with a base word (Straße, Allee, Platz, Gasse, Damm, Ring, Weg) are also in the index split and joined.
- [ ] **Typos in the middle of a word** ("Friedrichstrase") are not found, only at the end of a word. Would need a fuzzy search (e.g. trigrams), which makes the index considerably larger.
- [ ] **Browser and CDN cache after updates:** responses carry `Cache-Control: max-age=3600`. After an update, clients may see suggestions up to an hour old. Acceptable with daily updates; otherwise make `max-age` configurable via env.
- [ ] **Update without new data:** `update` rebuilds the index even if the extract (MD5) has not changed. Could be skipped to save compute time. Planned as part of "Diff updates" (see below).
- [ ] **`/metrics` is public:** so far only protected via the reverse proxy. If needed, a separate variable (e.g. `METRICS_TOKEN`).
- [ ] **Docker smoke test not in `npm run ci`:** it needs Docker and therefore runs separately (`npm run smoke`).

### Response quality (2026-10-29)

The response format moved away from the old flat property list towards what autosuggest clients such as Google Places Autocomplete offer (schema 8):

- [x] Every hit has `id`, `type` (`address`, `street`, `poi`, `locality`, `sublocality`, `place`), `category` (OSM tag), ready-to-display `label`, `main_text` and `secondary_text`, a structured `address` with the country name in the requested language, and `distance_m` when a location is given.
- [x] POIs beyond `amenity`: `shop`, `tourism`, `healthcare`, `office`, `leisure`, `historic`, `craft`, stations and airports (Germany: 2.0 million POIs instead of 755,000); noise such as signposts, Stolpersteine and benches is left out.
- [x] For queries with a house number, the plain address comes before shops located there.
- [x] Duplicates: the same city as a boundary and as a place node, or two nodes of one station, are shown once.
- [ ] **Bus stops and transit stops** are not searchable (named `highway=bus_stop` nodes, 53,000 in Germany; since schema 9 also subway, light rail and tram stops with `station=subway|light_rail|tram`). Would need their own type and ranking so they do not crowd out streets with the same name.
- [ ] **Opening hours, phone, website** are not part of the response; a details endpoint (`/place/<id>`) could return them.

## Prebuilt index (mount instead of import)

**Goal:** An index built elsewhere (another machine, a CI job, a previous container) can be mounted into the container. The container then only serves it: no download and no import, neither at the start nor on a schedule.

What works today: `serve` only imports when `$DATA_DIR/index.sqlite` is missing (`needsAutoImport`), so a volume that already holds an index skips the import. What is missing is an explicit mode with clear behavior and error messages, plus documentation:

- A mounted index with the wrong schema version ends up in a silent 503: the file exists, so nothing is imported, and only `/health` shows `index: false`.
- `UPDATE_CRON` together with a mounted index (often read-only) fails on every scheduled run.
- When a single file is bind-mounted (`-v ./index.sqlite:/data/index.sqlite`), an update cannot swap it via `rename` (EBUSY). If the host replaces the file, the container keeps seeing the old one, because the bind mount pins the inode. Mounting the directory is fine.

Tasks (done 2026-10-29):

- [x] New variable `INDEX_MODE` in `src/config`: `build` (default, today's behavior) or `mounted`. In `mounted` mode:
  - no automatic import, `AUTO_IMPORT` is ignored (silently: the image sets it to `true` by default, so a note would appear on every start)
  - `UPDATE_CRON` is a configuration error (fails at startup with a clear message)
  - the `import` and `update` commands refuse to run unless `--force` is given
  - `REGION_URL` is not needed and not validated
- [x] Optional `INDEX_PATH` (absolute path, default `$DATA_DIR/index.sqlite`), so that the index can be mounted somewhere other than the writable data directory, e.g. `-v /srv/doorstep:/index:ro -e INDEX_PATH=/index/index.sqlite`.
- [x] Start checks in `mounted` mode (`src/api/startup.ts`): missing file → warning in the log, 503 until it shows up (every request tries to open it). Wrong schema → error in the log naming the found and the expected version, and the process ends with exit 1, so that orchestrators notice. In `build` mode, a wrong schema is now logged at startup too, but the process keeps running (503 as before).
- [x] Opening read-only works on `:ro` mounts and with `docker run --read-only` (journal mode is `DELETE`; test that nothing else writes to `/data` or the container filesystem).
- [x] `/health` additionally reports `indexMode`, `schemaVersion` (expected by the image), `indexSchemaVersion` (found in the file, also on a mismatch) and `source`; `importedAt` was already there.
- [x] Updates in `mounted` mode come from outside: write the new file into the mounted directory as `index.next.sqlite` and `mv` it onto `index.sqlite` (same filesystem, so the rename is atomic). The API switches within 5 s or right away on `docker kill -s HUP <container>`. Never `cp` over the live file: that changes it in place while queries are reading it.
- [x] Tests: config validation (`INDEX_MODE`, `INDEX_PATH`, `mounted` + `UPDATE_CRON`), no import started in `mounted` mode even without an index, refused `import`/`update`, schema mismatch message.
- [x] Smoke test, second scenario: build the index with the mini extract in a container, start a second container with the index mounted `:ro`, `--network none` and `INDEX_MODE=mounted`, then query `/api` (proves that nothing is downloaded). Additionally `--read-only`, and `update` in the container must fail.
- [x] README: section "Using a prebuilt index" with
  - building it: `docker run --rm -v ./index:/data <image> import`, including the time and RAM it needs
  - mounting it, and why a directory mount beats a file mount
  - the update procedure (`mv`, SIGHUP)
  - schema compatibility: the image tag must match the index's schema version

**Done when:** `docker run --network none -v ./index:/data:ro -e INDEX_MODE=mounted -p 2322:2322 <image>` answers `/api` with the mounted index, the logs show no download or import attempt, and a mounted index with the wrong schema produces a clear error message.

### Further ideas

- [ ] **Download a prebuilt index (`INDEX_URL`)** instead of the PBF: one machine builds, many instances only fetch. Load `index.sqlite.gz` or a similar compressed file plus a checksum (`.sha256`), check the schema version before swapping, and update via `UPDATE_CRON` by fetching the new index instead of rebuilding. Saves about 30 min and 3–4 GB RAM per instance.
- [ ] **`doorstep info` command:** prints the index metadata (schema version, region, extract MD5, build time, number of entries) and exits non-zero if the image cannot read the index. Useful in CI before a mounted index goes live.
- [ ] **Open with `immutable=1`** (SQLite URI) in `mounted` mode: no file locking, so it is somewhat faster and works on read-only media. Safe because updates arrive as a new file via `rename` and are opened anew. First check whether `node:sqlite` accepts URI filenames.
- [ ] **Warm-up after the start:** right after an import, single queries take up to 385 ms because the file is not yet in the page cache. With a mounted index this happens on every container start. Optionally (`INDEX_WARMUP=true`), read the index once or run a few typical queries before `/health` reports `index: true`.
- [ ] **Several containers on one mounted index:** read-only sharing is safe and adds throughput without worker threads (see "Throughput on large indexes"). Document it, and warn that SQLite on network filesystems (NFS/SMB) is slow and unreliable with locking; a local disk is recommended.
- [ ] **Image with a baked-in index** (`FROM <image>` plus `COPY index.sqlite /data/`) for small regions: starts without any volume. Not sensible for Germany (10 GB image).

## Diff updates (download only the changes)

**Goal:** `update` downloads only the daily changes since the last extract instead of the whole PBF again (Germany: over 4 GB per update). The index is still rebuilt completely; this saves download volume and time, not the import itself (Germany: about 34 min).

Background: Geofabrik publishes daily change files (osmChange, `.osc.gz`) for every extract under `<region>-updates/` (e.g. `https://download.geofabrik.de/europe/germany-updates/`), each with a sequence number and a `state.txt`. The extract's PBF header names the replication base URL and the sequence number it was built from (`osmosis_replication_base_url`, `osmosis_replication_sequence_number`; readable via `osmium fileinfo -g`). `osmium apply-changes` (already in the image) applies the changes to the PBF. The extract stays on the volume as `/data/extract.osm.pbf` after every import.

Decided against: updating the index itself from the diffs (the way Nominatim does). The IDs are assigned by importance and the search relies on that order; a moved node changes the geometry of every way it belongs to; changed boundaries change country, state, city and postcode of many entries; the word statistics and values merged across entries (city of a street) would have to be kept in sync. That would need a permanent store of all node coordinates (several GB) and much more code, for little gain with daily updates that already run in the background without downtime.

Tasks:

- [ ] Read the replication URL and sequence number from the header of `extract.osm.pbf` (`osmium fileinfo -g header.option.osmosis_replication_base_url` and `…sequence_number`). Without them (extract not from Geofabrik, or `--input`), fall back to the full download.
- [ ] Read the latest sequence number from `<base>/state.txt` and download the missing change files `<base>/000/004/321.osc.gz` (path from the 9-digit number), each with its `.state.txt`. Verify each file (Geofabrik provides `.md5` where available; at least check that gzip decompresses).
- [ ] Apply them with `osmium apply-changes extract.osm.pbf *.osc.gz -o extract.next.osm.pbf` and write the new sequence number into the header (`--output-header=osmosis_replication_sequence_number=…` and the timestamp), then swap via `rename`. On errors, keep the old extract and fall back to the full download.
- [ ] Nothing new (sequence unchanged): skip the rebuild entirely and log it. This also solves "Update without new data" (phase 6).
- [ ] Fall back to the full download when too many diffs are missing (e.g. more than 30 days, configurable only if needed), when a diff is no longer on the server, or when applying fails.
- [ ] Periodic full download to limit drift: applied diffs can differ slightly from a fresh extract, mostly for objects at the region's border (Geofabrik cuts every diff to the region polygon). For example, a full download when the local extract is older than 30 days (counted from the last full download, stored next to the extract).
- [ ] Keep the existing behavior and locks: one import at a time, swap of the index via `rename`, the old index stays active on errors. `INDEX_MODE=mounted` is not affected (no updates in the container).
- [ ] Log and metrics: number of diffs, bytes downloaded, full vs. diff download (e.g. `doorstep_update_downloads_total{kind="diff"|"full"}`).
- [ ] Disk space: applying the diffs needs a second PBF temporarily (Germany about 4 GB more); mention it in the README next to RAM and disk needs.
- [ ] Tests: header parsing, sequence number → path, choice between diff, full download and skip, fallback on missing or broken diffs. Test fixture: a mini extract with a matching small `.osc.gz` (built with `osmium derive-changes` from two versions of the fixture), served by a local HTTP server as in `download.test.ts`.
- [ ] Smoke test: the `update` in the running container uses a diff from the helper file server and the index changes (new `importedAt`, an object added by the diff can be found).
- [ ] Measure on Germany: size of a daily diff, time to download and apply, compared with the full download.

Open questions:

- Does Geofabrik's Germany extract carry the replication headers reliably (check with `osmium fileinfo` on a current download)?
- Is `osmium apply-changes` on the 4 GB PBF fast enough (expected: a few minutes) and how much RAM does it need?
- Use the daily diffs, or also offer minutely/hourly ones from planet.openstreetmap.org? Those are not cut to the region and would make the extract grow beyond it; only daily Geofabrik diffs for now.

**Done when:** a second `update` on the Germany extract downloads only the daily diffs instead of over 4 GB, the new index contains the changes, an `update` without new diffs skips the rebuild, and a missing diff leads to the full download instead of an error.
