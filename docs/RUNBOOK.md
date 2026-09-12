# Runbook

Operational documentation for Grid Authority. Sections are filled in as the corresponding
parts of the system are built; a fresh host must be reproducible from this file alone.

## Local development

Prerequisites: Node 22 (`.nvmrc`), Python 3.11 (`.python-version`), pnpm, uv, Docker.

```sh
cp .env.example .env          # fill in EIA_API_KEY and DATABASE_URL
pnpm install
uv sync --all-groups
docker compose up -d db
```

For the Docker Compose database:

```
DATABASE_URL=postgresql://grid:grid@localhost:5432/grid_authority
```

## Checks

```sh
pnpm format && pnpm lint && pnpm typecheck && pnpm test
uv run ruff format --check . && uv run ruff check . && uv run mypy . && uv run pytest
```

## Environment variables

| Variable           | Purpose                                                                      |
| ------------------ | ---------------------------------------------------------------------------- |
| `EIA_API_KEY`      | EIA open-data API key. Register at https://www.eia.gov/opendata/register.php |
| `DATABASE_URL`     | PostgreSQL 16 connection string                                              |
| `PORT`             | API listen port                                                              |
| `NODE_ENV`         | `development` or `production`                                                |
| `LOG_LEVEL`        | pino level: `trace`–`fatal`                                                  |
| `PUBLIC_BASE_URL`  | Public origin; also the only allowed CORS origin                             |
| `TZ`               | Always `UTC`                                                                 |
| `GEOMETRY_VERSION` | Cache-busting version for the committed `zones.pmtiles` artifact             |

`.env` is gitignored and must never be committed. `.env.example` lists every variable with
empty values.

## Deployment

To be written in task 22.
