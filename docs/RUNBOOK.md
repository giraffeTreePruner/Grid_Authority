# Runbook

Everything needed to build this host from nothing, and to operate it afterwards. If a
step here is wrong or missing, that is a bug in this file.

Target: Ubuntu 24.04, 2 vCPU, 4 GB, with Cloudflare in front of nginx.

---

## Part 1 — Local development

Prerequisites: Node 22 (`.nvmrc`), Python 3.11 (`.python-version`), pnpm, uv, Docker.

```sh
git clone https://github.com/giraffeTreePruner/Grid_Authority.git
cd Grid_Authority
cp .env.example .env          # fill in EIA_API_KEY; DATABASE_URL is below
pnpm install
uv sync --all-groups
docker compose up -d db
```

For the Compose database:

```
DATABASE_URL=postgresql://grid:grid@localhost:5432/grid_authority
```

Then:

```sh
uv run --env-file .env eia migrate up
uv run --env-file .env eia sync-zones
```

### Running it

Two terminals:

```sh
uv run --env-file .env node packages/api/dist/index.js   # after: pnpm --filter @grid-authority/api build
pnpm --filter @grid-authority/web dev                     # http://localhost:5173
```

The Vite dev server proxies `/api` to port 3000, so the browser sees one origin and CORS
behaves as it does in production.

With no ingest yet the map is empty and `/health` reports `starting`. Two ways to get
data into it:

**Without an API key**, load the recorded fixtures:

```sh
uv run --env-file .env eia seed-fixtures
```

Real EIA responses, frozen at the hour they were recorded, written through the normal
ingest path. The map will show a stale banner, which is itself worth seeing.

**With a key** in `.env`, fetch current data:

```sh
uv run --env-file .env eia poll              # one cycle, about 9 requests
uv run --env-file .env eia backfill --days 7 # a week of history
```

### Checks

```sh
pnpm format && pnpm lint && pnpm typecheck && pnpm test
uv run ruff format --check . && uv run ruff check . && uv run mypy . && uv run pytest
node geo/build/validate.js
```

---

## Part 2 — Building the host

### 2.1 Users and packages

```sh
adduser --system --group --home /srv/grid-authority grid
apt update && apt install -y curl git nginx postgresql-16 ufw

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
corepack enable && corepack prepare pnpm@10.4.1 --activate

curl -LsSf https://astral.sh/uv/install.sh | sh
install -m 0755 ~/.local/bin/uv /usr/local/bin/uv

npm install -g pm2
```

Confirm: `node -v` is 22.x, `uv --version` works, `psql --version` is 16.x.

### 2.2 Firewall

```sh
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

Postgres is not exposed: it listens on localhost only, which is the default.

### 2.3 Timezone

```sh
timedatectl set-timezone UTC
```

Everything in this project stores and reasons in UTC. A host on local time will produce
hours that are silently offset.

### 2.4 Database

```sh
sudo -u postgres psql <<'SQL'
CREATE DATABASE grid_authority TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';
ALTER DATABASE grid_authority SET timezone TO 'UTC';

-- The owner runs migrations and the workers.
CREATE ROLE grid_owner LOGIN PASSWORD 'CHANGE_ME_OWNER';
ALTER DATABASE grid_authority OWNER TO grid_owner;

-- The API reads and nothing else. A read-only role means a bug in the API cannot
-- write, whatever it intends.
CREATE ROLE grid_api LOGIN PASSWORD 'CHANGE_ME_API';
SQL

sudo -u postgres psql -d grid_authority <<'SQL'
GRANT CONNECT ON DATABASE grid_authority TO grid_api;
GRANT USAGE ON SCHEMA public TO grid_api;
ALTER DEFAULT PRIVILEGES FOR ROLE grid_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO grid_api;

-- A slow query fails rather than holding a worker while the map waits.
ALTER ROLE grid_api SET statement_timeout = '5s';
ALTER ROLE grid_api SET idle_in_transaction_session_timeout = '10s';
SQL
```

`ALTER DEFAULT PRIVILEGES` only covers tables created afterwards, so run migrations
before granting on anything existing. After the first `migrate up`:

```sh
sudo -u postgres psql -d grid_authority -c \
  'GRANT SELECT ON ALL TABLES IN SCHEMA public TO grid_api;'
```

### 2.5 Checkout

```sh
sudo -u grid git clone https://github.com/giraffeTreePruner/Grid_Authority.git /srv/grid-authority
cd /srv/grid-authority
```

Environment files are written in 2.7, once the database roles exist.

### 2.6 First build and migration

```sh
cd /srv/grid-authority
sudo -u grid pnpm install --frozen-lockfile
sudo -u grid uv sync --all-groups --frozen

