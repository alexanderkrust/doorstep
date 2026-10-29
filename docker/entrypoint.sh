#!/bin/sh
# Entry point of the image, also callable as `doorstep` inside the container:
#   serve (default)  start the API; without an index, the import runs in the background (AUTO_IMPORT),
#                    unless INDEX_MODE=mounted (prebuilt index, no download or import)
#   import [--region <url>] [--input <file>]  build the index
#   update           download the extract again and swap the index
# Anything else is run unchanged (e.g. `sh` for debugging).
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
