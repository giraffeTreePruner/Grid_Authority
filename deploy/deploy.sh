#!/usr/bin/env bash
#
# Build and restart, on the host, from a checkout that is already up to date.
#
# Deliberately not a one-command "deploy from my laptop": the migration step needs a
# decision if it fails, and a script that hides that is worse than a short checklist.
#
# Usage:  sudo -u grid -H ./deploy/deploy.sh
#
# -H matters: without it HOME points at the invoking user's home, which grid cannot
# write to, and pnpm, uv and PM2 all keep state there.
set -euo pipefail

ROOT="${GRID_ROOT:-/srv/grid-authority}"
cd "$ROOT"

# Placeholders that have to be edited by hand are the ones that never are. The nginx
# config is substituted during install for this reason; these env values cannot be, so
# they are checked instead. PUBLIC_BASE_URL reaching production unedited is silent:
# the site serves fine, because same-origin requests never consult CORS, and only the
# Access-Control-Allow-Origin header gives it away.
for file in .env .env.api; do
    if [ -f "$ROOT/$file" ] && grep -q 'grid\.example\.org\|THE_PASSWORD_YOU_CHOSE' "$ROOT/$file"; then
        echo "FAILED: $file still holds an example value:" >&2
        grep -n 'grid\.example\.org\|THE_PASSWORD_YOU_CHOSE' "$ROOT/$file" | sed 's/^/  /' >&2
        echo "Edit it before deploying. See docs/RUNBOOK.md 2.7." >&2
        exit 1
    fi
done

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

# What this check is for: did the new code come up and can it reach the database.
#
# Not whether the data is fresh. /health answers 503 when any source has not succeeded
# in six hours, which is a true statement about the data and says nothing about the
# deploy — during a long backfill the poll job routinely falls that far behind. With
# `curl -f` that 503 aborted a deploy that had in fact worked.
#
# So: retry until the API answers at all, then judge the body.
body=""
code=""
for attempt in 1 2 3 4 5 6 7 8 9 10; do
    code=$(curl -sS -o /tmp/grid-health.$$ -w '%{http_code}' \
        http://127.0.0.1:3000/api/v1/health 2>/dev/null) || code="000"
    body=$(cat /tmp/grid-health.$$ 2>/dev/null || true)
    [ "$code" != "000" ] && break
    echo "    no answer yet (attempt $attempt), waiting"
    sleep 2
done
rm -f /tmp/grid-health.$$

if [ "$code" = "000" ]; then
    echo "FAILED: the API never answered. Check: sudo -u grid -H pm2 logs api" >&2
    exit 1
fi

echo "    $body" | head -c 400
echo

case "$body" in
    *'"db":"up"'*) ;;
    *)
        echo "FAILED: the API is up but cannot reach the database." >&2
        exit 1
        ;;
esac

case "$body" in
    *'"status":"ok"'*)
        echo "==> done"
        ;;
    *)
        echo
        echo "Deployed. The API is serving and the database is reachable, but a source"
        echo "is stale or no job has run yet, so /health reports ${code}. That is about"
        echo "the data, not this deploy. Check with: sudo -u grid -H pm2 logs scheduler"
        ;;
esac
