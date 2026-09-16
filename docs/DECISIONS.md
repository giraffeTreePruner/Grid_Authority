# Decisions

One entry per underspecified decision, with a sentence of reasoning. Newest last.

## 2026-09-11 — Shared TypeScript config loader lives in `packages/api`

The build spec requires config loaders and schemas in both Python and TypeScript. The only
TypeScript consumer in MVP 1 is the API, so the zod schemas and loader live under
`packages/api/src/config/` rather than in a separate shared package. When the web package
needs the generated types it will be extracted then, with a real second consumer to shape it.

## 2026-09-11 — Local PostgreSQL runs under Docker Compose

`docker-compose.yml` provides `postgres:16` for development and integration tests, pinned to
UTC in both the container and the server. Production is unaffected: it reads `DATABASE_URL`.
This avoids a system-wide database install and keeps the local version identical to the target.

## 2026-09-11 — Development machine runs Node 26 while the repo pins Node 22

`.nvmrc` pins Node 22 LTS to match the deployment target, and CI builds on 22.
The current development machine has Node 26; `engines` is `>=22` so local work is not blocked.
Anything that depends on a version difference must be caught by CI, not by local runs.

## 2026-09-11 — Python 3.11 is fetched by uv rather than taken from the system

`.python-version` pins 3.11 per the spec. uv downloads and manages that interpreter, so the
development environment matches the target regardless of the system Python.

## 2026-09-11 — `yaml` added to the API package

§3's approved API dependencies contain no YAML parser and Node has no built-in one, but §4
requires the API to load and validate the same `config/*.yaml` files as the workers. Adding
`yaml` keeps a single source of truth; the alternative, a generated JSON build artifact, can
drift out of sync with the YAML whenever the build step is skipped.

## 2026-09-11 — Migrations are applied by a Python subcommand

`eia migrate` sits alongside the other jobs. psycopg is already a dependency, the workers
already hold the database credentials, and deploy runs one toolchain for every data operation.

## 2026-09-11 — `interconnection` may be null for non-balancing-authority zones

§4.1 enumerates five interconnections, but a regional aggregate or the national total spans
several and belongs to none. Those zone types take `interconnection: null`; a
`balancing_authority` must still name one, and the loaders enforce both halves of that rule.

## 2026-09-11 — Hybrid fuel codes map to their primary renewable

EIA reports hybrid plants under `WNB` (wind with integrated battery) and `SNB` (solar with
integrated battery). §4.2 fixes the canonical mode list at fourteen with no hybrid category,
so `WNB` maps to `wind` and `SNB` to `solar`. A hybrid plant is overwhelmingly wind or solar
generation with a battery attached, and EIA categorises each plant once, so nothing is
double-counted against `SUN` or `WND`. Mapping them to `battery_storage` instead would push
real renewable generation out of the share denominator entirely.

## 2026-09-11 — `UES` is storage, established from the data

The fueltype facet returns `UES` twice, labelled both "Unknown Energy" and "Unknown energy
storage", which map to different canonical modes. In the 2024-12-15 sample every one of its
21 rows is negative, between −609 and −113: that is charging, not generation. `UES` therefore
maps to `other_storage`, alongside `OES`.

## 2026-09-11 — The poll window follows each dataset's endPeriod

§5.4 assumes a `now−12h → now` window for every dataset. Measured on 2026-09-12T01Z, the
newest published hour was 2026-09-12T07 for region-data, 2026-09-11T06 for fuel-type and
2026-09-10T07 for interchange — roughly 19 and 42 hours behind. A fixed 12-hour window
returns nothing at all for two of the four route groups, so `poll` reads each dataset's route
metadata first and requests `endPeriod−12h → endPeriod`. That costs one extra request per
dataset per cycle and adapts on its own when EIA's publication schedule moves. The same
request gives §7.4's probe its lag measurement without a second call.

## 2026-09-11 — Shares are `numeric(6,4)`, not `numeric(12,2)`

§6 specifies `numeric(12,2)` for every numeric column, but §8 serves shares rounded to three
decimals, which two decimal places cannot represent. Power values keep `numeric(12,2)`.

## 2026-09-11 — `obs_interchange_hourly.to_zone` carries no foreign key

The `toba` facet returns 92 codes against 83 respondents: the extra ten are Canadian and
Mexican balancing authorities (AESO, BCHA, HQT, IESO, MHEB, NBSO, SPC, CAN, CEN, MEX) that are
counterparties but not zones. `to_zone` holds the canonical zone key when the counterparty is
a registered zone and the raw EIA code otherwise. Zone keys always contain a hyphen and EIA
codes do not, so the two cannot be confused. `from_zone` is always a respondent and does carry
a foreign key.

## 2026-09-11 — Hour alignment is enforced by the database

Guardrail 4 requires every period to be an interval-start UTC hour. Each observation table
carries a check constraint to that effect, written with `AT TIME ZONE 'UTC'` so the expression
is immutable and therefore usable in a constraint. A parser bug cannot quietly write a
half-hour offset.

## 2026-09-11 — Region membership was solved by reconciliation, not assumed

Each zone's regional parent was derived by checking that every regional aggregate's
demand, net generation and total interchange equals the sum of its member balancing
authorities. The first hypothesis left three regions out by exactly the value of a
misplaced member: AECI (2,454) belonged to MIDW rather than CENT, and SWPW (2,820) plus
PSCO (4,338) belonged to NW. SIKE, which reports generation but no demand, was found the
same way against net generation. The corrected assignment reconciles across 1,050
region-hours with no mismatch, and every respondent that reports data is accounted for.

## 2026-09-11 — Capabilities record observed behaviour

Seven balancing authorities (AVRN, DEAA, GRID, GWA, SEPA, SIKE, YAD) report generation
and interchange but never demand, and SPA reports demand but no directed interchange. No
facet endpoint says so; it is only visible in the data. Marking those `demand: true` would
leave the map showing "no data" forever for a series that is never coming. A capability is
true when the respondent was observed publishing that series either recently or in the 2024
samples, so a quiet window does not permanently mark a capability false.

## 2026-09-11 — WWA is a zone; eight other respondents are excluded

