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
