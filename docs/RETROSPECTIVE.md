# Grid Authority — what got built, and what fought back

A live map of the United States electric grid, built on hourly data from EIA Form 930.
Seventy-six commits across five working days, 11–17 September 2026.

This covers everything on `main`. The comparability contract for the ISO layer is later
work and lives on its own branch; see `COMPARISON_PLAN.md` for where that is going.

---

## At a glance

|              |                                                                      |
| ------------ | -------------------------------------------------------------------- |
| Source lines | ~22,000 across 158 files                                             |
| Zones        | 75 balancing authorities, regional aggregates and the national total |
| History      | Hourly demand from 2015-07, generation mix from 2018-07              |
| Database     | 13 tables across 8 reversible migrations                             |
| API          | 8 endpoints, read-only, bounded, precomputed                         |
| Tests        | 502 — 241 Python, 114 API, 135 web, 12 scheduler                     |
| Decision log | 97 entries                                                           |
| Host         | 2 vCPU, 2 GB, Ubuntu 26.04, PM2 behind nginx                         |

---

## What got built

**An ingest that follows the data rather than the clock.** Four EIA route groups on a
twice-hourly poll, a day-ahead forecast snapshot captured as a vintage on every cycle, a
nightly revision sweep over the trailing week, a latency probe, and a resumable backfill
that loaded seven years of history. Every job is idempotent, writes `source_status` on
success and on failure, and prints a single-line JSON summary as its last line of stdout.

**A zone registry that was derived, not assumed.** Every EIA respondent is either a zone
or an excluded respondent with a dated reason — an unaccounted respondent is a hard
startup failure, which is how a new balancing authority gets noticed instead of silently
ignored for months.

**Precomputation as the performance strategy.** Hourly map payloads are built by the
poll job into `map_snapshot` and served verbatim, so drawing the map never touches an
observation table. Day, week and month rollups land in `map_snapshot_agg`, and the zone
panel's long windows are warmed hourly into `zone_detail_cache`. A reader is almost never
the one paying for a rebuild.

**A read-only API that means it.** The API and the workers connect as different database
roles: the API physically cannot write, with one narrow exception it may append its own
telemetry and nothing else. Every response carries a `meta` envelope with generation
time, sources and freshness. Windows are bounded server-side, ETags are strong, and there
is no endpoint that returns the full history of anything.

**A frontend with no router and no tile server.** React and MapLibre over committed
PMTiles: a choropleth driven entirely by `feature-state`, a seven-day hourly slider that
loads one window and scrubs client-side, a zone detail panel with demand-versus-forecast
and generation-mix charts, and a resolution switcher for the coarse views. Under 200 KB
of application JS, enforced by a build-time budget check. Works on a phone, including
the parts of scrubbing that iOS makes difficult.

**A deployment somebody else could repeat.** A runbook that builds the host from nothing,
PM2 with the scheduler owning all cron timing, nginx with microcaching and two rate-limit
zones, TLS via certbot, and a deploy script that refuses to run against an env file still
holding an example value.

**Visitor counting that keeps nothing.** A visitor is `sha256(day salt || ip ||
user agent)`. Salts rotate daily and are deleted after eight days, so the raw address is
never stored and yesterday's hashes cannot be re-derived by anyone — including whoever
runs the server. The cost is stated on the page rather than hidden: there is no true
all-time unique count, and the wider figures are sums of daily uniques.

---

## What fought back

### The data does not describe itself

Nothing in EIA's facet endpoints says which balancing authorities make up a region. The
answer came out of reconciliation: check that every regional aggregate's demand, net
generation and total interchange equals the sum of its members, and chase the residuals.
The first hypothesis was wrong by exactly the value of three misplaced members — AECI at
2,454 MW belonged to MIDW rather than CENT, SWPW at 2,820 and PSCO at 4,338 to NW. The
corrected assignment reconciles across 1,050 region-hours with no mismatch.

The same problem in miniature, repeatedly. Seven respondents report generation but never
demand, and no endpoint says so — marking them otherwise would leave the map showing "no
data" forever for a series that is never coming, so capability flags record observed
behaviour. The `UES` fuel code is returned twice under two different labels that imply
two different modes; every one of its 21 rows in the sample window is negative, between
−609 and −113 MW, which settles it as storage rather than generation.

### The spec's assumptions did not survive contact

The build spec asked for a `now → now+12h` poll window. Measured against the live API,
fuel-type was running about 19 hours behind and interchange about 42 — a fixed window
returns _nothing at all_ for two of four route groups, and the map would never have shown
a generation mix. The poll now reads each dataset's own `endPeriod` first and follows it
down to where the data actually is.

The spec also assumed a 48-hour day-ahead forecast horizon. EIA published six. That
breaks the forecast-selection rule, which wants the most recent issue at or before
`target − 24h` and would have returned an empty series. Pinned by a test so the rule and
the data get reconciled deliberately instead of assumed compatible.

### A captured fixture contained somebody else's API key

