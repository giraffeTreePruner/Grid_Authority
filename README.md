# Grid Authority

A live map of United States balancing authorities, driven entirely by hourly data from
the U.S. Energy Information Administration (EIA Form 930).

MVP 1 covers: a zone registry for every EIA-930 balancing authority, an hourly ingest of
demand, day-ahead demand forecast, net generation, generation by energy source and
directed interchange, precomputed hourly map snapshots, a read-only JSON API, and a
MapLibre frontend with a seven-day hourly time slider.

## Principles

- **Nothing is fabricated.** A missing hour is `NULL` and renders as "no data". There is no
  interpolation, forward-fill or zero-substitution anywhere in the pipeline.
- **Every observation records its source.** No measurement is stored without provenance.
- **All timestamps are UTC and interval-start.** An hour labeled `2026-09-11T14:00:00Z`
  covers 14:00:00–14:59:59.
- **Jobs are idempotent.** Running an ingest twice over the same window produces the same
  database state.

## Layout

```
config/            YAML contracts: zones, modes, sources, excluded respondents
db/migrations/     numbered SQL migrations
packages/api/      Fastify read-only JSON API (TypeScript)
workers/eia/       EIA client and ingest jobs (Python)
geo/build/         geometry pipeline, run manually, output committed
docs/              runbook and decision log
```

## Requirements

Node 22 LTS (`.nvmrc`), Python 3.11 (`.python-version`), PostgreSQL 16, pnpm and uv.

## Getting started

```sh
cp .env.example .env      # then fill in EIA_API_KEY and DATABASE_URL
pnpm install
uv sync --all-groups
docker compose up -d db   # local PostgreSQL 16
```

Run the checks:

```sh
pnpm lint && pnpm typecheck && pnpm test
uv run ruff check . && uv run mypy . && uv run pytest
```

## Data sources

See `/about/data` on the running site, or `config/sources.yaml`, for the full list with
licenses and attribution. EIA Form 930 data is a U.S. Government work in the public domain.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
