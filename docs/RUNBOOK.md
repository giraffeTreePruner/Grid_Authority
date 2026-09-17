# Runbook

Everything needed to build this host from nothing, and to operate it afterwards. If a
step here is wrong or missing, that is a bug in this file.

Target: Ubuntu 26.04, 2 vCPU, 2 GB, with Cloudflare in front of nginx.

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
sudo adduser --system --group --home /srv/grid-authority grid
sudo sudo apt update && sudo apt install -y curl git nginx ufw ca-certificates tmux
```

Postgres 16 is pinned across dev, CI and prod (see `docs/DECISIONS.md`), but a fresh
Ubuntu release's default archive only carries whatever major version was current at its
own release — not 16 specifically. Install from the PGDG repository instead, which
carries specific major versions independent of the Ubuntu release:

```sh
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
sudo sh -c 'echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
  https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo $VERSION_CODENAME)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list'
sudo apt update && sudo apt install -y postgresql-16
```

If that `apt update` fails on the codename, PGDG has not yet added support for this
Ubuntu release — check https://www.postgresql.org/download/linux/ubuntu/ for the latest
supported codename before falling back to whatever major version Ubuntu ships by
default, which would mean re-pinning it everywhere (`docker-compose.yml`, both
`postgres:16` jobs in `.github/workflows/ci.yml`, and this file).

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs
sudo corepack enable && sudo corepack prepare pnpm@10.4.1 --activate

curl -LsSf https://astral.sh/uv/install.sh | sh
sudo install -m 0755 ~/.local/bin/uv /usr/local/bin/uv

sudo npm install -g pm2
```

Confirm: `node -v` is 22.x, `uv --version` works, `psql --version` is 16.x.

### 2.2 Firewall

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Postgres is not exposed: it listens on localhost only, which is the default.

### 2.3 Timezone

```sh
sudo timedatectl set-timezone UTC
```

Everything in this project stores and reasons in UTC. A host on local time will produce
hours that are silently offset.

### 2.4 Swap

A safety net against the OOM killer taking down Postgres during a traffic burst,
autovacuum, or a backfill landing at the same time. Not meant to carry steady-state load.

4 GB, twice the RAM. That is deliberately generous for a safety net: the web build in 2.7
is a far larger and far spikier allocation than anything serving traffic does, and disk
is cheap next to a deploy that gets OOM-killed halfway through.

```sh
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# tee, not >>: a redirect runs in your unprivileged shell and is refused
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Low swappiness keeps Postgres's shared_buffers and hot pages in RAM and only swaps under
real pressure:

```sh
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

Confirm: `swapon --show` and `free -h` both show the 4G swapfile.

### 2.5 Database

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

````sh
sudo -u postgres psql -d grid_authority -c \
  'GRANT SELECT ON ALL TABLES IN SCHEMA public TO grid_api;'

The zone-detail cache is filled by `warm-zone-detail`, which runs hourly at :25. After a
deploy the cache is cold, so the panel's long windows recompute on demand until that job
has run once. To not wait:

```sh
sudo -u grid -H uv run --env-file .env eia warm-zone-detail
````

It takes about four minutes — 208 requests paced under the API's own rate limit — and
makes no EIA requests. Check what it managed with:

```sh
sudo -u postgres psql -d grid_authority -c \
  "select window_key, count(*) from zone_detail_cache group by 1 order by 1;"
```

Four rows, each counting the in-map zones. A window short of that is a zone whose build
did not finish; `select zone_key from zone_detail_cache where window_key = 'all'` names
which ones did.

````

### 2.6 Checkout

```sh
# Create the directory first, owned by grid. /srv itself is root-owned, so grid
# cannot create it, and the clone fails with "could not create leading directories".
# adduser happens to make this directory the first time, but relying on that breaks
# the moment anyone deletes it and re-clones.
#
# 755 rather than the 0750 adduser uses, so your own account can cd in and read the
# checkout. Nothing there is secret: the source is public and both env files are 600.
sudo install -d -o grid -g grid -m 755 /srv/grid-authority

