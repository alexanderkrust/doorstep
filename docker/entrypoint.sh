#!/bin/sh
# Einstieg des Images, auch im Container als `doorstep` aufrufbar:
#   serve (Standard)  API starten; ohne Index läuft der Import im Hintergrund (AUTO_IMPORT)
#   import [--region <url>] [--input <datei>]  Index bauen
#   update            Extrakt neu laden und Index austauschen
# Alles andere wird unverändert ausgeführt (z. B. `sh` zur Fehlersuche).
set -eu

if [ "$#" -eq 0 ]; then
  set -- serve
fi

case "$1" in
  serve | import | update)
    exec node /app/dist/index.js "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
