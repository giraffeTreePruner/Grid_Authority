"""The poll job.

Runs twice an hour. Fetches a recent window of each route group, upserts it, captures
the day-ahead forecast as a vintage, and records what happened in `source_status`
whether it succeeded or failed.

The window is derived per dataset from what EIA says it actually holds, not from the
clock. Measured on 2026-09-12, fuel-type ran about 19 hours behind and interchange
about 42; a fixed `now-12h` window returns nothing at all for either, and the map would
never show a generation mix.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import psycopg

from workers.config import AppConfig
from workers.db.observations import (
    WriteResult,
    record_status,
    write_forecast_issues,
    write_interchange,
    write_mix,
    write_region,
)
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
    map_forecast_rows,
    map_fuel_rows,
    map_interchange_rows,
    map_region_rows,
)

JOB = "poll"
LOOKBACK_HOURS = 12
FORECAST_FORWARD_HOURS = 48
REQUEST_BUDGET_WARNING = 15


@dataclass
class PollSummary:
    """The single-line JSON summary a job prints as its last line of stdout."""

    job: str = JOB
    rows_written: int = 0
    requests: int = 0
    duration_s: float = 0.0
    warnings: list[str] = field(default_factory=list)
    region: WriteResult = field(default_factory=WriteResult)
    mix: WriteResult = field(default_factory=WriteResult)
    interchange: WriteResult = field(default_factory=WriteResult)
    forecast_issues: int = 0
    periods_touched: set[datetime] = field(default_factory=set)
    data_latest_period: datetime | None = None

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


def observation_window(
    latest_published: datetime, now: datetime, hours: int = LOOKBACK_HOURS
) -> tuple[datetime, datetime]:
    """The window to request for a dataset of observations.

    Ends at whichever is earlier: the newest hour the dataset holds, or the current
    hour. A dataset running hours behind is followed down to where its data actually
    is; one that is current is not asked for the future.
    """
    end = min(latest_published, current_hour(now))
    return end - timedelta(hours=hours), end


def run_poll(
    connection: psycopg.Connection,
    client: EiaClient,
    config: AppConfig,
    now: datetime | None = None,
) -> PollSummary:
    """One poll cycle. Raises on failure, after recording it."""
    started = time.monotonic()
    moment = (now or datetime.now(UTC)).astimezone(UTC)
    summary = PollSummary()

    try:
        validate_facets(client.discover_facets(), config)

        metadata = {
            dataset: client.route_metadata(dataset)
            for dataset in (ROUTE_REGION, ROUTE_FUEL_TYPE, ROUTE_INTERCHANGE)
        }

        for dataset, meta in metadata.items():
            lag = meta.lag(moment)
            if lag > timedelta(hours=LOOKBACK_HOURS):
                summary.warnings.append(
                    f"{dataset} is {lag.total_seconds() / 3600:.0f}h behind; "
                    "window follows its endPeriod"
                )

        region_start, region_end = observation_window(metadata[ROUTE_REGION].latest, moment)
        fuel_start, fuel_end = observation_window(metadata[ROUTE_FUEL_TYPE].latest, moment)
        ich_start, ich_end = observation_window(metadata[ROUTE_INTERCHANGE].latest, moment)

        region_rows = client.region_data(region_start, region_end, types=("D", "NG", "TI"))
        forecast_rows = client.region_data(
            current_hour(moment) - timedelta(hours=LOOKBACK_HOURS),
            current_hour(moment) + timedelta(hours=FORECAST_FORWARD_HOURS),
            types=("DF",),
        )
        fuel_rows = client.fuel_type_data(fuel_start, fuel_end)
        interchange_rows = client.interchange_data(ich_start, ich_end)

        region = map_region_rows(region_rows, config, moment)
        mix = map_fuel_rows(fuel_rows, config, moment)
        interchange = map_interchange_rows(interchange_rows, config, moment)
        # The issue time is the cycle's start: the moment this vintage was observed.
        issues = map_forecast_rows(forecast_rows, config, moment)

        summary.region = write_region(connection, region)
        summary.mix = write_mix(connection, mix)
        summary.interchange = write_interchange(connection, interchange)
        summary.forecast_issues = write_forecast_issues(connection, issues)

        summary.periods_touched = (
            {o.period_utc for o in region}
            | {o.period_utc for o in mix}
            | {o.period_utc for o in interchange}
        )
        summary.rows_written = (
            summary.region.written
            + summary.mix.written
            + summary.interchange.written
            + summary.forecast_issues
        )
        summary.data_latest_period = max((meta.latest for meta in metadata.values()), default=None)
        summary.requests = client.requests_made
        summary.duration_s = time.monotonic() - started

        if summary.requests > REQUEST_BUDGET_WARNING:
            summary.warnings.append(
                f"{summary.requests} requests this cycle, over the "
                f"{REQUEST_BUDGET_WARNING} expected"
            )

        record_status(
            connection,
            SOURCE,
            JOB,
            succeeded=True,
            rows_written=summary.rows_written,
            requests_made=summary.requests,
            duration_seconds=summary.duration_s,
            data_latest_period=summary.data_latest_period,
        )
        connection.commit()
        return summary

    except Exception as error:
        # The failure must survive the rollback of whatever the job had written.
        connection.rollback()
        record_status(
            connection,
            SOURCE,
            JOB,
            succeeded=False,
            error=f"{type(error).__name__}: {error}"[:2000],
            requests_made=client.requests_made,
            duration_seconds=time.monotonic() - started,
        )
        connection.commit()
        raise