sudo -u grid uv run --env-file .env eia check-config
sudo -u grid uv run --env-file .env eia migrate up
sudo -u grid uv run --env-file .env eia sync-zones

sudo -u postgres psql -d grid_authority -c \
  'GRANT SELECT ON ALL TABLES IN SCHEMA public TO grid_api;'

sudo -u grid pnpm --filter @grid-authority/api build
sudo -u grid pnpm --filter @grid-authority/scheduler build
sudo -u grid pnpm --filter @grid-authority/web build
sudo -u grid node geo/build/validate.js
```

### 2.7 Two environment files

The workers write; the API must not. Each process therefore gets its own env file, and
`ecosystem.config.cjs` points Node at them with `--env-file`. No secret is written into
any committed file.

| File       | Read by                              | Database role           |
| ---------- | ------------------------------------ | ----------------------- |
| `.env`     | scheduler, and the workers it spawns | `grid_owner` — writes   |
| `.env.api` | api                                  | `grid_api` — reads only |

```sh
cd /srv/grid-authority
sudo -u grid cp deploy/grid-authority.env.example .env
sudo -u grid cp deploy/grid-authority.api.env.example .env.api
sudo -u grid chmod 600 .env .env.api
sudo -u grid "$EDITOR" .env       # EIA_API_KEY and the grid_owner password
sudo -u grid "$EDITOR" .env.api   # the grid_api password and PUBLIC_BASE_URL
```

Both are gitignored. Verify before going further:

```sh
sudo -u grid grep -c . .env .env.api        # both non-empty
git check-ignore -v .env .env.api           # both ignored
```

### 2.8 PM2

```sh
cd /srv/grid-authority
sudo -u grid pm2 start ecosystem.config.cjs
sudo -u grid pm2 save

sudo -u grid pm2 install pm2-logrotate
sudo -u grid pm2 set pm2-logrotate:max_size 10M
sudo -u grid pm2 set pm2-logrotate:retain 14
sudo -u grid pm2 set pm2-logrotate:compress true

# Survive a reboot. Run the command this prints, as root.
sudo -u grid pm2 startup systemd -u grid --hp /srv/grid-authority
```

Confirm both are online: `sudo -u grid pm2 status`.

### 2.9 TLS and nginx

```sh
apt install -y certbot python3-certbot-nginx
mkdir -p /var/www/certbot /var/cache/nginx/grid
chown -R www-data:www-data /var/cache/nginx/grid

cp deploy/nginx.conf /etc/nginx/sites-available/grid-authority
sed -i 's/grid\.example\.org/YOUR.DOMAIN/g' /etc/nginx/sites-available/grid-authority
ln -sf /etc/nginx/sites-available/grid-authority /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

certbot certonly --webroot -w /var/www/certbot -d YOUR.DOMAIN
nginx -t && systemctl reload nginx
```

`nginx -t` must pass before reloading. If it fails on `set_real_ip_from`, the
`ngx_http_realip_module` is missing — it is built into stock Ubuntu nginx, so that
usually means a custom build.

**If Cloudflare is in front**, set SSL mode to Full (strict) and leave the real-IP block
in place. **If it is not**, delete the `set_real_ip_from` and `real_ip_header` lines, or
every client will be counted as one address and the rate limits will be wrong.

### 2.10 Backfill

```sh
cd /srv/grid-authority
sudo -u grid uv run --env-file .env eia backfill --days 90
```

Roughly 540 requests, well inside the client's 500/hour ceiling per run but not per
minute — it paces itself and takes a while. It is resumable: if it is interrupted, run it
again and it skips the days already complete.

---

## Part 3 — Operating

### Deploying a change

```sh
cd /srv/grid-authority
sudo -u grid git pull
sudo -u grid ./deploy/deploy.sh
```

The script installs, migrates, syncs zones, builds, validates the geometry, reloads PM2
and checks health. `pm2 reload` is zero-downtime because the API is clustered.

### Is it healthy?

```sh
curl -s https://YOUR.DOMAIN/api/v1/health | jq
```

- `status: "ok"` — every source has succeeded within six hours.
- `status: "starting"` — no job has run yet. Normal for the first half hour only.
- `status: "degraded"` with 503 — the database is down, or a source has not succeeded in
  six hours. Check `pm2 logs scheduler`.

### What the jobs have done

```sh
sudo -u grid uv run --env-file .env python - <<'PY'
import os, psycopg
with psycopg.connect(os.environ["DATABASE_URL"]) as c, c.cursor() as cur:
    cur.execute("SELECT job, last_success_at, last_failure_at, rows_written, last_error "
                "FROM source_status ORDER BY job")
    for row in cur.fetchall():
        print(row)
