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