Of the nine respondents absent from recent data, WWA last published on 2026-08-26, sixteen
days ago and inside the 90-day backfill window, so it is a zone. WACM and WAUW last
published 2026-04-02 and were absorbed into the SPP West balancing authority area, which is
also why SWPW appears. AEC, EEI, GLHB, GRIF, HGMA and NSB have published nothing since
before 2025-07. All eight are excluded with a dated reason; none strands data the backfill
would want.

## 2026-09-11 — Several EIA fuel codes share one canonical mode

OTH and UNK both map to `unknown`, UES and OES to `other_storage`, WND and WNB to `wind`,
SUN and SNB to `solar`. Row mappers must sum values landing on the same mode rather than
overwrite, or roughly half of some zones' wind and solar would silently vanish.

## 2026-09-11 — SWPW is in the Western Interconnection

Despite the Southwest Power Pool being an Eastern Interconnection RTO, its West balancing
authority area covers the former WACM and WAUW footprint and is Western. SWPP stays eastern.

## 2026-09-11 — Time zones follow civil time, not EIA's operational clock

EIA's `local-hourly` frequency labels each period with the respondent's own UTC offset,
which makes the offsets directly derivable rather than assumed. Requesting it needs
offset-suffixed period bounds (`2026-09-09T12-07`); plain labels return HTTP 500.

Comparing a September window against a January one gives each respondent an offset pair
that identifies its zone. That confirmed 64 of 72 entries and found no zone in the wrong
band. The eight differences are EIA using the operating entity's clock rather than the
territory's: MISO and MIDW on Eastern (MISO's market runs on EST), SWPW on Central (SPP
operates from Little Rock), the whole Southwest region including EPE and PNM on MST with
no DST, IPCO on Pacific, SEPA on Central, and the NW and US48 aggregates on a single clock
for a footprint that spans several.

`timezone` is display only, so the registry keeps civil time: a person looking at a clock
for New Mexico expects it to shift for daylight saving, which EIA's model does not do.
Anything that later reads `local-hourly` data must use EIA's offsets rather than this
field.

## 2026-09-11 — sync-zones never deletes

A zone present in the database but absent from the registry is reported and kept, never
removed, because observations reference it by foreign key. The sync writes a row only when
a field actually differs, so `updated_at` is untouched on a no-op run and a second sync
reports no changes at all. Zones are written parent-first, since `zones.parent` is a
self-referencing foreign key.

## 2026-09-12 — EIA returns `total` as a string

Recorded responses carry `"total": "5418"`, not `5418`. The client coerces it; a fixture
test pins the behaviour so a future change in the API is noticed rather than silently
truncating pagination to the first page.

## 2026-09-12 — EIA can echo another caller's api_key

Two route-metadata captures came back carrying a 40-character `api_key` that was not ours,
almost certainly a cached response still holding the key of whoever warmed the cache. They
were scrubbed before anything was committed, the capture script now redacts the echoed
parameter whatever its value, and `test_fixtures_carry_no_secrets.py` fails on any
key-shaped string in any committed fixture. The repository is public, so this check runs
over what is actually on disk rather than trusting the capture path.

## 2026-09-12 — Concurrency is one request at a time

§5.1 allows up to three concurrent requests. The workers are synchronous, so the client
issues one at a time, which satisfies the limit without an async layer that nothing else
in the ingest path needs. Rate and the hourly ceiling are still enforced.

## 2026-09-12 — The hourly ceiling raises instead of waiting

Reaching 500 requests in an hour means a job is looping or a window is far larger than
intended. Sleeping it off would hide that until someone noticed missing data, so the
limiter raises and the job exits non-zero into `source_status`.

## 2026-09-12 — `horizon_h` rounds to the nearest hour

Issue times are poll-cycle starts, not hour boundaries, so a horizon is fractional.
Postgres rounds rather than truncates on the cast to integer, which is the better answer:
a forecast issued at 12:10 for 13:00 is fifty minutes out, nearer one hour than zero.

## 2026-09-12 — EIA's published forecast horizon is far shorter than §5.4 assumes

§5.4 requests day-ahead demand forecasts over `now → now+48h`. In the recorded capture,
taken at 2026-09-12T01:47Z, DF reached only 2026-09-12T07 — six hours past the current
hour, not forty-eight. The request was for the full window; that is simply all EIA had.

This matters for §9's forecast selection rule, which takes "the most recent issue at or
before `target − 24h`". At a six-hour horizon no such issue exists and the forecast series
would come back empty. One capture cannot say whether the horizon varies by time of day —
the forecast for a coming operating day may be published in a batch — and `probe` is what
will answer that once it has run for a while. The constraint is pinned by a test so the
rule and the data are reconciled deliberately rather than assumed compatible.

## 2026-09-12 — The probe reads route metadata, not data

§7.4 describes requesting the newest period of each dataset. Route metadata already
carries `endPeriod`, which is exactly that measurement, and returns no rows at all. One
request per dataset per hour, four an hour, with no data transferred.

A dataset whose `endPeriod` runs ahead of now reports zero lag rather than a negative
number: region-data is always ahead because it contains the forward forecast.

## 2026-09-12 — Writers report which hours actually changed

`WriteResult` carries the set of periods whose values moved, so `revise` rebuilds only
those snapshots. Rebuilding every hour it re-fetched would redo a week of snapshots
nightly to no effect.

## 2026-09-12 — `/health` distinguishes starting from degraded

§9 returns 503 when the database is down or any source exceeds six hours stale. With
`source_status` empty there are no sources, so the literal reading is 200 — which would
also be a green light on a host whose ingest has never run.

A freshly deployed host sits in exactly that state between `sync-zones` and its first
poll, and reporting it as degraded would make every deploy look broken for up to half an
hour. So an empty table returns 200 with `status: "starting"` rather than `"ok"`, and the
503 conditions are unchanged. A registered source with a null `last_success_at` is
degraded: one that has never succeeded is worse than one that is merely stale.

## 2026-09-12 — The forecast series keeps a 24-hour horizon and reports it

§9 selects, for each target hour, the most recent vintage issued at or before
`target − 24h`, so the chart compares actual demand against a genuine day-ahead
prediction rather than a revision published once the hour was nearly over. That rule
stands, with the threshold as a named constant.

