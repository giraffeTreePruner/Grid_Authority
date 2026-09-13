"""The backfill job.

Walks the trailing window a day at a time, oldest first, through the same mapping and
upsert path as `poll`. Run once, manually.

Resumable by design: a day already complete is skipped, so an interrupted run can be
restarted and reaches the same state as one that was never interrupted. Completeness is
judged from what is in the database, not from a marker file that could outlive the data
it describes.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import psycopg

from workers.config import AppConfig
from workers.db.observations import (
    record_status,
    write_interchange,
    write_mix,
    write_region,
)
from workers.db.snapshots import rebuild_snapshots
from workers.eia.client import (
    ROUTE_FUEL_TYPE,
    ROUTE_INTERCHANGE,
    ROUTE_REGION,
    EiaClient,
    validate_facets,
)
from workers.eia.mappers import (
    SOURCE,
    current_hour,
    map_fuel_rows,
    map_interchange_rows,
    map_region_rows,
)

JOB = "backfill"
DEFAULT_DAYS = 90

# A day is complete when every in-map zone that reports demand has at least this many
# hours. Not 24: EIA genuinely misses hours, and demanding a full day would make a
# resumable run re-fetch the same day forever.
HOURS_FOR_A_COMPLETE_DAY = 23


@dataclass
class BackfillSummary:
    """What a backfill run did."""

    job: str = JOB
    rows_written: int = 0
    requests: int = 0
    duration_s: float = 0.0
    warnings: list[str] = field(default_factory=list)
    days_fetched: list[str] = field(default_factory=list)
    days_skipped: list[str] = field(default_factory=list)
    snapshots_built: int = 0

    def as_json(self) -> str:
        return json.dumps(
            {
                "job": self.job,
                "rows_written": self.rows_written,
                "requests": self.requests,
                "duration_s": round(self.duration_s, 3),
                "warnings": self.warnings,
            },
            separators=(",", ":"),
        )


# EIA-930 begins here. All three datasets report 2019-01-01T00 as their first hour.
EARLIEST_PERIOD = datetime(2019, 1, 1, tzinfo=UTC)


def days_since(earliest: datetime, now: datetime) -> int:
    """How many trailing days reach back to `earliest`, inclusive of both ends."""
    return (now.astimezone(UTC).date() - earliest.astimezone(UTC).date()).days + 1


def day_bounds(day: datetime) -> tuple[datetime, datetime]:
    """The UTC hour range covering one day, inclusive of both ends."""
    start = day.replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(hours=23)


def days_in_window(days: int, now: datetime) -> list[datetime]:
    """Each day to consider, oldest first.

    The current day is included; its incomplete hours are dropped by the mapper, and
    the day is simply re-fetched on a later run.
    """
    today = current_hour(now).replace(hour=0)
    return [today - timedelta(days=offset) for offset in range(days - 1, -1, -1)]


def day_is_complete(connection: psycopg.Connection, day: datetime, config: AppConfig) -> bool:
    """Whether this day already holds enough hours for every zone that reports demand.

    A zone with no demand capability is not expected to contribute, so requiring it
    would make every day look permanently incomplete.
    """
    expected = [zone.key for zone in config.zones.in_map() if zone.capabilities.demand]
    if not expected:
        return False

    start, end = day_bounds(day)
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT count(*)
              FROM (
                    SELECT zone_key
                      FROM obs_region_hourly
                     WHERE period_utc BETWEEN %(start)s AND %(end)s
                       AND zone_key = ANY(%(keys)s)
                       AND demand_mw IS NOT NULL
                     GROUP BY zone_key
                    HAVING count(*) >= %(hours)s
                   ) AS complete
            """,
            {"start": start, "end": end, "keys": expected, "hours": HOURS_FOR_A_COMPLETE_DAY},
        )
        row = cursor.fetchone()
    return bool(row and row[0] >= len(expected))


def run_backfill(
    connection: psycopg.Connection,
    client: EiaClient,
    config: AppConfig,
    *,
    days: int = DEFAULT_DAYS,
    force: bool = False,
    now: datetime | None = None,
) -> BackfillSummary:
    """Backfill the trailing window. Raises on failure, after recording it."""
    started = time.monotonic()
    moment = (now or datetime.now(UTC)).astimezone(UTC)
    summary = BackfillSummary()
    built: set[datetime] = set()

    try:
        validate_facets(client.discover_facets(), config)

        latest = {
            dataset: client.route_metadata(dataset).latest
            for dataset in (ROUTE_REGION, ROUTE_FUEL_TYPE, ROUTE_INTERCHANGE)
        }

        for day in days_in_window(days, moment):
            label = day.strftime("%Y-%m-%d")
            if not force and day_is_complete(connection, day, config):
                summary.days_skipped.append(label)
                continue

            start, end = day_bounds(day)
            # Never ask a dataset for hours it has not published; that is an empty
            # response and a wasted request.
            region_end = min(end, latest[ROUTE_REGION], current_hour(moment))
            fuel_end = min(end, latest[ROUTE_FUEL_TYPE], current_hour(moment))
            ich_end = min(end, latest[ROUTE_INTERCHANGE], current_hour(moment))

            region = (
                map_region_rows(client.region_data(start, region_end), config, moment)
                if region_end >= start
                else []
            )
            mix = (
                map_fuel_rows(client.fuel_type_data(start, fuel_end), config, moment)
                if fuel_end >= start
                else []
            )
            interchange = (
                map_interchange_rows(client.interchange_data(start, ich_end), config, moment)
                if ich_end >= start
                else []
            )

            written = write_region(connection, region)
            written = written.add(write_mix(connection, mix))
            written = written.add(write_interchange(connection, interchange))

            summary.rows_written += written.written
            summary.days_fetched.append(label)

            # Rebuild this day's snapshots inside the loop, not once at the end. Days
            # do not overlap, so this builds the same hours either way — but at the end
            # an interruption discards every snapshot while keeping the observations,
            # and the resumed run skips those days as complete and never rebuilds them.
            # The map then has ninety days of observations and a handful of hours to
            # draw. Costs nothing here: the snapshot is built from rows already stored.
            day_periods = (
                {o.period_utc for o in region}
                | {o.period_utc for o in mix}
                | {o.period_utc for o in interchange}
            )
            rebuild_snapshots(connection, day_periods, config)
            built |= day_periods
            # Updated inside the loop, so a run that raises still reports what it built.
            summary.snapshots_built = len(built)
            # Commit each day so an interruption keeps the days already done.
            connection.commit()

        summary.requests = client.requests_made
        summary.duration_s = time.monotonic() - started

        record_status(
            connection,
            SOURCE,
            JOB,
            succeeded=True,
            rows_written=summary.rows_written,
            requests_made=summary.requests,
            duration_seconds=summary.duration_s,
            data_latest_period=max(latest.values(), default=None),
        )
        connection.commit()
        return summary

    except Exception as error:
        connection.rollback()
        record_status(
            connection,
            SOURCE,
            JOB,
            succeeded=False,
            error=f"{type(error).__name__}: {error}"[:2000],
            rows_written=summary.rows_written,
            requests_made=client.requests_made,
            duration_seconds=time.monotonic() - started,
        )
        connection.commit()
        raise
