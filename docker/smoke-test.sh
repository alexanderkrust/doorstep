#!/bin/sh
# Smoke-Test für das Docker-Image: bauen, mit Mini-Extrakt starten, /api abfragen.
#
#   sh docker/smoke-test.sh
#
# Ablauf wie beim ersten Start auf einer frischen Maschine: leeres Volume, `serve`
# findet keinen Index und importiert im Hintergrund über REGION_URL. Den Extrakt
# (test/fixtures/koenigsallee.osm.pbf) liefert ein Hilfscontainer aus demselben
# Image per HTTP, damit der Test ohne Internetzugriff auf Geofabrik auskommt.
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
  echo "FEHLER: $*" >&2
  echo "--- Logs $API ---" >&2
  docker logs "$API" >&2 2>&1 || true
  exit 1
}

# Wartet bis zu $1 Sekunden, bis Kommando $2... erfolgreich ist.
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

echo "==> Prüfe Image: Nutzer, osmium, SQLite mit FTS5 und R*Tree"
[ "$(docker run --rm "$IMAGE" id -u)" != 0 ] || fail "Container läuft als root"
docker run --rm "$IMAGE" osmium --version >/dev/null || fail "osmium fehlt"
docker run --rm "$IMAGE" node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE f USING fts5(x); CREATE VIRTUAL TABLE r USING rtree(id, a, b);');
" || fail "SQLite ohne FTS5/R*Tree"

docker network create "$NET" >/dev/null
docker volume create "$VOLUME" >/dev/null

echo "==> Starte Dateiserver mit dem Mini-Extrakt"
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
  --health-interval=2s --health-start-period=5s \
  "$IMAGE" >/dev/null

BASE=http://127.0.0.1:$PORT

wait_for 30 curl -fsS "$BASE/health" || fail "/health antwortet nicht"
wait_for 120 sh -c "curl -fsS '$BASE/health' | grep -q '\"index\":true'" ||
  fail "Index nach 120 s nicht vorhanden"
echo "    /health: $(curl -fsS "$BASE/health")"

echo "==> GET /api?q=Königsall"
BODY=$(curl -fsS "$BASE/api?q=K%C3%B6nigsall&limit=3") || fail "/api liefert einen Fehler"
echo "$BODY" | grep -q '"name":"Königsallee"' || fail "Königsallee nicht gefunden: $BODY"
echo "$BODY" | grep -q '© OpenStreetMap contributors' || fail "Attribution fehlt: $BODY"

echo "==> GET /reverse"
curl -fsS "$BASE/reverse?lat=51.2235&lon=6.7795" | grep -q '"type":"Feature"' ||
  fail "/reverse ohne Treffer"

echo "==> HEALTHCHECK"
wait_for 30 sh -c "[ \"\$(docker inspect -f '{{.State.Health.Status}}' $API)\" = healthy ]" ||
  fail "Container wird nicht healthy"

echo "==> update im laufenden Container"
docker exec "$API" doorstep update >/dev/null || fail "update fehlgeschlagen"

echo "==> Neustart nutzt den vorhandenen Index (kein erneuter Import)"
docker restart "$API" >/dev/null
wait_for 30 sh -c "curl -fsS '$BASE/health' | grep -q '\"index\":true,\"importing\":false'" ||
  fail "Nach Neustart kein Index"
curl -fsS "$BASE/api?q=K%C3%B6nigsall" | grep -q '"name":"Königsallee"' ||
  fail "Nach Neustart keine Treffer"

echo "==> Smoke-Test erfolgreich"