The observed publication horizon may be shorter than 24 hours — one capture showed six —
in which case no vintage qualifies and the series is null. Rather than quietly lowering
the threshold and calling a six-hour-ahead number a day-ahead forecast, the response
carries `forecast_horizon_h` alongside a per-point `demand_forecast_horizon_h`, so a
client can label what it is actually showing and an empty line is visibly empty. `probe`
will establish the real horizon by time of day.

## 2026-09-12 — The error handler passes client-side statuses through

A custom `setErrorHandler` intercepts everything, so a 429 raised by the rate limiter was
being turned into a 500 — the limit worked, but the client was told the server had
broken. The handler now emits the documented error shape for a 429 and passes any other
4xx through with its own status, so only genuinely unexpected failures become a 500.

## 2026-09-12 — CORS sets a fixed origin and never reflects the request's

`Access-Control-Allow-Origin` is always `PUBLIC_BASE_URL`, whoever asks. That is what
blocks other sites: the browser compares the header against its own origin and refuses
when they differ. Echoing the requesting origin back is the mistake that would allow
everyone, so a test asserts the header never equals an attacker's origin.

## 2026-09-12 — Geometry comes from electricitymaps-contrib, not HIFLD

§11 named HIFLD Open "Control Areas" first, which would have been public domain. Its
ArcGIS feature services now reject anonymous queries and the dataset is absent from the
public Hub search, so it is not usable without credentials. electricitymaps-contrib is
the spec's other option, is AGPL like this project, and its zone keys already match the
convention here, so the join needs no fuzzy matching. Recorded in `config/sources.yaml`
as `emaps_geo` and on the About page, as the AGPL requires.

## 2026-09-12 — Simplification is light because there is headroom

The spec targets 300–600 KB gzipped, assuming a dense source. This source is already
generalised: the artifact is 169.5 KB against a 600 KB ceiling. Simplifying to hit the
target would only degrade coastlines and state borders for a saving nothing needs, so
simplification is 50% with shapes preserved.

## 2026-09-12 — Nine zones have no geometry and leave the map

Eight are balancing authorities with no service territory at all: individual generating
stations, wind farms, and a federal power marketer. There is no polygon to find, at any
source. The ninth, BHBA, is a real territory the source happens to predate. All nine keep
their data and still appear in `/zones`; they simply are not drawn, with the reason
recorded inline in `config/zones.yaml`.

That set almost exactly matches the generation-only zones found in task 3, which is not a
coincidence: a balancing authority with no territory has neither demand to report nor a
boundary to draw.

## 2026-09-12 — Backfill completeness follows demand capability, not the map

Moving nine zones off the map exposed the completeness check being scoped to `in_map`
zones. Backfill ingests every zone and the API serves them all, including the regional
aggregates which are deliberately off the map but very much expected to have data. The
check now covers every zone whose capabilities say it publishes demand.

## 2026-09-12 — No router dependency for two pages

§3's approved web dependencies do not include a router, and the site has two paths. A
seven-line `routeFor` covers it. If a third page with parameters arrives, that is the
point to reconsider.

## 2026-09-12 — The About page is generated from the API, not from a copy

`/about/data` renders whatever `/api/v1/sources` returns, including inactive entries, so
it cannot drift from the registry the ingest actually uses. The `emaps_method` label is
asserted verbatim by a test: the exact wording is the requirement, not an approximation
of it.

## 2026-09-12 — Playback is tested by driving frames, not by faking timers

Fake timers deadlock against `waitFor`, which uses real timers internally. Driving
`requestAnimationFrame` by hand is deterministic and also tests the pacing itself — that
a frame arriving sooner than the interval does not advance the cursor — which a
timer-based test would have hidden.

## 2026-09-12 — The API and the workers use different database roles

The workers write and the API does not, so each process reads its own env file through
Node's `--env-file`: `.env` carries the owner role for the scheduler and the Python jobs
it spawns, `.env.api` carries a read-only role for the API. A bug in the API then cannot
write, whatever it intends. No secret appears in any committed file.

## 2026-09-12 — Workers are spawned by the scheduler, not supervised by PM2

A worker is a short-lived job that exits when it is done. Supervising one as a service
would make a normal exit look like a crash and restart it forever. PM2 runs two
long-lived processes only; the scheduler spawns the jobs, logs each outcome with its JSON
summary, and kills anything still running after ten minutes.

A job still running when its next tick arrives is skipped rather than run twice. The
upserts are idempotent so a double run would be safe, but it would double the request
budget for nothing.

## 2026-09-12 — `/health` is excluded from the nginx microcache

Everything under `/api` is microcached for sixty seconds, which would otherwise include
the health check — and a cached 200 would hide an outage for a minute at a time. It is
excluded explicitly, and a functional test against a real nginx confirms the upstream is
reached on every request.

## 2026-09-12 — `expires` and `add_header Cache-Control` must not both be used

Using both emits two `Cache-Control` headers; the browser takes the first and drops the
rest, which silently discarded `immutable` on the hashed assets. One directive only.
Caught by testing the config rather than reading it.

## 2026-09-12 — `['has', 'value']` inspects properties, not feature state

A guard of `['!', ['has', 'value']]` was meant to catch a feature with no state. It does
not: `has` tests the feature's _properties_, and the tiles carry only `zone_key`, so the
test was always false and, negated, painted every zone as no-data whatever its value. An
unset feature-state already reads as null, so the single null guard covers both cases.

The unit test passed throughout, because it asserted the expression's _structure_. A
structural assertion cannot catch a well-formed expression that means the wrong thing.
There is now a test that walks the case arms the way MapLibre would, and one that fails
if `has` ever reappears in this expression.

## 2026-09-12 — Map readiness must be state, not a ref

The window response usually arrives before the tiles finish loading. With readiness held
in a ref, the paint effect had already run and returned early, and nothing re-triggered
it: the map stayed grey with no error anywhere. Readiness is now React state, so
becoming ready re-runs the effect. A test covers the realistic order, window first.

## 2026-09-12 — The map opens on the newest hour that has data

Sources run hours behind, so the last hour of the window is routinely empty and opening
there shows an entirely grey map for no reason. The cursor starts at the newest hour any
zone reported, and the legend says plainly when the hour in view has nothing.

