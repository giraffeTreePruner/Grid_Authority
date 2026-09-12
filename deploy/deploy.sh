#!/usr/bin/env bash
#
# Build and restart, on the host, from a checkout that is already up to date.
#
# Deliberately not a one-command "deploy from my laptop": the migration step needs a
# decision if it fails, and a script that hides that is worse than a short checklist.
#
# Usage:  sudo -u grid ./deploy/deploy.sh
set -euo pipefail

ROOT="${GRID_ROOT:-/srv/grid-authority}"
cd "$ROOT"

echo "==> installing dependencies"
pnpm install --frozen-lockfile
uv sync --all-groups --frozen

echo "==> applying migrations"
# Run before the new code starts, so the schema is never behind the code reading it.
uv run --env-file .env eia migrate up

echo "==> syncing the zone registry"
uv run --env-file .env eia sync-zones

echo "==> building"
pnpm --filter @grid-authority/api build
pnpm --filter @grid-authority/scheduler build
pnpm --filter @grid-authority/web build

echo "==> validating the geometry artifact"
node geo/build/validate.js

echo "==> reloading processes"
# reload, not restart: the API is clustered, so this is zero-downtime.
pm2 reload ecosystem.config.cjs --update-env
pm2 save

echo "==> checking health"
sleep 3
curl -fsS http://127.0.0.1:3000/api/v1/health | head -c 400
echo
echo "==> done"