sudo -u grid -H git clone https://github.com/giraffeTreePruner/Grid_Authority.git /srv/grid-authority

cd /srv/grid-authority

# Optional, but it makes `git log` and `git status` work as yourself. The checkout is
# owned by grid, and git refuses to read a repository owned by someone else without
# this. It grants read convenience only: writes still require running as grid.
git config --global --add safe.directory /srv/grid-authority
````

**Never run git here with plain `sudo`.** As root it writes root-owned objects into
`.git`, and every later pull as `grid` then fails on files it cannot touch. Git's
"dubious ownership" refusal is what stops that happening; take it as a signal to use
`sudo -u grid -H`, not as something to work around.

**Two things about every `sudo -u grid` command below**, both of which fail quietly
rather than loudly if you get them wrong.

`-H` sets `HOME` to `/srv/grid-authority`. Without it `sudo` leaves `HOME` pointing at
_your_ home directory, and the `grid` user cannot write there — so pnpm, uv and PM2 all
try to put their caches and state somewhere they have no access to. PM2 is the one that
bites hardest: it would write its process list to your home while
`pm2 startup --hp /srv/grid-authority` points systemd at grid's, so nothing would come
back after a reboot.

And run them from `/srv/grid-authority`. `sudo` does not change directory, so a command
issued from elsewhere looks for `package.json` wherever you happen to be standing.

Environment files are written in 2.8, once the database roles exist.

### 2.7 First build and migration

```sh
cd /srv/grid-authority
sudo -u grid -H pnpm install --frozen-lockfile
sudo -u grid -H uv sync --all-groups --frozen

sudo -u grid -H uv run --env-file .env eia check-config
sudo -u grid -H uv run --env-file .env eia migrate up
sudo -u grid -H uv run --env-file .env eia sync-zones

sudo -u postgres psql -d grid_authority -c \
  'GRANT SELECT ON ALL TABLES IN SCHEMA public TO grid_api;'

sudo -u grid -H pnpm --filter @grid-authority/api build
sudo -u grid -H pnpm --filter @grid-authority/scheduler build
sudo -u grid -H pnpm --filter @grid-authority/web build
sudo -u grid -H node geo/build/validate.js
```

The web build is the largest memory spike this host ever sees — larger than serving
traffic — because rollup holds the whole module graph and its source maps at once. On
2 GB it completes, but it leans on the swapfile from 2.4, so do not skip that step and
then wonder why a deploy was killed. If a build is ever OOM-killed anyway, build
elsewhere and copy `packages/web/dist`, `packages/api/dist` and
`packages/scheduler/dist` across; nothing in those directories is host-specific.

### 2.8 Two environment files

The workers write; the API must not. Each process therefore gets its own env file, and
`ecosystem.config.cjs` points Node at them with `--env-file`. No secret is written into
any committed file.

| File       | Read by                              | Database role           |
| ---------- | ------------------------------------ | ----------------------- |
| `.env`     | scheduler, and the workers it spawns | `grid_owner` — writes   |
| `.env.api` | api                                  | `grid_api` — reads only |

Neither `DATABASE_URL` is something to look up. You assemble it from the role name, the
password you chose in 2.5, and the local database:

```
postgresql://<role>:<the password you chose>@127.0.0.1:5432/grid_authority
```

Percent-encode the password if it contains `:` `/` `?` `#` `[` `]` `@` or a space. If you
no longer have it, set a new one rather than hunting for it — Postgres stores a hash, not
the password:

```sh
sudo -u postgres psql -c "ALTER ROLE grid_owner PASSWORD 'new-password';"
```