## 2026-09-12 — The deployment target is Ubuntu 26.04 on 2 GB

Originally Ubuntu 24.04 on 4 GB. The real host is a 2 vCPU / 2 GB instance, which changes
three things.

Postgres 16 no longer comes from the default archive: a fresh Ubuntu release carries
whichever major version was current when that release was cut, not 16 specifically. It is
installed from the PGDG repository instead, which is versioned independently of Ubuntu.
The alternative — taking whatever Postgres Ubuntu ships — would mean re-pinning the
version in `docker-compose.yml`, both CI jobs and the runbook, so that dev, CI and
production stop agreeing.

A 4 GB swapfile is added with `vm.swappiness=10` — twice the RAM, which is deliberately
generous for something that should never carry steady-state load. It is a safety net for
the overlap between a poll cycle, autovacuum and a traffic burst, and more importantly for
the web build, which is the largest and spikiest allocation on the host. Without it the
kernel's OOM killer picks a victim under pressure, and the victim it picks is often
Postgres. Low swappiness keeps Postgres's hot pages in RAM so the swap is only reached
under real pressure.

PM2's memory ceilings drop from 400M and 200M to 300M and 150M. The old figures claimed a
quarter of a 4 GB host and would claim half of this one. Note these ceilings do not cover
the Python workers the scheduler spawns, which are separate processes.

CI stays on the `ubuntu-24.04` runner. The runner image does not affect what is tested:
Postgres comes from a pinned `postgres:16` service container, Node from `.nvmrc` and
Python from uv. GitHub does not offer a 26.04 runner, and pinning to `ubuntu-latest`
would let the CI environment move without anyone deciding to move it.

## 2026-09-12 — Every `sudo -u grid` uses `-H`, and the checkout is mode 755

Two failures the first real deploy hit, both of which are quiet rather than loud.

`adduser --system` creates the home directory mode 0750 on Ubuntu, so the operator's own
account cannot `cd` into `/srv/grid-authority`. When that `cd` fails in a copied block of
commands, everything after it runs in the operator's home instead, and the errors name
paths that look nothing like the problem. The directory is now explicitly `chmod 755`:
the source is public and both env files are mode 600, so opening the directory costs
nothing.

`sudo` does not set `HOME` for the target user unless asked. Without `-H`, pnpm, uv and
PM2 all try to write caches and state into the invoking user's home, which `grid` cannot
write to. PM2 is the worst of the three: it would keep its process list in the operator's
home while `pm2 startup --hp /srv/grid-authority` points systemd at grid's, so the
processes would simply not come back after a reboot — and nothing would say so until one
happened.

## 2026-09-12 — TLS is a two-pass setup, and Cloudflare is opt-in

The site config could never have been enabled in one pass: its TLS block names certificate
files certbot has not created yet, so `nginx -t` fails before certbot ever runs. The first
deploy did not notice because the symlink creation had already failed for a different
reason, leaving nginx testing only its default config.

`deploy/nginx-bootstrap.conf` now serves the ACME challenge over plain HTTP and nothing
else. Obtain the certificate with it, then swap in the real config. `--webroot` rather
than `--standalone` so renewals run with nginx up: the real config keeps the same
challenge location, so nothing has to stop.

The Cloudflare real-IP directives moved to `deploy/cloudflare-realip.conf`, included only
when Cloudflare is actually in front. They tell nginx to believe `CF-Connecting-IP` from
those ranges; shipping them enabled by default invites someone to enable them without the
proxy, which is how a client gets to claim any address it likes.

## 2026-09-12 — Every root command in the runbook carries its own sudo

The host sections were written as though the reader were root. A reader with sudo rights
instead — which is the normal shape of a cloud VM — got a cascade of permission errors,
and in one case a half-applied command: `sudo nginx -t && systemctl reload nginx` gives
sudo to the test and not to the reload. Each command now carries its own `sudo`, and the
two places that redirect into a root-owned file use `tee`, since a redirect runs in the
caller's shell and is refused.

## 2026-09-12 — The domain is set once, as a shell variable

The TLS section substituted the domain into the config by hand and then repeated it in
the certbot call and again in every check. Typing it more than once invites exactly one
failure: a certificate issued for `example.com` while nginx serves
`sub.example.com`, which produces a site that looks configured and a TLS handshake that
does not match. `DOMAIN` is now set at the top of 2.10 and used throughout.

## 2026-09-12 — Verification commands do not use `curl -s`

`curl -s ... | grep -i x-cache-status` prints nothing when the header is absent, and also
prints nothing when DNS fails, the connection is refused, or TLS does not match. A check
that cannot distinguish "the feature is missing" from "I never reached the server" is not
a check. These now use `-sS`, and the troubleshooting entry says what each outcome means.

## 2026-09-12 — No OCSP stapling

Let's Encrypt no longer includes an OCSP responder URL in its certificates, so
`ssl_stapling on` can never do anything and nginx warns about it on every reload — a
permanent piece of noise in front of the one command whose output must be read carefully.
Revocation is distributed by CRL, which browsers handle without nginx's involvement.

## 2026-09-12 — Entry points start unconditionally

`packages/api/src/index.ts` and `packages/scheduler/src/index.ts` guarded their `main()`
on `process.argv[1]` ending in `index.js`, so that importing the module in a test would
not start a server. Nothing imports either one — the tests build their own instance from
`app.ts` and exercise `runner.ts` and `schedule.ts` directly — so the guard protected
against nothing.

It did break production. PM2 loads an app through its own process container, so
`argv[1]` is PM2's file and the guard never matched. The API came up "online" under PM2
while listening on nothing, which nginx reported as a 502, and the scheduler exited
immediately and was restarted in a loop. Both look like infrastructure faults and neither
is.

Verified by loading each built entry point from a wrapper module, which is the shape PM2
uses: before, neither started; after, the API serves and the scheduler registers its
three cron jobs.

## 2026-09-12 — The PM2 service gets a system PATH, not the operator's

