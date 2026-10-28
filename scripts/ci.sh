#!/bin/sh
# CI-Lauf: Lint, Typprüfung, Tests, Build. Bricht beim ersten Fehler ab.
set -eu
cd "$(dirname "$0")/.."

echo "==> lint";      npm run lint
echo "==> typecheck"; npm run typecheck
echo "==> test";      npm run test
echo "==> build";     npm run build
echo "==> CI erfolgreich"