```sh
cd /srv/grid-authority
sudo -u grid -H cp deploy/grid-authority.env.example .env
sudo -u grid -H cp deploy/grid-authority.api.env.example .env.api
sudo -u grid -H chmod 600 .env .env.api
sudo -u grid -H "$EDITOR" .env       # EIA_API_KEY and the grid_owner password
sudo -u grid -H "$EDITOR" .env.api   # the grid_api password and PUBLIC_BASE_URL
```

Both are gitignored. Verify before going further:

```sh
sudo -u grid -H grep -c . .env .env.api     # both non-empty
git check-ignore -v .env .env.api           # both ignored
```

Then prove each URL connects as the role you intended, rather than finding out at the
first migration:

```sh
# must print grid_owner, and must be able to create a table
sudo -u grid -H uv run --env-file .env python -c "
import os, psycopg
with psycopg.connect(os.environ['DATABASE_URL']) as c, c.cursor() as cur:
    cur.execute('SELECT current_user'); print('.env     ->', cur.fetchone()[0])
    cur.execute('CREATE TABLE _probe (x int)'); cur.execute('DROP TABLE _probe')
    print('            can write: yes')
"

# must print grid_api, and must NOT be able to create a table
sudo -u grid -H uv run --env-file .env.api python -c "
import os, psycopg
with psycopg.connect(os.environ['DATABASE_URL']) as c, c.cursor() as cur:
    cur.execute('SELECT current_user'); print('.env.api ->', cur.fetchone()[0])
    try:
        cur.execute('CREATE TABLE _probe (x int)')
        print('            can write: YES — wrong role in .env.api')
    except Exception:
        print('            can write: no, as intended')
"
```

If `.env` reports `grid_api`, every ingest job fails and `migrate up` stops at the first
`CREATE TABLE`. That is the one mistake worth catching here rather than later.

### 2.9 PM2

```sh
cd /srv/grid-authority
sudo -u grid -H pm2 start ecosystem.config.cjs
sudo -u grid -H pm2 save

sudo -u grid -H pm2 install pm2-logrotate
sudo -u grid -H pm2 set pm2-logrotate:max_size 10M
sudo -u grid -H pm2 set pm2-logrotate:retain 14
sudo -u grid -H pm2 set pm2-logrotate:compress true

# Survive a reboot. Run the command this prints, as root.
sudo -u grid -H pm2 startup systemd -u grid --hp /srv/grid-authority
```

The command it prints starts `sudo env PATH=$PATH ...`, which bakes **your** PATH into
a service that runs as `grid`. That leaves the unit searching your home directory first
for every binary it executes, including the `uv` the scheduler spawns. Give it a system
PATH instead:

```sh
sudo env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  pm2 startup systemd -u grid --hp /srv/grid-authority

# then freeze the current process list, so `pm2 resurrect` has something to restore
sudo -u grid -H pm2 save
```

Check what was written: `grep PATH= /etc/systemd/system/pm2-grid.service` should contain
no home directory. `/usr/local/bin` must be there — that is where `uv` lives.

Confirm both are online: `sudo -u grid -H pm2 status`.

Then prove the boot path actually works, rather than finding out at the next reboot:

```sh
sudo systemctl is-enabled pm2-grid       # enabled
sudo -u grid -H pm2 kill
sudo systemctl start pm2-grid
sudo -u grid -H pm2 status               # both apps back
```

### 2.10 TLS and nginx

Two passes, because the real config cannot be enabled yet: its TLS block points at
certificate files certbot has not created, so `nginx -t` would fail. The bootstrap
config serves the ACME challenge over plain HTTP and nothing else.

Every command here needs root. Run them from `/srv/grid-authority`.

Set the domain once, in the shell you are working in. Every command below uses it, so
the config, the certificate and the checks cannot end up naming different hosts — which
is exactly the mistake that produces a working site and a certificate for the wrong name.

```sh
DOMAIN=grid.example.org      # the exact name people will type, subdomain included

sudo apt install -y certbot
sudo install -d -o www-data -g www-data /var/www/certbot
sudo install -d -o www-data -g www-data /var/cache/nginx/grid
```

