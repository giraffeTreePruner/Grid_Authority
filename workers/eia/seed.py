"""Load the recorded fixtures into a database, for development only.

This exists so the UI can be looked at without an API key. It is not a substitute for
`poll`: the data is real but frozen at the hour it was recorded, so the map will show a
stale banner, which is itself worth seeing.

Nothing here fabricates anything. The fixtures are responses EIA actually returned, and
they go through the same mappers, share computation and upserts as a live poll.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import psycopg

from workers.config import AppConfig
from workers.db.observations import (
    record_status,
    write_forecast_issues,
    write_interchange,
    write_mix,
    write_region,
)
from workers.db.snapshots import rebuild_snapshots
from workers.eia.mappers import (
    map_forecast_rows,
    map_fuel_rows,
    map_interchange_rows,
    map_region_rows,
)

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "eia"


class SeedError(RuntimeError):
    """The database already holds data, or a fixture is missing."""


@dataclass
class SeedSummary:
    """What seeding wrote."""

    region: int = 0
    mix: int = 0
    interchange: int = 0
    forecasts: int = 0
    snapshots: int = 0
    periods: set[datetime] = field(default_factory=set)


def _rows(relative: str) -> list[dict[str, Any]]:
    path = FIXTURES / relative
    if not path.is_file():
        raise SeedError(f"fixture {relative} is missing")
    data = json.loads(path.read_text(encoding="utf-8"))["response"]["data"]
    assert isinstance(data, list)
    return data


def has_observations(connection: psycopg.Connection) -> bool:
    with connection.cursor() as cursor:
        cursor.execute("SELECT EXISTS (SELECT 1 FROM obs_region_hourly)")
        row = cursor.fetchone()
    return bool(row and row[0])


def seed_from_fixtures(
    connection: psycopg.Connection, config: AppConfig, *, force: bool = False
) -> SeedSummary:
    """Write every recorded fixture through the normal ingest path."""
    if not force and has_observations(connection):
        raise SeedError(
            "this database already holds observations. Seeding would mix recorded "
            "fixtures with real data; pass --force if that is what you want."
        )

    summary = SeedSummary()

    # A clock past the newest recorded hour, so none of it is treated as the
    # in-progress hour and dropped.
    newest = max(
        datetime.strptime(row["period"], "%Y-%m-%dT%H").replace(tzinfo=UTC)
        for relative in ("poll/region-d-ng-ti.json", "pagination/fuel-type-page-000.json")
        for row in _rows(relative)
    )
    now = newest + timedelta(hours=1)

    region = map_region_rows(_rows("poll/region-d-ng-ti.json"), config, now)
    mix = map_fuel_rows(
        _rows("pagination/fuel-type-page-000.json") + _rows("pagination/fuel-type-page-001.json"),
        config,
        now,
    )
    interchange = map_interchange_rows(_rows("poll/interchange.json"), config, now)
    forecasts = map_forecast_rows(_rows("poll/region-df.json"), config, now)

    summary.region = write_region(connection, region).written
    summary.mix = write_mix(connection, mix).written
    summary.interchange = write_interchange(connection, interchange).written
    summary.forecasts = write_forecast_issues(connection, forecasts)

    summary.periods = (
        {o.period_utc for o in region}
        | {o.period_utc for o in mix}
        | {o.period_utc for o in interchange}
    )
    summary.snapshots = rebuild_snapshots(connection, summary.periods, config)

    # Without this, meta.data_latest_period is null and the API reports "no data at
    # all" while showing a map full of it. Recorded under its own job name so nobody
    # mistakes seeded data for a poll that ran.
    record_status(
        connection,
        "eia",
        "seed-fixtures",
        succeeded=True,
        rows_written=summary.region + summary.mix + summary.interchange,
        data_latest_period=newest,
    )
    connection.commit()
    return summary
