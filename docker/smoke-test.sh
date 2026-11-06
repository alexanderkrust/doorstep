#!/bin/sh
# Smoke test for the Docker image: build, start with a mini extract, query /api.
#
#   sh docker/smoke-test.sh
#
# Same flow as the first start on a fresh machine: empty volume, `serve` finds no index
# and imports in the background via REGION_URL. At the end, a second container serves the
# built index as a prebuilt one (INDEX_MODE=mounted): read-only, without network. A helper
# container from the same image
# serves the extract (test/fixtures/koenigsallee.osm.pbf with a replication header) and a diff
# (test/fixtures/koenigsallee-diff.osc.gz) over HTTP, so the test works
# without internet access to Geofabrik.
#
# ENV: IMAGE (Default doorstep:smoke), SMOKE_PORT (Default 23220), SKIP_BUILD=1
set -eu
cd "$(dirname "$0")/.."

IMAGE=${IMAGE:-doorstep:smoke}
PORT=${SMOKE_PORT:-23220}
ID=doorstep-smoke-$$
NET=$ID-net
VOLUME=$ID-data
API=$ID-api
FILES=$ID-files
MOUNTED=$ID-mounted
# Container whose logs `fail` prints.
LOGS_OF=$ID-api

cleanup() {
  docker rm -f "$API" "$FILES" "$MOUNTED" >/dev/null 2>&1 || true
  [ -n "${SITE:-}" ] && rm -rf "$SITE"
  true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

fail() {
  echo "ERROR: $*" >&2
  echo "--- Logs $LOGS_OF ---" >&2
  docker logs "$LOGS_OF" >&2 2>&1 || true
  exit 1
}

# Waits up to $1 seconds until command $2... succeeds.
wait_for() {
  seconds=$1
  shift
  i=0
  while [ "$i" -lt "$seconds" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  echo "==> docker build -t $IMAGE ."
  docker build -t "$IMAGE" .
fi

echo "==> Checking image: user, osmium, SQLite with FTS5 and R*Tree"
[ "$(docker run --rm "$IMAGE" id -u)" != 0 ] || fail "Container runs as root"
docker run --rm "$IMAGE" osmium --version >/dev/null || fail "osmium missing"
docker run --rm "$IMAGE" node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE f USING fts5(x); CREATE VIRTUAL TABLE r USING rtree(id, a, b);');
" || fail "SQLite without FTS5/R*Tree"

docker network create "$NET" >/dev/null
docker volume create "$VOLUME" >/dev/null

# The "Geofabrik" of the test: the mini extract with a replication header (sequence 100) and
# its updates folder, where the diff with sequence 101 is published before the update.
SITE=$(mktemp -d)
mkdir -p "$SITE/updates/000/000"
cp test/fixtures/koenigsallee.osm.pbf "$SITE/source.osm.pbf"
docker run --rm -v "$SITE:/site" -u "$(id -u):$(id -g)" "$IMAGE" \
  osmium cat /site/source.osm.pbf -o /site/region-latest.osm.pbf \
  "--output-header=osmosis_replication_base_url=http://$FILES:8080/updates" \
  --output-header=osmosis_replication_sequence_number=100 >/dev/null ||
  fail "Could not prepare the extract with a replication header"
printf 'sequenceNumber=100\ntimestamp=2026-11-04T21\\:21\\:03Z\n' >"$SITE/updates/state.txt"
chmod -R a+rX "$SITE"

echo "==> Starting file server with the mini extract"
docker run -d --name "$FILES" --network "$NET" \
  -v "$SITE:/site:ro" "$IMAGE" \
  node -e "
    const fs = require('node:fs');
    require('node:http').createServer((req, res) => {
      const file = '/site' + req.url;
      if (req.url.includes('..') || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('content-length', fs.statSync(file).size);
      fs.createReadStream(file).pipe(res);
    }).listen(8080);
  " >/dev/null

echo "==> docker run -p $PORT:2322 -v $VOLUME:/data $IMAGE"
docker run -d --name "$API" --network "$NET" -p "$PORT:2322" -v "$VOLUME:/data" \
  -e REGION_URL="http://$FILES:8080/region-latest.osm.pbf" \
  -e API_KEYS=smoke-key -e RATE_LIMIT_API_KEY=1000000 -e RATE_LIMIT=60 \
  --health-interval=2s --health-start-period=5s \
  "$IMAGE" >/dev/null

BASE=http://127.0.0.1:$PORT

wait_for 30 curl -fsS "$BASE/health" || fail "/health does not answer"
wait_for 120 sh -c "curl -fsS '$BASE/health' | grep -q '\"index\":true'" ||
  fail "No index after 120 s"
echo "    /health: $(curl -fsS "$BASE/health")"

echo "==> GET /api?q=Königsall"
BODY=$(curl -fsS "$BASE/api?q=K%C3%B6nigsall&limit=3") || fail "/api returns an error"
echo "$BODY" | grep -q '"name":"Königsallee"' || fail "Königsallee not found: $BODY"
echo "$BODY" | grep -q '© OpenStreetMap contributors' || fail "Attribution missing: $BODY"

echo "==> GET /reverse"
curl -fsS "$BASE/reverse?lat=51.2235&lon=6.7795" | grep -q '"type":"Feature"' ||
  fail "/reverse without hits"

echo "==> HEALTHCHECK"
wait_for 30 sh -c "[ \"\$(docker inspect -f '{{.State.Health.Status}}' $API)\" = healthy ]" ||
  fail "Container does not become healthy"

echo "==> GET /metrics"
curl -fsS "$BASE/metrics" | grep -q '^doorstep_index_available 1$' || fail "/metrics without index status"

echo "==> GET /openapi.json and /docs (Swagger UI from the image)"
curl -fsS "$BASE/openapi.json" | grep -q '"openapi":"3.1.0"' || fail "/openapi.json missing"
curl -fsS "$BASE/docs" | grep -q 'swagger-ui-bundle.js' || fail "/docs missing"
curl -fsS -o /dev/null "$BASE/docs/swagger-ui-bundle.js" || fail "Swagger UI files missing in the image"

echo "==> update without new diffs: no rebuild"
docker exec "$API" doorstep update 2>&1 | grep -q 'nothing to rebuild' ||
  fail "update without new diffs rebuilt the index"

echo "==> update with a diff in the running container, with constant requests meanwhile"
cp test/fixtures/koenigsallee-diff.osc.gz "$SITE/updates/000/000/101.osc.gz"
printf 'sequenceNumber=101\ntimestamp=2026-11-05T21\\:21\\:03Z\n' >"$SITE/updates/state.txt"
chmod -R a+rX "$SITE"
TMP=$(mktemp -d)
IMPORTED_BEFORE=$(curl -fsS "$BASE/health" | sed -n 's/.*"importedAt":"\([^"]*\)".*/\1/p')
(
  while [ ! -f "$TMP/stop" ]; do
    curl -fsS -o /dev/null -H 'X-API-Key: smoke-key' "$BASE/api?q=K%C3%B6nigsall" ||
      echo fail >>"$TMP/failures"
    echo ok >>"$TMP/requests"
  done
) &
LOOP=$!
docker exec "$API" doorstep update >"$TMP/update.log" 2>&1 || fail "update failed: $(cat "$TMP/update.log")"
grep -q 'Downloaded 1 diff' "$TMP/update.log" || fail "update did not use the diff: $(cat "$TMP/update.log")"
wait_for 15 sh -c "curl -fsS '$BASE/metrics' | grep -q '^doorstep_index_reloads_total 1$'" ||
  fail "New index was not loaded without a restart"
touch "$TMP/stop"
wait "$LOOP"
REQUESTS=$(wc -l <"$TMP/requests" | tr -d ' ')
FAILURES=$(cat "$TMP/failures" 2>/dev/null | wc -l | tr -d ' ')
rm -rf "$TMP"
curl -fsS "$BASE/api?q=Diffweg" | grep -q '"name":"Diffweg"' || fail "Diffweg from the diff not found"
IMPORTED_AFTER=$(curl -fsS "$BASE/health" | sed -n 's/.*"importedAt":"\([^"]*\)".*/\1/p')
echo "    $REQUESTS requests during the update, $FAILURES failed"
echo "    importedAt: $IMPORTED_BEFORE -> $IMPORTED_AFTER"
[ "$FAILURES" = 0 ] || fail "$FAILURES requests failed during the update"
[ "$IMPORTED_BEFORE" != "$IMPORTED_AFTER" ] || fail "importedAt did not change"

echo "==> Rate limit without an API key (RATE_LIMIT=60)"
LIMITED=0
i=0
while [ "$i" -lt 70 ]; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api?q=K%C3%B6nigsall")
  [ "$CODE" = 429 ] && LIMITED=$((LIMITED + 1))
  i=$((i + 1))
done
[ "$LIMITED" -gt 0 ] || fail "No 429 after 70 requests"
echo "    $LIMITED of 70 requests rejected with 429"

echo "==> Restart uses the existing index (no new import)"
docker restart "$API" >/dev/null
wait_for 30 sh -c "curl -fsS '$BASE/health' | grep -q '\"index\":true,\"importing\":false'" ||
  fail "No index after restart"
curl -fsS "$BASE/api?q=K%C3%B6nigsall" | grep -q '"name":"Königsallee"' ||
  fail "No hits after restart"

echo "==> Prebuilt index: read-only, without network (INDEX_MODE=mounted)"
docker stop "$API" >/dev/null
LOGS_OF=$MOUNTED
docker run -d --name "$MOUNTED" --network none --read-only \
  -v "$VOLUME:/index:ro" -e INDEX_MODE=mounted -e INDEX_PATH=/index/index.sqlite \
  "$IMAGE" >/dev/null
# Without network there is no published port: query from inside the container.
inside() {
  docker exec "$MOUNTED" node -e "
    fetch('http://127.0.0.1:2322$1').then(async (r) => {
      process.stdout.write(await r.text());
      process.exit(r.ok ? 0 : 1);
    }, () => process.exit(1));"
}
wait_for 30 inside /health || fail "/health does not answer with a mounted index"
inside /health | grep -q '"index":true,"importing":false' || fail "Mounted index not available"
inside /health | grep -q '"indexMode":"mounted"' || fail "/health does not report INDEX_MODE"
inside '/api?q=K%C3%B6nigsall&limit=3' | grep -q '"name":"Königsallee"' ||
  fail "No hits from the mounted index"
if docker logs "$MOUNTED" 2>&1 | grep -q 'Downloading\|starting import'; then
  fail "Download or import started despite INDEX_MODE=mounted"
fi
if docker exec "$MOUNTED" doorstep update >/dev/null 2>&1; then
  fail "update ran despite INDEX_MODE=mounted"
fi

echo "==> Smoke test passed"