**Pass one — bootstrap, then get the certificate.**

```sh
# One command, so the substitution cannot be skipped. The :? fails loudly if DOMAIN is
# unset, which happens the moment you open a new shell — without it, sed would quietly
# substitute an empty name and nginx would serve nothing.
: "${DOMAIN:?set DOMAIN first: DOMAIN=your.domain}"
sudo sh -c "sed 's/grid\.example\.org/$DOMAIN/g' deploy/nginx-bootstrap.conf \
  > /etc/nginx/sites-available/grid-authority"
sudo ln -sf /etc/nginx/sites-available/grid-authority /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t && sudo systemctl reload nginx

# confirm the challenge path is reachable before asking Let's Encrypt to use it
# The location uses `root`, so nginx appends the whole URI: the file has to sit at
# webroot + the full path, which is also the layout certbot --webroot creates.
sudo install -d -o www-data -g www-data /var/www/certbot/.well-known/acme-challenge
echo ok | sudo tee /var/www/certbot/.well-known/acme-challenge/probe >/dev/null
curl -sS "http://$DOMAIN/.well-known/acme-challenge/probe"   # must print: ok
sudo rm /var/www/certbot/.well-known/acme-challenge/probe

sudo certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN"
```

If that `curl` does not print `ok`, stop: certbot will fail the same way, and failed
attempts count against Let's Encrypt's rate limit.

A **404 from nginx** is the good failure — it means DNS resolves here, port 80 is open,
and nginx answered for this `server_name`. Only the file is in the wrong place. Anything
else (a timeout, a connection refused, a page from some other server) means the request
never arrived, so check DNS and the firewall first. This host has no `dig`; use
`getent hosts "$DOMAIN"` or `curl -sS -o /dev/null -w '%{remote_ip}\n' "http://$DOMAIN/"`.

**Pass two — swap in the real config.**

```sh
: "${DOMAIN:?set DOMAIN first: DOMAIN=your.domain}"
sudo sh -c "sed 's/grid\.example\.org/$DOMAIN/g' deploy/nginx.conf \
  > /etc/nginx/sites-available/grid-authority"

# prove the substitution landed: no placeholder may survive
sudo grep -c 'grid\.example\.org' /etc/nginx/sites-available/grid-authority   # expect 0

sudo nginx -t && sudo systemctl reload nginx
```

Then check the edge, with `-S` so a failure says so rather than printing nothing:

```sh
# twice: MISS then HIT
curl -sS -o /dev/null -D - "https://$DOMAIN/api/v1/zones" | grep -i x-cache-status
curl -sS -o /dev/null -D - "https://$DOMAIN/api/v1/zones" | grep -i x-cache-status

# must be no-store: a cached health check hides an outage
curl -sS -o /dev/null -D - "https://$DOMAIN/api/v1/health" | grep -i cache-control

curl -sS "https://$DOMAIN/robots.txt" | head -3
```

If `x-cache-status` prints nothing, the request is not reaching that location. In order of
likelihood: the bootstrap config is still installed (it has no `/api/` block at all), the
`server_name` does not match the name you typed, or the certificate is for a different
name so TLS fails before nginx routes anything. `curl -iS` without `grep` shows which.

`nginx -t` must pass before the reload. Note that `sudo nginx -t && systemctl reload
nginx` does **not** work: the `sudo` applies only to the first command and the reload is
refused. Both need it.

Renewal keeps working after the swap — `nginx.conf` serves the same challenge location,
so certbot's timer renews with nginx running and nothing to stop.

**Client addresses, and Cloudflare later.** With nothing in front, nginx sees the real
client address on the socket and the rate limits key on it correctly. When you put
Cloudflare there, that address becomes Cloudflare's and every visitor collapses into one
rate-limit bucket, so install the snippet and uncomment the include at that point:

