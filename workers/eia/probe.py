"""The latency probe.

Records how far behind each dataset actually runs, so `/api/v1/sources` can report
observed publication lag rather than a guess.

One request per dataset, and it asks for route metadata rather than data: `endPeriod`
is the newest hour the dataset holds, which is exactly the measurement, and it transfers
no rows to get it.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime

import psycopg

from workers.db.observations import record_status
from workers.eia.client import (
    ROUTE_FUEL_TYPE,
    ROUTE_INTERCHANGE,
    ROUTE_REGION,
    EiaClient,
)
from workers.eia.mappers import SOURCE, current_hour

JOB = "probe"

DATASETS = (ROUTE_REGION, ROUTE_FUEL_TYPE, ROUTE_INTERCHANGE)


@dataclass
class ProbeReading:
    """One dataset's observed lag."""

    dataset: str
    latest_period: datetime
    lag_minutes: int
    changed_rows: int = 0


@dataclass
class ProbeSummary:
    """What a probe run measured."""

    job: str = JOB
    rows_written: int = 0
    requests: int = 0
    duration_s: float = 0.0
    warnings: list[str] = field(default_factory=list)
    readings: list[ProbeReading] = field(default_factory=list)

    def as_json(self) -> str:
        return json.dumps(
            {
                "job": self.job,
                "rows_written": self.rows_written,
                "requests": self.requests,
                "duration_s": round(self.duration_s, 3),
                "warnings": self.warnings,
                "lag_minutes": {r.dataset: r.lag_minutes for r in self.readings},
            },
            separators=(",", ":"),
        )


def write_reading(connection: psycopg.Connection, reading: ProbeReading) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO probe_log (dataset, checked_at, latest_period, lag_minutes, "
            "changed_rows) VALUES (%s, now(), %s, %s, %s)",
            (reading.dataset, reading.latest_period, reading.lag_minutes, reading.changed_rows),
        )


def run_probe(
    connection: psycopg.Connection,
    client: EiaClient,
    now: datetime | None = None,
) -> ProbeSummary:
    """Measure and record each dataset's publication lag."""
    started = time.monotonic()
    moment = current_hour(now)
    summary = ProbeSummary()

    try:
        for dataset in DATASETS:
            metadata = client.route_metadata(dataset)
            lag = metadata.lag(moment)
            reading = ProbeReading(
                dataset=metadata.dataset or dataset,
                latest_period=metadata.latest,
                # A dataset whose endPeriod runs ahead of now, as region-data's does
                # because it contains the forecast, is not behind at all.
                lag_minutes=max(0, int(lag.total_seconds() // 60)),
            )
            summary.readings.append(reading)
            write_reading(connection, reading)

        summary.rows_written = len(summary.readings)
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
            data_latest_period=max((r.latest_period for r in summary.readings), default=None),
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