PY
```

### Logs

```sh
sudo -u grid pm2 logs --lines 200
sudo -u grid pm2 logs scheduler --lines 200      # job outcomes and summaries
tail -f /var/log/nginx/grid-error.log
```

Every job logs a structured line on finishing, including its JSON summary and any
warnings. A job that fails logs its stderr with it.

### Running a job by hand

```sh
cd /srv/grid-authority
sudo -u grid uv run --env-file .env eia poll
sudo -u grid uv run --env-file .env eia probe
sudo -u grid uv run --env-file .env eia revise
```

Safe at any time: every job is idempotent, and the scheduler skips a tick if the same job
is still running.

### Rebuilding the geometry

Only when the zone registry changes. See `geo/build/README.md`. Afterwards, bump
`GEOMETRY_VERSION` in `.env` so the immutable cache is bypassed, and redeploy.

---

## Part 4 — When something is wrong

### The map is empty

Check in this order:

1. `curl -s localhost:3000/api/v1/health` — is the API up and the database reachable?
2. `curl -s 'localhost:3000/api/v1/map/snapshot' | head -c 200` — is there a snapshot?
3. `sudo -u grid pm2 logs scheduler` — has `poll` run, and did it succeed?
4. If `poll` succeeds but writes nothing, EIA may be lagging. `eia probe` then check
   `probe_log`: interchange has been observed 42 hours behind.

### A job keeps failing

`source_status.last_error` holds the reason. Common ones:

- `UnknownFacetCode` — EIA added a respondent or a fuel type. This is deliberate and
  fatal: add it to `config/zones.yaml`, `config/excluded_respondents.yaml` or
  `config/modes.yaml`, then redeploy. Do not work around it; an unmapped code silently
  distorts the data.
- `EiaRequestError: HTTP 403` — the API key is wrong or expired.
- `EiaRateLimitExceeded` — a job looped or a window was far larger than intended. The
  ceiling is self-imposed at 500/hour, well under EIA's.

### The API returns 429 to everyone

The nginx `limit_req` and the API's own limiter are both active. If the real client
address is not reaching nginx, every request counts as one client. Check that the
Cloudflare real-IP block matches how traffic actually arrives.

### Rolling back

```sh
cd /srv/grid-authority
sudo -u grid git checkout <previous-tag>
sudo -u grid ./deploy/deploy.sh
```

Migrations are reversible one step at a time:

```sh
sudo -u grid uv run --env-file .env eia migrate status
sudo -u grid uv run --env-file .env eia migrate down --steps 1
```

Reverting a migration drops its tables. Take a dump first:

```sh
sudo -u postgres pg_dump -Fc grid_authority > /var/backups/grid-$(date -u +%F).dump
```

---

## Part 5 — Environment variables

| Variable           | Used by            | Purpose                                                   |
| ------------------ | ------------------ | --------------------------------------------------------- |
| `EIA_API_KEY`      | workers            | EIA open-data key                                         |
| `DATABASE_URL`     | workers, scheduler | Owner role; migrations and writes                         |
| `PORT` / `HOST`    | api                | Listen address; 127.0.0.1 behind nginx                    |
| `NODE_ENV`         | api, scheduler     | `production` on the host                                  |
| `LOG_LEVEL`        | api, scheduler     | pino level                                                |
| `PUBLIC_BASE_URL`  | api                | Public origin; also the only CORS origin                  |
| `TZ`               | everything         | Always `UTC`                                              |
| `GEOMETRY_VERSION` | web                | Cache-buster for `zones.pmtiles`                          |
| `GRID_ROOT`        | scheduler          | Repository root the workers run from                      |
| `WORKER_COMMAND`   | scheduler          | Defaults to `uv`; set to an absolute path if PATH is thin |

---

## Part 6 — What this host does not do

Stated so nobody goes looking:

- No backups are configured. `pg_dump` above is manual. The observation data is
  reconstructible from EIA within 90 days; `forecast_issues` is **not** — it is the one
  table whose history cannot be recovered, so back it up if it matters.
- No alerting. `/api/v1/health` returns 503 when a source goes stale and is designed to
  be polled by something external.
- No log shipping. Logs are local, rotated at 10 MB with 14 kept.
