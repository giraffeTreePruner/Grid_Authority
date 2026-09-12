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

`.nvmrc` pins Node 22 LTS to match the Ubuntu 24.04 deployment target, and CI builds on 22.
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