`pm2 startup` prints `sudo env PATH=$PATH pm2 startup ...`, which copies the invoking
user's PATH into a unit that runs as `grid`. The generated unit then searches the
operator's home directory first for every binary it executes, including the `uv` the
scheduler spawns for each job. Anything that could write to that home would be executed
by the service on boot. The runbook passes an explicit system PATH instead, and checks
that `/usr/local/bin` is in it, since that is where `uv` is installed.

## 2026-09-12 — Snapshots are built per day, not once at the end of a backfill

The backfill originally rebuilt every affected snapshot in one pass after the day loop,
on the reasoning that per-day rebuilds would redo the same hours. They would not: the
days in a backfill are disjoint, so either shape builds each hour exactly once.

What the end-of-run shape did do was tie every snapshot to the run completing. A run
interrupted partway — by the hourly request ceiling, which a ninety-day backfill reaches
— keeps its observations, because each day is committed as it finishes, and loses every
snapshot. The resumed run then skips those days as already complete, since completeness
is judged from observations, and never builds them. The result is ninety days of
observations and a handful of hours on the map.

The rebuild now happens inside the loop, before each day's commit, so the derived data is
as durable as the data it derives from. `snapshots_built` counts distinct hours and is
updated in the loop, so a run that raises still reports what it managed to build.

## 2026-09-12 — There is a command to rebuild snapshots without contacting EIA

`eia rebuild-snapshots` rebuilds `map_snapshot` from observations already stored. It
exists because the repair above was otherwise impossible: the only way to rebuild a
snapshot was to re-fetch its day with `backfill --force`, which spends EIA requests to
recompute something derivable from rows already in the database, and would hit the
hourly ceiling doing it.

It defaults to the hours that have no snapshot, takes `--all` for the hours whose
snapshots exist but are stale, and considers all three observation tables so that it
reproduces exactly the set an interrupted ingest would have built.

## 2026-09-12 — A ninety-day backfill exceeds the client's own hourly ceiling

The ceiling is 500 requests/hour against EIA's published guidance of roughly 9,000. That
margin is deliberate for the recurring jobs, which spend a handful of requests each and
should fail loudly if they ever loop. A ninety-day backfill needs about 540, so it raises
partway through by design.

Left as it is, rather than raised or made configurable: the job is resumable, the counter
is per-process and resets on the next run, and two rounds inside one hour are still an
order of magnitude below what EIA permits. A ceiling that a legitimate job cannot exceed
is not a ceiling. The runbook now says this instead of claiming 540 is "well inside" 500.

## 2026-09-12 — The colour domain spans the window, not the hour on screen

`computeDomain` was fed the values at the cursor, so every step of the slider rescaled
the ramp. The effect is that colour stops meaning anything across time: a zone holding a
steady value changes colour as other zones move around it, and a zone whose demand
doubles can keep its colour. Playback, which is the point of the slider, showed mostly
the rescaling rather than the data.

The domain is now computed once per window and metric, in a `useMemo`, and the legend
reads the same one. Whether the legend dims itself is still a question about the hour on
screen, so that stays on the cursor.

The window is currently seven days, so this is stable across a week rather than
absolutely fixed. A fixed per-metric domain would be steadier still but has to be chosen
against data none of us has seen yet; spanning the loaded window costs nothing and
removes the effect that made playback unreadable.

## 2026-09-12 — The map's minimum zoom matches the tile archive's

`tippecanoe -Z3 -z8` builds the archive, and the map was constructed with `minZoom: 2`.
MapLibre over-zooms past a source's maxzoom but does not under-zoom below its minzoom, so
below z3 there was no tile to draw and the map went blank — no error, no warning, just an
empty background.

The map now stops at z3. The alternative, rebuilding the archive from z0, spends tiles on
a view no reader of a US-only map wants; the continental US fits at z3.4, which is where
the map opens.

## 2026-09-12 — Resolution is chosen, never inferred from the range

The reader picks hour, day, week or month, and the slider's step is that period. The
alternative — one slider over all history, coarsening as the visible range widens — needs
fewer controls but makes a step mean different things at different times. A reader cannot
then say what they are looking at, and neither can a screenshot of it.

Every label names its unit for the same reason: "3 weeks earlier", not "3 earlier", and
a month labelled "September 2026" rather than by the midnight that starts it.

## 2026-09-12 — Coarse periods are labelled in UTC, unlike hours

Hours are shown in the viewer's own clock, because an hour is an instant and that is the
clock they are reading from. A day, week or month is not an instant — it is a UTC
calendar period — and formatting its start locally labels September 2026 as "August 2026"
for every viewer west of Greenwich, and shifts every daily label by one for half the
world.

Caught by a test that only failed because the machine running it was not on UTC. It now
asserts the label under several zones rather than relying on where it happens to run.

## 2026-09-12 — Changing resolution clears the loaded window

A window belongs to the resolution it was fetched at. Keeping it on screen during the
refetch would leave months of data on an hourly slider with the cursor pointing at a
period that no longer exists. Playback stops for the same reason.

Switching metric still costs nothing, which is the property §10 asks for: that one is
served from the window already in memory.

## 2026-09-14 — A predicate cannot be pushed through a full outer join

Both derived-data queries filtered after their join, on
`COALESCE(r.period_utc, m.period_utc)`. That reads correctly and is the natural way to
write it, and Postgres will not push such a predicate through a full outer join: it
builds the entire join and filters the result. Both queries therefore scanned both
observation tables in full, whatever single hour or single day was asked for.

Invisible at ninety days. At seven years it decides whether the work finishes: the
backfill builds twenty-four snapshots a day, so the cost grows with every day already
completed, and a run that should take five hours was still going after two — with the
CPU pegged and the disk mostly idle, which is what distinguished this from the slow
storage it was first assumed to be.

Filtering each side before the join, in a materialised CTE, measured 52.6 ms to 0.644 ms
on a hundred days of rows — and, more to the point, made the cost a function of the hour
requested rather than of the table.

`refresh_buckets_for` had the same fault and runs on every poll cycle, so it would have
scanned the whole history twice an hour forever.

`test_building_a_snapshot_uses_an_index_and_not_a_table_scan` asserts on the query plan
rather than on a duration: a timing threshold over a small fixture is noise, while "no
Seq Scan" is exactly the property that broke.

