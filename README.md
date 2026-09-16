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

## A development copy of the production data

The fixtures are enough to run the tests. To work against real data — and it is the only
way to exercise the day, week and month views, which need years of history — take a slice
of the host's database rather than all of it. The full database is around 8 GB, most of
it hourly observations the UI cannot reach anyway, since an hourly window is capped at
seven days.

On the host, dump everything except the large hourly tables, then export a recent slice
of those:

```sh
sudo -u postgres pg_dump -Fc --no-owner --no-privileges \
  --exclude-table-data='obs_*' \
  --exclude-table-data='map_snapshot' \
  --exclude-table-data='forecast_issues' \
  grid_authority -f /tmp/grid-dev.dump

cd /tmp
for spec in obs_region_hourly:period_utc obs_mix_hourly:period_utc \
            obs_interchange_hourly:period_utc map_snapshot:period_utc \
            forecast_issues:target_time_utc; do
    t=${spec%%:*}; c=${spec##*:}
    sudo -u postgres psql -d grid_authority \
        -c "\copy (SELECT * FROM $t WHERE $c > now() - interval '120 days') TO '/tmp/$t.csv' WITH (FORMAT csv, HEADER)"
done

# The dump and the CSVs are written as postgres; make them readable before copying.
sudo chown "$USER" /tmp/grid-dev.dump /tmp/*.csv && gzip -f /tmp/*.csv
```

That dump carries the whole of `map_snapshot_agg`, so the coarse views span the full
history locally even though the hourly tables hold four months.

Locally, restore and load:

```sh
scp user@host:'/tmp/grid-dev.dump' user@host:'/tmp/*.csv.gz' ~/Downloads/

docker compose up -d db
docker exec -i grid_authority_db pg_restore -U grid -d grid_authority \
    --clean --if-exists --no-owner --no-privileges < ~/Downloads/grid-dev.dump

for t in obs_region_hourly obs_mix_hourly obs_interchange_hourly map_snapshot; do
    gunzip -c ~/Downloads/$t.csv.gz | docker exec -i grid_authority_db \
        psql -U grid -d grid_authority -c "\copy $t FROM STDIN WITH (FORMAT csv, HEADER)"
done
```

`--no-owner --no-privileges` matters: the dump names `grid_owner` and `grid_api`, which
do not exist locally, and without those flags nothing restores.

**`forecast_issues` needs a staging table.** Its `horizon_h` is a stored generated
column, which `COPY` leaves out of its default column list — so a CSV exported with
`SELECT *` has one field more than `COPY` expects and fails with "extra data after last
expected column". Load it through a table that treats the column as ordinary, then insert
the rest and let the generation recompute it:

```sh
docker exec grid_authority_db psql -U grid -d grid_authority -c "
CREATE TABLE staging_forecast_issues (
  id bigint, source text, model text, zone_key text,
  issue_time_utc timestamptz, target_time_utc timestamptz,
  horizon_h integer, metric text, value numeric(12,2), ingested_at timestamptz);"

gunzip -c ~/Downloads/forecast_issues.csv.gz | docker exec -i grid_authority_db \
    psql -U grid -d grid_authority -c "\copy staging_forecast_issues FROM STDIN WITH (FORMAT csv, HEADER)"

docker exec grid_authority_db psql -U grid -d grid_authority -c "
INSERT INTO forecast_issues (id, source, model, zone_key, issue_time_utc,
                             target_time_utc, metric, value, ingested_at)
SELECT id, source, model, zone_key, issue_time_utc, target_time_utc, metric, value, ingested_at
  FROM staging_forecast_issues ON CONFLICT DO NOTHING;
DROP TABLE staging_forecast_issues;"
```

The recomputed horizons were checked against the host's for all 182,401 rows and match
exactly, so nothing is invented by the round trip.

Finally, confirm the schema is current and the slice arrived:

```sh
uv run --env-file .env eia migrate status
docker exec grid_authority_db psql -U grid -d grid_authority -c "
SELECT count(DISTINCT period_utc::date) AS hourly_days FROM obs_region_hourly;
SELECT resolution, count(*) FROM map_snapshot_agg GROUP BY 1;"
```

Nothing here touches production: `.env` points at the Docker database throughout. The
test suite creates throwaway `test_*` schemas in whatever `DATABASE_URL` names, so run it
only against the local one; `docker compose down -v` resets everything.

## Data sources

See `/about/data` on the running site, or `config/sources.yaml`, for the full list with
licenses and attribution. EIA Form 930 data is a U.S. Government work in the public domain.

## License

Copyright (C) 2026 Drew Meyers

This program is free software: you can redistribute it and/or modify it under the terms
of the GNU Affero General Public License, version 3, as published by the Free Software
Foundation. This program is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the [LICENSE](LICENSE) file for the full text.

Section 13 matters here: if you run a modified version of this on a network server, you
must offer its source to the users of that server. The deployed site does this through
the link in its footer and on `/about/data`.
