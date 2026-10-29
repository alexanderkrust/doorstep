#!/bin/sh
# Smoke test for the Docker image: build, start with a mini extract, query /api.
#
#   sh docker/smoke-test.sh
#
# Same flow as the first start on a fresh machine: empty volume, `serve` finds no index
# and imports in the background via REGION_URL. A helper container from the same image
# serves the extract (test/fixtures/koenigsallee.osm.pbf) over HTTP, so the test works
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

cleanup() {
  docker rm -f "$API" "$FILES" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

fail() {
  echo "ERROR: $*" >&2
  echo "--- Logs $API ---" >&2
  docker logs "$API" >&2 2>&1 || true
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

echo "==> Starting file server with the mini extract"
docker run -d --name "$FILES" --network "$NET" \
  -v "$PWD/test/fixtures:/fixtures:ro" "$IMAGE" \
  node -e "
    const fs = require('node:fs');
    require('node:http').createServer((req, res) => {
      const file = '/fixtures' + req.url;
      if (!req.url.endsWith('.osm.pbf') || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
      res.setHeader('content-length', fs.statSync(file).size);
      fs.createReadStream(file).pipe(res);
    }).listen(8080);
  " >/dev/null

echo "==> docker run -p $PORT:2322 -v $VOLUME:/data $IMAGE"
docker run -d --name "$API" --network "$NET" -p "$PORT:2322" -v "$VOLUME:/data" \
  -e REGION_URL="http://$FILES:8080/koenigsallee.osm.pbf" \
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

echo "==> update in the running container, with constant requests meanwhile"
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
docker exec "$API" doorstep update >/dev/null || fail "update failed"
wait_for 15 sh -c "curl -fsS '$BASE/metrics' | grep -q '^doorstep_index_reloads_total 1$'" ||
  fail "New index was not loaded without a restart"
touch "$TMP/stop"
wait "$LOOP"
REQUESTS=$(wc -l <"$TMP/requests" | tr -d ' ')
FAILURES=$(cat "$TMP/failures" 2>/dev/null | wc -l | tr -d ' ')
rm -rf "$TMP"
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

echo "==> Smoke test passed"