Two route-metadata captures came back carrying a 40-character `api_key` that was not
ours — almost certainly a cached response still holding the key of whoever warmed the
cache. Scrubbed before anything was committed. The capture script now redacts the echoed
parameter whatever its value, and a test fails on any key-shaped string in any committed
fixture, checking what is on disk rather than trusting the capture path. The repository
is public.

### The renewable share was overstated by 14.5 points

Excluding the named storage modes from share denominators was correct and insufficient.
EIA does not file every operator's storage under a storage code: CAISO's fleet arrives as
`OTH`/`UNK`, which map to `unknown`, which was counted. Charging load down to −9,861 MW
was shrinking the denominator and inflating the result. Across 995 charging hours the
site published **90.1%** where the honest figure is **75.6%**, and one hour was
overstated by **30 points**.

The fix is a general rule rather than a special case: a negative value is consumption
whatever mode it arrives under, and is clamped to zero in the denominator — clamped, not
excluded, because a zone whose gas reads −5 MW for an hour of auxiliary load still has
gas plant. It also caught the smaller cases already in the data, including solar
reporting negative overnight station service across 15,571 hours. The recompute moved
19,546 rows and reproduced the predicted correction exactly.

### A full outer join that scanned seven years for one hour

Both derived-data queries filtered _after_ their join, on `COALESCE(r.period_utc,
m.period_utc)`. That reads correctly and is the natural way to write it. Postgres will
not push such a predicate through a full outer join: it builds the whole join and filters
the result, so both queries scanned both observation tables in full whatever single hour
was asked for.

Invisible at ninety days. At seven years it decided whether the work finished — the
backfill builds twenty-four snapshots a day, so the cost grew with every day already
completed, and a run that should have taken five hours was still going after two, CPU
pegged and disk idle, which is what distinguished it from the slow storage it was first
assumed to be. Filtering each side before the join in a materialised CTE measured 52.6 ms
down to 0.644 ms, and made the cost a function of the hour requested rather than of the
table. The same fault was in the function that runs on every poll cycle, so it would have
scanned the entire history twice an hour, forever.

The regression test asserts on the query plan, not on a duration: a timing threshold over
a small fixture is noise, while "no `Seq Scan`" is exactly the property that broke.

### Three tests that could not fail

Found by auditing for the pattern after it bit twice in one day. The geometry gate test
read stdout and asserted the result was defined — the gate writes to stderr, so it was
asserting that the empty string exists, and passed whether the gate ran, failed, or
printed nothing. The statement-timeout test claimed to check the API's connection but
queried the harness's own client, and `SHOW` always returns something defined. Both were
fixed and then verified by deliberately breaking the thing they cover and watching them
go red.

### The page-view counter recorded nothing at all

The most instructive bug, because everything about it looked fine. `navigator.sendBeacon`
cannot set a content type freely, so the beacon sent its JSON as `text/plain`; Fastify's
built-in plain-text parser returns a _string_, so the handler read `body.path`, got
`undefined`, and returned 400. Every browser has `sendBeacon`, so every real visitor took
that path, and the beacon swallows failures by design. The `fetch` fallback that almost
nothing reaches worked perfectly — which is why it read as no traffic rather than as a
bug.

Underneath it, a second defect: the route pruned old salts with a `DELETE` the API role
was never granted, so the first hit of every UTC day died on it and no salt was ever
pruned — quietly breaking the eight-day retention the page promises a reader. There were
no tests for the endpoint whatsoever, which is how both survived. One suite now binds the
app to a role granted exactly what the migration grants, because a test running as the
owner cannot see a statement the API is not allowed to issue.

### Production disagreed with the test suite

The rate-limit test passes and always has: the 61st request in a minute returns 429 with
`Retry-After`. It tests the API in isolation, which is the right scope for it, and it
cannot see that in production nginx rejects first with a different code entirely. Both
were needed — the unit test says the limiter is correct, and only a request to the running
site says which limiter a visitor actually meets.

The deploy produced about twenty commits of this kind. `sudo` does not set `HOME` unless
asked, so pnpm, uv and PM2 all tried to write into the operator's home; PM2 was the worst,
keeping its process list somewhere systemd was not looking, so the processes would simply
not have come back after a reboot — and nothing would have said so until one happened.
TLS could never have come up in one pass, because the site config names certificates
certbot has not created yet.

---

## What the project turned out to be about

Three habits did most of the work, and all three were learned the hard way above.

**Missing stays missing.** No interpolation, no forward-fill, no zero substitution
anywhere in the pipeline. A gap renders as "no data" because a quiet hour that is really
a scrape failure must never look like low demand.

**Every observation records where it came from.** `source` is part of the primary key of
every observation table. Nothing is blended at write time. That was a comparison feature
waiting to happen, and it is what makes the next stage cheap.

**A green check that cannot go red is worse than no check.** Assert on the property that
broke — a query plan rather than a duration, a value compared rather than merely defined,
the content type a real browser actually sends.

The next stage is the one the schema has been ready for since the second migration: a
second opinion per zone, and an honest account of where the sources disagree.