## 2026-09-14 — The zone panel aggregates on the fly, not from `map_snapshot_agg`

The panel now reaches as far as the map does: 30 days, 90 days, a year, and everything
since 2019. The long windows are bucketed by day, and `all` by month.

Not served from `map_snapshot_agg`, which carries only the five map metrics for in-map
zones. The panel plots every generation mode, and for a single zone the aggregation is
cheap — a year is 8,760 rows against `obs_mix_hourly_zone_period_idx`. The map cannot do
this on the fly because it needs every zone at once; the panel can because it needs one.

Every window, hourly ones included, goes through the same `date_trunc` grouping. At
hourly resolution each bucket holds one row and the aggregates return it unchanged, which
is one code path instead of a branch that can drift.

Three rules carried over from the map's aggregates. Shares are re-derived from summed
generation, never averaged. The forecast picks its day-ahead vintage per hour _before_
bucketing, because averaging every vintage would blend a day-ahead prediction with a
same-hour revision and flatter the forecast. And the period axis is generated from the
calendar rather than from the rows that exist, so a day nobody reported stays a visible
gap — and months are stepped by the calendar, not by an assumed thirty days.

The panel says what one point covers whenever it is not an hour. A chart that looks
hourly and is not invites every conclusion an hourly chart would support.

## 2026-09-14 — Raw SQL fragments use `sql.unsafe`, with a name check

The mix columns behind each share are built from `modes.yaml` and cannot be bind
parameters, because they are a column list. `sql(fragment)` quotes its argument as an
identifier — the first attempt produced `column "coalesce(wind_mw, 0) + ..." does not
exist` — so the fragment goes through `sql.unsafe`.

The names come from config rather than from a request, so this is not an injection path.
It is still checked against `^[a-z_]+$` on the way in: the check costs nothing, and it
turns a typo in config into a clear error here instead of a SQL syntax failure later.

## 2026-09-14 — A fetched day is recorded, not inferred

`day_is_complete` decided a day was done when every in-map zone reporting demand held 23
of its 24 hours. The expected set comes from capabilities observed in _current_ EIA data,
so a balancing authority reporting in 2026 was expected in 2019 — and four of them
(`US-FLA-HST`, `US-FLA-JEA`, `US-MIDW-LGEE`, `US-NW-SWPW`) were not publishing then.

Every day before those four began was therefore permanently incomplete: re-fetched on
every run, for ever, and re-fetched about a thousand of them before reaching new ground.

What made this expensive to find is that it left no trace. Re-ingesting identical rows
writes nothing — `write_region` updates only where the values differ, which is how
`revised_at` stays honest — so `ingested_at` never moved and no row count grew. Every
data-shaped diagnostic said "idle". The bug was visible only in the process list, in the
EIA request traffic, and by running the completeness predicate by hand.

`backfill_day` records the fetch instead, in the same transaction as the day's rows, so
the record cannot outlive the data it describes. That was the original objection to a
marker file, and it does not apply to a row that commits atomically with what it marks.

Two edges are handled explicitly. A marker that recorded rows requires those rows to
still exist, so a TRUNCATE of the observation tables does not leave days skipped for
ever. And a day marked with no rows is taken at its word, because demanding a row from a
day EIA genuinely had nothing for would reproduce the original bug in miniature.

The migration seeds the table from days already fetched, at a deliberately loose bar of
half the expected zones: marking a partial day costs one `--force` to repair, while
re-fetching every historical day is paid on every run for ever.

## 2026-09-14 — Canada and Mexico are context, drawn fainter than no data

The map ends at the US border with nothing to say whether that edge is a coastline or
the limit of the dataset. Two country silhouettes fix that.

They are drawn from the same electricitymaps-contrib `world.geojson` the zones come from,
dissolved to one feature per country, so there is no second source, licence or
attribution to track. Simplified to 10% of vertices with islands under 2,000 km² dropped:
4 KB gzipped, against a 600 KB geometry budget.

The constraint that shaped the styling: on this map a grey shape already means "a zone
that published nothing this hour". Context has no data behind it at all and must not be
mistakable for that, so it resolves to roughly #11141a against the background where a
no-data zone resolves to about #1d1f24 — visible as land, too faint to read as a
measurement. The layers are never queried for features, so they cannot be hovered,
clicked or selected either.

Still no basemap: every source is local and none is raster tiles, which the test now
asserts directly rather than by counting layer types.

## 2026-09-14 — The slider is sized for a finger, and claims the gesture

Scrubbing did not work on a phone: the track was 4px tall, far under the ~44px a touch
target needs, so a drag usually missed it and registered as a tap — which a range input
answers by jumping to that position rather than scrubbing. And without `touch-action:
none` the browser claims a horizontal drag as a page gesture and pans instead.

The input is now 44px tall and transparent with the visible track drawn thin inside it,
so the hit area is generous and the line looks unchanged.

## 2026-09-14 — The generation mix legend carries values, not just colours

A stacked area with eight bands and a swatch key tells a reader which colours exist. It
does not tell them what any band is worth at the point they are looking at, which is the
question the chart exists to answer.

The legend now reads the cursor and gives each source its own value — unstacked, because
`data` carries cumulative bands and a reader asking "how much wind" wants the wind, not
the running total it sits on. With no cursor it reads the latest period, so the panel
says something useful before it is touched. A source that published nothing shows a dash
rather than a zero, and a source that never reported has no row at all.

The readout is rendered by React from uPlot's `setCursor` hook rather than by styling
uPlot's own legend, and takes the resolution as a prop rather than inferring it from the
timestamps: an hourly window contains midnights too, so "ends at 00:00" does not
distinguish an hour from a day.

## 2026-09-14 — The tile archive starts at zoom 2, and the map opens fitted

The archive was built `-Z3`, and the continental US does not fit on a phone at zoom 3: a
375px viewport needs about 2.2. The floor and the device were in direct conflict, so a
mobile reader could never see the country whole. Rebuilt `-Z2`, which costs about 6 KB
against a 600 KB budget.

The map also opened at a fixed zoom of 3.4, right for a desktop and wrong for a phone. It
now fits the continental bounds, which adapts to whatever viewport it lands in — 2.05 on
a 375px screen, higher on a desktop.

