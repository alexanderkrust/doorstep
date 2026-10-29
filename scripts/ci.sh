#!/bin/sh
# CI run: lint, type check, tests, build. Stops at the first failure.
set -eu
cd "$(dirname "$0")/.."

echo "==> lint";      npm run lint
echo "==> typecheck"; npm run typecheck
echo "==> test";      npm run test
echo "==> build";     npm run build
echo "==> CI passed"
