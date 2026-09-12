"""The revise job.

Re-fetches the last seven days through the same upsert path as `poll`. Its purpose is
not to find missing data — `poll` already has it — but to detect and date the changes
EIA makes after first publication.

That is why `revised_at` is set only on a genuine value change. If re-ingesting an
unchanged number counted as a revision, every row would look revised every day and the
question this job exists to answer would become unanswerable.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import psycopg

from workers.config import AppConfig
from workers.db.observations import (
    WriteResult,
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

JOB = "revise"
DEFAULT_DAYS = 7


@dataclass
class ReviseSummary:
    """What a revision sweep found."""

    job: str = JOB
    rows_written: int = 0
    requests: int = 0
    duration_s: float = 0.0
    warnings: list[str] = field(default_factory=list)
    region: WriteResult = field(default_factory=WriteResult)
    mix: WriteResult = field(default_factory=WriteResult)
    interchange: WriteResult = field(default_factory=WriteResult)
    snapshots_built: int = 0

    @property
    def changed_rows(self) -> int:
        """Rows whose published value actually moved since we last saw them."""
        return self.region.revised + self.mix.revised + self.interchange.revised

    def as_json(self) -> str:
        return json.dumps(
            {
                "job": self.job,
                "rows_written": self.rows_written,
                "requests": self.requests,
                "duration_s": round(self.duration_s, 3),
                "warnings": self.warnings,
                "changed_rows": self.changed_rows,
            },
            separators=(",", ":"),
        )


def run_revise(
    connection: psycopg.Connection,
    client: EiaClient,
    config: AppConfig,
    *,
    days: int = DEFAULT_DAYS,
    now: datetime | None = None,
) -> ReviseSummary:
    """Re-fetch the trailing window and record what changed."""
    started = time.monotonic()
    moment = current_hour(now)
    summary = ReviseSummary()

    try:
        validate_facets(client.discover_facets(), config)
        start = moment - timedelta(days=days)

        latest = {
            dataset: client.route_metadata(dataset).latest
            for dataset in (ROUTE_REGION, ROUTE_FUEL_TYPE, ROUTE_INTERCHANGE)
        }

        region = map_region_rows(
            client.region_data(start, min(moment, latest[ROUTE_REGION])), config, moment
        )
        mix = map_fuel_rows(
            client.fuel_type_data(start, min(moment, latest[ROUTE_FUEL_TYPE])), config, moment
        )
        interchange = map_interchange_rows(
            client.interchange_data(start, min(moment, latest[ROUTE_INTERCHANGE])),
            config,
            moment,
        )

        summary.region = write_region(connection, region)
        summary.mix = write_mix(connection, mix)
        summary.interchange = write_interchange(connection, interchange)
        summary.rows_written = (
            summary.region.written + summary.mix.written + summary.interchange.written
        )

        # Only hours whose values moved need a new snapshot.
        changed_periods = {
            observation.period_utc for observation in region if summary.region.revised
        } | {observation.period_utc for observation in mix if summary.mix.revised}
        summary.snapshots_built = rebuild_snapshots(connection, changed_periods, config)

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
            requests_made=client.requests_made,
            duration_seconds=time.monotonic() - started,
        )
        connection.commit()
        raise