`GEOMETRY_VERSION` must be bumped to 2 on any host, or the old archive is served from
cache and the zoom floor still bites.

## 2026-09-14 — The map canvas follows its container, not just the window

MapLibre listens for window resizes and nothing else. The zone panel is a flex sibling of
the map, so opening it takes width from the map without any window resize, and the canvas
kept its old size and drew stretched into a container that no longer matched.

A `ResizeObserver` now calls `resize()`. It deliberately does not re-fit the bounds: that
would snatch the map back from a reader who had panned somewhere.

## 2026-09-14 — The mix readout falls back to the newest period with data

Exactly the fault the map had when it opened on the newest hour rather than the newest
hour with data, reproduced in the panel: the legend defaulted to the last period, which
is routinely unpublished, so the panel opened showing a dash for every source.

It now falls back to the newest period any source reported. A dash still means "published
nothing", and a genuine zero still shows as 0 — coal at 0 and coal unknown must not look
the same.

## 2026-09-14 — Scrubbing is driven by pointer events, not left to the input

On iOS a range input does not jump to a tapped position and will not follow a drag that
began anywhere but on the thumb. Scrubbing therefore meant hitting an 18px target exactly
and then dragging it, which is why it kept "picking a point" instead of scrubbing —
sizing the control to 44px and setting `touch-action: none` were necessary and not
sufficient.

The position is now read off the element on `pointerdown` and followed on `pointermove`,
with pointer capture so events keep arriving when the finger leaves the control. Every
platform behaves the same: press anywhere, drag, the cursor follows. `onChange` stays for
the keyboard.

## 2026-09-14 — The zone panel is a sheet on a phone, not a column

The panel was a flex sibling at `w-[26rem] max-w-full`, which on a 375px screen filled
the width and squeezed the map to a few pixels — while the map's legend, absolutely
positioned over what was left, spilled across the panel's contents. It is now an overlay
below `sm`, and the map legend hides while it is up, because it describes a map the
reader cannot currently see.

## 2026-09-14 — The panel reads the hour the slider is on

A touch screen has no hover, so a chart whose only readout follows the mouse has no
readout at all on a phone: uPlot's legend showed "--" permanently.

Both panel charts now read the period the map's slider is on, matched by timestamp rather
than by index — the panel may be bucketed by day or month while the map is hourly, and
the two windows differ in length, so `indexForPeriod` takes the last period at or before
the target. Hovering the chart still overrides it, and when the slider points outside the
panel's window it falls back to the newest period that reported.

## 2026-09-14 — Alaska is context, like Canada and Mexico

EIA Form 930 does not report Alaska, so it is missing from the map for a different reason
than Canada is — but it looks identical to a reader, and leaving it out made Canada end
at a straight edge in the north-west that read as a rendering fault rather than as a
boundary of the data. Drawn from the same source at the same faintness.

## 2026-09-14 — Pointer capture is never load-bearing

`setPointerCapture` throws `NotFoundError` when the pointer is already gone, and it was
being called before the cursor moved — so the exception took the whole gesture with it.

It now runs after the reading, inside a try/catch. Capture is worth having, because it
keeps events arriving when a finger slides off a 44px control, but a gesture must not
depend on it.

This also invalidated an earlier verification: the slider appeared to work under
synthetic pointer events when what actually moved it was Chrome's native jump-to-click.
The handler had thrown. A test that passes for a different reason than the one intended
is worse than a failing one.

## 2026-09-14 — The charts can be scrubbed directly

uPlot's cursor follows a mouse. A phone has none, so a reader could see the shape of a
chart and never a number from it. Pressing anywhere on a chart and dragging now reads
along it, and where the touched period exists in the map's window the map moves too, so
the panel and the map never disagree about which hour is being discussed.

`touch-action: none` is set only on a scrubbable chart, so a finger landing on any other
chart still scrolls the page.

## 2026-09-14 — The deploy health check judges the deploy, not the data

`/health` answers 503 when any source has not succeeded in six hours. That is a true
statement about the data and says nothing about whether the deploy worked — during a long
backfill the poll job routinely falls that far behind — and `curl -f` turned it into a
failed deploy.

The check now retries until the API answers at all, fails if it never does or if the
database is unreachable, and otherwise reports a stale source as what it is: an
operational note, printed with the command to investigate it.

## 2026-09-14 — The mark is defined once, in code, and the favicon is its output

"GA" carved into blocks, banded by row from the demand map's own sequential ramp. The
letterforms are rectangles on a 32-unit grid rather than curves: the mark is about
territory divided into blocks, and at 16px a curve is one grey pixel anyway.

Three things draw it — the header component, `public/favicon.svg`, and the 180px
apple-touch icon — and the browser reads the SVG before any component code runs, so the
file has to exist on disk. That is two copies of one drawing, which will diverge the
first time somebody nudges a rectangle. `mark.ts` is the source, `markSvg()` emits the
file, and a test asserts the committed bytes match. Verified by moving one block a single
unit and watching the test fail.

The touch icon is square rather than rounded: iOS applies its own mask, and a corner
radius underneath shows as a dark rim inside the rounded square.

Variant B of three, chosen by the owner: banded, rather than one colour per block
(seams close up at 16px) or letters knocked out of a carved tile (counters fill in).

## 2026-09-14 — A chart takes the horizontal gesture and leaves the vertical one

`touch-action: none` made the charts scrubbable and, in the same stroke, made the panel
unscrollable: a finger landing anywhere on a chart was claimed by it, so a reader could
not scroll past the demand chart to reach the generation mix underneath.

`pan-y` is the right value. Vertical panning stays with the browser's scroller, and only
the horizontal drag reaches the chart.

That alone is not enough, because a scroll that begins on a chart still delivers a
`pointerdown` there. A touch therefore has to earn the scrub: it starts only once the
finger has moved more than six pixels sideways, and more sideways than vertically. A
mouse scrubs from the press, having nothing to scroll with.

## 2026-09-14 — Scrubbing drives uPlot's cursor, not only React state

The numbers moved and the crosshair stayed where it was, because the scrub was setting
component state and never telling uPlot where to draw. `setCursor` is now called with
the position, and the default hairline — sized for a light theme and invisible against
`#0b0e14` — is restyled to be legible.