```sh
sudo cp deploy/cloudflare-realip.conf /etc/nginx/snippets/
sudo sed -i 's|# include /etc/nginx/snippets/cloudflare-realip.conf;|include /etc/nginx/snippets/cloudflare-realip.conf;|' \
  /etc/nginx/sites-available/grid-authority
sudo nginx -t && sudo systemctl reload nginx
```

Not before. Those directives tell nginx to believe a forwarded header from those ranges;
enabling them without the proxy actually in front is the mistake that lets a client claim
any address it likes. Also set Cloudflare's SSL mode to Full (strict).

### 2.11 Backfill

This runs for 60–90 minutes, so detach it: an SSH drop would otherwise kill it partway.

Run tmux as yourself and drop to `grid` for the job itself. `grid` is a `--system`
account, so its shell is `/usr/sbin/nologin`: `sudo -u grid tmux` opens a session whose
shell exits immediately, printing `[exited]`, and leaves you typing at your own prompt as
yourself.

```sh
tmux new -s backfill
cd /srv/grid-authority && sudo -u grid -H uv run --env-file .env eia backfill --days 90
# ctrl-b d to detach; tmux attach -t backfill to return
```

`nohup` works too, and detaches without tmux at all — `bash -c` names the shell, so the
nologin shell never comes into it:

```sh
sudo -u grid -H bash -c 'cd /srv/grid-authority && \
  nohup uv run --env-file .env eia backfill --days 90 > backfill.log 2>&1 &'

tail -f /srv/grid-authority/backfill.log
```

To cover the full dataset rather than ninety days, give it a date. EIA-930 begins
2019-01-01, which is about 2,811 days and 17,000 requests — roughly five hours, paced so
it never reaches its own ceiling:

```sh
cd /srv/grid-authority && sudo -u grid -H uv run --env-file .env eia backfill --since 2019-01-01
```

Roughly 540 requests for ninety days, which is **more than the client's own 500/hour
ceiling**, so a full run raises `EiaRateLimitExceeded` partway. That ceiling is
self-imposed and sits an order of magnitude under EIA's published guidance of about
9,000/hour; it exists to make a runaway loop fail loudly. It counts in memory, so it
resets when the process exits.

When it raises, simply run the command again. It skips the days already complete, and a
second round of a few hundred requests is still far below what EIA permits.

### 2.12 Build the coarse views

The map can be read by day, week and month. Those summaries live in `map_snapshot_agg`
and are built from observations already stored, so this contacts EIA not at all and can
be run whenever. Run it once after a backfill:

```sh
cd /srv/grid-authority
sudo -u grid -H uv run --env-file .env eia rebuild-aggregates
```

From then on the poll job keeps the current day, week and month fresh by itself; this
command is only for history and for repair.

---

## Part 3 — Operating

### Deploying a change

```sh
cd /srv/grid-authority
sudo -u grid -H git pull
sudo -u grid -H ./deploy/deploy.sh
```