Both panel charts also keep their own reading rather than deriving one from the map's
cursor. The panel's window ends at the selected zone's newest hour and the map's ends at
the newest hour anywhere, so they overlap without matching: scrubbing into the part the
map does not cover moved the crosshair and left every number behind.

## 2026-09-14 — The stack is drawn largest band first, with opaque fills

Every band in `buildMixData` is a cumulative total, drawn as an area from the axis up to
that running sum — so each band covers the ones below it. uPlot paints series in array
order, which meant the grand total went on last and hid every source under it. With
translucent fills on top of that, eight bands blended into one olive mass while the
legend and the cursor points beside it showed the right colours, which made it look like
a palette problem rather than a draw-order one.

Reversed, so the largest is laid down first and each smaller band paints over it, and the
fills are opaque. `labels` and `colours` stay in reading order for the legend;
`seriesLabels` and `seriesColours` carry the drawing order, and a test asserts the two
are reverses of each other.

## 2026-09-16 — A control for the map is shown only when the map is

On a phone the zone panel is a full sheet over the map, and the metric switcher, the
resolution control and the time slider all stayed on screen behind it — driving something
the reader could not see. Worse, the panel has its own window control, so two unrelated
time ranges were visible at once: a slider that always held the map's range, and a panel
showing months or years, with no indication that the first did nothing for the second.

All three are hidden below `sm` while a zone is open, and unchanged beside a visible map.

The alternative — making the metric tabs drive the panel — was considered and not taken.
The panel is not a map: it already plots demand, forecast and every generation mode at
once, so "show me interchange" has no meaning there, and a metric control that means one
thing beside the map and another over it would be worse than one that disappears.

Note that `sm` is 640px, so a narrow desktop window gets the sheet and loses the controls
too. That is the intended reading: the rule is about whether the map is on screen, not
about what device it is.

## 2026-09-16 — The mix pane carries the two shares, as published

`renewable_share` and `low_carbon_share` are shown with the generation mix, at whatever
period is being read.

Taken from the API, never re-derived from the bands on screen. The bands are generation
by mode; the shares divide by _counted_ generation, which excludes imports and storage
discharge. Recomputing from what is plotted would silently include them and read a few
points high — a wrong number that looks entirely reasonable, which is the kind this
project tries hardest to avoid. A test pins the two apart by giving the fixture bands
that say one thing and a published share that says another.

A period with no published share reads as a dash, not 0%.

## 2026-09-16 — A negative value is consumption, and never shrinks a share denominator

`excluded_from_mix_percent` drops the named storage modes and imports, which is right and
was not enough. EIA does not file every operator's storage under a storage code: CAISO's
fleet arrives as `OTH`/`UNK`, which map to `unknown`, which is counted. Its charging load
— to -9,861 MW — was therefore shrinking the denominator and inflating the renewable
share. Across 995 charging hours the site published **90.1%** where the honest figure is
**75.6%**, and one hour was overstated by **30 points**.

The rule is now general rather than a special case for `unknown`: a negative value is
consumption, not generation, whatever mode it arrives under, and is clamped to zero in
the share denominator. That also catches the smaller cases already in the data — solar
reporting negative overnight station service in 15,571 hours, and negative gas, hydro,
coal and wind in about two thousand more.

Clamped, not excluded: a zone whose gas reads -5 MW for an hour of auxiliary load still
has gas plant, and dropping the category would move the share further than the
measurement warrants.

`total_generation_mw` keeps the value as reported, negatives included. It is a stored
measurement and should not be quietly rewritten; only the derived share clamps.

Verified against seven years of production data: the recompute moved 19,546 rows and
reproduced 90.1% → 75.6% on exactly the hours predicted before the change was written.

## 2026-09-16 — Storage is reported on its own, not folded into a percentage

The panel shows net storage in MW beside the two shares — negative charging, positive
discharging — rather than letting it hide inside a generation mix where it is neither
generation nor a share.

It counts only what EIA files under a storage code. For CAISO that reads as no storage,
because its fleet arrives as `unknown`, and reclassifying it here would be asserting a
category EIA did not assign. Fixing that properly means a second source — gridstatus.io
or the ISO directly — and belongs to a later MVP.

## 2026-09-16 — Derived values need a recompute path

Shares are computed on write, so changing the rule left every stored row saying the old
thing. `eia recompute-shares` rewrites them in place from the modes already ingested,
with no EIA requests, and its SQL is generated from `modes.yaml` — the same file
`compute_shares` reads — so the two cannot drift into computing different numbers.

Snapshots and aggregates carry copies of these shares, so both need rebuilding after it.
The command says so rather than leaving it to be discovered.

## 2026-09-16 — Rate limiting answers 429, and nginx is the coarse layer

Production was rejecting with **503**, nginx's default for `limit_req`. That says the
service is unavailable, which it is not — it is declining this client, right now. The
difference matters to everything that reads a status code without a human attached: an
uptime monitor records an outage, and a crawler backs off from the whole site instead of
from its own request rate. `limit_req_status 429` and `limit_conn_status 429` fix it.

Measuring it also showed the two layers were the wrong way round. A parallel burst of 40
returned 10 200s and 30 503s, all from nginx, while a successful response carried
`x-ratelimit-remaining: 54` — the API's limiter was working and almost never reached,
because nginx at 2r/s rejected first.

That is backwards. nginx cannot say anything useful about who is asking, since it rejects
before the request is understood; the API counts per client and answers with
`X-RateLimit-*` and `Retry-After`, which is what a caller needs in order to behave. So
nginx is now set well above interactive use (5r/s, burst 20) as flood protection, and the
API's 60/minute does the real limiting.

The old 2r/s was tight enough to catch real readers: `limit_req` runs before the cache,
so clicking through a few zones counted every time, cache hits included.

## 2026-09-16 — A production check found what the contract test could not

The API's rate-limit test passes and always has: the 61st request in a minute returns 429
with `Retry-After`. It tests the API in isolation, which is the right scope for it, and it
cannot see that in production nginx rejects first with a different code entirely.

Both were needed. The unit test says the limiter is correct; only a request to the running
site says which limiter a visitor actually meets.