If `cd` is refused, the directory is still mode 0750 from `adduser`; see 2.6.

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
sudo -u grid -H uv run --env-file .env python - <<'PY'
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
sudo -u grid -H pm2 logs --lines 200
sudo -u grid -H pm2 logs scheduler --lines 200      # job outcomes and summaries
tail -f /var/log/nginx/grid-error.log
```

Every job logs a structured line on finishing, including its JSON summary and any
warnings. A job that fails logs its stderr with it.

### Running a job by hand

```sh
cd /srv/grid-authority
sudo -u grid -H uv run --env-file .env eia poll
sudo -u grid -H uv run --env-file .env eia probe
sudo -u grid -H uv run --env-file .env eia revise
sudo -u grid -H uv run --env-file .env eia rebuild-snapshots    # no EIA requests
sudo -u grid -H uv run --env-file .env eia rebuild-aggregates   # no EIA requests
sudo -u grid -H uv run --env-file .env eia warm-zone-detail      # no EIA requests
```

`warm-zone-detail` asks the local API for every bucketed zone window so it computes and
stores each one. It takes about four minutes: it is paced under the API's own rate limit,
which applies to it like any other client. The API must be up, since the job's whole
method is to make the API do the work.

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
3. `sudo -u grid -H pm2 logs scheduler` — has `poll` run, and did it succeed?
4. If `poll` succeeds but writes nothing, EIA may be lagging. `eia probe` then check
   `probe_log`: interchange has been observed 42 hours behind.

### A zone's longer windows time out

Symptom: the `90d`, `1y` or `all` window on a large zone returns 503 `timed_out`, and
often loads if you close the panel and open it again. The second attempt is reading the
cache the first one wrote on its way past the timeout.

These four windows are served from `zone_detail_cache`, refreshed hourly by
`warm-zone-detail`. If they are timing out, the cache is empty or stale:

```sh
sudo -u grid -H psql -c "SELECT window_key, count(*), min(built_at) FROM zone_detail_cache GROUP BY 1 ORDER BY 1"
```

Expect four rows, one per window, each with as many entries as there are in-map zones,
built within the hour. If they are older than that, check whether the job is running
(`sudo -u grid -H pm2 logs scheduler | grep warm`) and run it by hand. An entry older
than 24 hours is ignored and recomputed, so a stopped warmer shows up as slowness first
and errors after.

Responses carry `X-Cache: stored` or `computed`, which says which path answered.

### Permission denied on the checkout

`fatal: could not create leading directories of '/srv/grid-authority': Permission denied`
means the directory does not exist and `grid` cannot create it, because `/srv` is
root-owned. This is what happens on a re-clone after deleting the checkout. Create it
first:

```sh
sudo install -d -o grid -g grid -m 755 /srv/grid-authority
```

`cd: /srv/grid-authority: Permission denied` is the other half of the same thing: the
directory exists but is mode 0750 from `adduser`, and your account is not `grid`. The
same `install -d` command above fixes the mode; the two env files are 600 and stay
unreadable either way.

If a command then fails with `EACCES` on a path under _your_ home — pnpm looking for
`package.json`, uv looking for `uv.toml`, PM2 writing its process list — one of two
things happened: the command ran from the wrong directory, or it ran without `-H` and
inherited your `HOME`. Both are covered in 2.6.

### `cannot load certificate .../grid.example.org/...`

The config was installed without substituting the domain, so it still names the example
host and points at a certificate that does not exist. Install it again — the command in
2.10 substitutes while it copies, so the two cannot come apart:

```sh
: "${DOMAIN:?set DOMAIN first: DOMAIN=your.domain}"
sudo sh -c "sed 's/grid\.example\.org/$DOMAIN/g' deploy/nginx.conf \
  > /etc/nginx/sites-available/grid-authority"
sudo nginx -t && sudo systemctl reload nginx
```

If the same message says `Permission denied` rather than `No such file`, `nginx -t` was
run without `sudo`: an unprivileged process cannot read `/etc/letsencrypt` at all, so it
reports the wrong reason for the right problem.

### A check prints nothing at all

`curl -s ... | grep -i x-cache-status` printing nothing means one of four things, and
`-s` is hiding which: it silences DNS failures, refused connections and TLS errors
alike. Drop the pipe and the `-s`:

```sh
curl -iS "https://$DOMAIN/api/v1/zones" | head -20
```

- **503 "not configured yet"** — the bootstrap config is still installed. It has no
  `/api/` block, so there is no `X-Cache-Status` to print. Do pass two of 2.10.
- **A certificate name mismatch** — the certificate was issued for a different name than
  the one you are requesting. `sudo certbot certificates` lists what exists; reissue for
  the exact name, subdomain included.
- **A default nginx page, or a connection that hangs** — `server_name` does not match
  what you typed, so another server block answered.
  `sudo grep server_name /etc/nginx/sites-available/grid-authority` shows what it is set
  to.
- **502** — nginx is fine and the API is not.
  `curl -sS localhost:3000/api/v1/health` and `sudo -u grid -H pm2 status`.

### `git pull` refuses, one way or the other

Two different refusals, both correct.

`cannot open '.git/FETCH_HEAD': Permission denied` — you are not `grid`, and the checkout
belongs to `grid`. `fatal: detected dubious ownership` — you used `sudo`, so git is
running as root against a repository owned by `grid`, and refuses.

Either way the answer is the same:

```sh
sudo -u grid -H git -C /srv/grid-authority pull
```

Adding `safe.directory` to your own config does not help `sudo git pull`, because root
reads its own config. And do not add it for root: git's refusal is the only thing
stopping root from writing objects into `.git` that `grid` will later be unable to
update. If that has already happened, `sudo chown -R grid:grid /srv/grid-authority`
puts it right.

### `tmux` prints `[exited]` and drops me back at my own prompt

`sudo -u grid tmux` was used. `grid` is a system account with `/usr/sbin/nologin`, so the
session's shell exits the moment it starts. The next command you type then runs as _you_,
and fails on `.env`, which is mode 600 and owned by `grid`.

Run tmux as yourself and put the `sudo -u grid -H` on the job inside it; see 2.11.

### The CORS header names the wrong site

`Access-Control-Allow-Origin` echoing `https://grid.example.org` means `PUBLIC_BASE_URL`
in `.env.api` is still the example value. The site itself works — a browser only consults
CORS for cross-origin requests, and the app is same-origin — so nothing looks wrong until
the header is read:

```sh
: "${DOMAIN:?set DOMAIN first: DOMAIN=your.domain}"
sudo -u grid -H sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://$DOMAIN|" /srv/grid-authority/.env.api
sudo -u grid -H pm2 restart api --update-env
curl -sS -o /dev/null -D- "https://$DOMAIN/api/v1/zones" | grep -i access-control-allow-origin
```

`pm2 restart`, not `reload`: the value is read at startup, and a reload keeps the old
environment.

`deploy.sh` now refuses to run while either env file holds an example value, so this
cannot reach production again the same way.

### The day, week or month view is empty while the hourly one works

The coarse views read `map_snapshot_agg`, which the hourly path never touches. If the
hourly map is fine and a coarser resolution is blank, the summaries have not been built:

```sh
cd /srv/grid-authority
sudo -u grid -H uv run --env-file .env eia rebuild-aggregates
```

Safe at any time and free of EIA requests. `--resolution day` limits it to one;
`--since` limits how far back it goes.

### The map shows far fewer hours than the database holds

The map serves `map_snapshot`, which is derived from the observation tables. The two can
come apart: a job that stored observations and then failed before building their
snapshots leaves hours with data and nothing to draw. A resumed backfill will not repair
it, because a day is judged complete from its observations.

Rebuild them from what is already stored. This makes no EIA requests, so the hourly
ceiling does not apply and it is safe to run at any time:

```sh
cd /srv/grid-authority
sudo -u grid -H uv run --env-file .env eia rebuild-snapshots --days 90
```

By default it builds only the hours that have no snapshot. `--all` rebuilds every
observed hour in the window, for when the snapshots exist but are wrong — after a
zone registry change, for instance.

To see the size of the gap first:

```sh
sudo -u postgres psql -d grid_authority -c \
  "SELECT (SELECT count(DISTINCT period_utc) FROM obs_region_hourly) AS observed_hours,
          (SELECT count(*) FROM map_snapshot) AS snapshots;"
```

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
sudo -u grid -H git checkout <previous-tag>
sudo -u grid -H ./deploy/deploy.sh
```

Migrations are reversible one step at a time:

```sh
sudo -u grid -H uv run --env-file .env eia migrate status
sudo -u grid -H uv run --env-file .env eia migrate down --steps 1
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
