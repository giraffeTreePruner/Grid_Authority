"""Writing observations.

Two properties every writer here holds:

- **Idempotent.** Running an ingest twice over the same window leaves the database
  exactly as it was. `ingested_at` moves; nothing else does.
- **Honest about revision.** `revised_at` is set only when a published value actually
  changed. Re-ingesting the same number is not a revision, and treating it as one
  would make it impossible to answer how much EIA really restates after publication.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

import psycopg
from psycopg.types.json import Json

from workers.eia.mappers import (
    ForecastIssue,
    InterchangeObservation,
    MixObservation,
    RegionObservation,
)

REGION_VALUE_COLUMNS = ("demand_mw", "net_generation_mw", "total_interchange_mw")

MIX_MODE_COLUMNS = (
    "coal",
    "gas",
    "oil",
    "nuclear",
    "hydro",
    "pumped_storage",
    "wind",
    "solar",
    "geothermal",
    "biomass",
    "battery_storage",
    "other_storage",
    "imports",
    "unknown",
)


@dataclass
class WriteResult:
    """How a batch of upserts landed.

    `changed_periods` holds only the hours that actually moved, so a caller rebuilding
    snapshots rebuilds those hours rather than everything it happened to touch.
    """

    inserted: int = 0
    revised: int = 0
    unchanged: int = 0
    changed_periods: set[datetime] = field(default_factory=set)

    @property
    def written(self) -> int:
        return self.inserted + self.revised

    def add(self, other: WriteResult) -> WriteResult:
        return WriteResult(
            inserted=self.inserted + other.inserted,
            revised=self.revised + other.revised,
            unchanged=self.unchanged + other.unchanged,
            changed_periods=self.changed_periods | other.changed_periods,
        )


def _tally(rows: list[tuple[bool, bool, datetime]]) -> WriteResult:
    """Fold RETURNING rows of (inserted, revised, period) into a result."""
    result = WriteResult()
    for inserted, revised, period in rows:
        if inserted:
            result.inserted += 1
            result.changed_periods.add(period)
        elif revised:
            result.revised += 1
            result.changed_periods.add(period)
        else:
            result.unchanged += 1
    return result


def write_region(
    connection: psycopg.Connection, observations: list[RegionObservation]
) -> WriteResult:
    """Upsert zone-hour observations, marking genuine revisions."""
    if not observations:
        return WriteResult()

    assignments = ", ".join(f"{c} = EXCLUDED.{c}" for c in REGION_VALUE_COLUMNS)
    current = ", ".join(f"obs_region_hourly.{c}" for c in REGION_VALUE_COLUMNS)
    incoming = ", ".join(f"EXCLUDED.{c}" for c in REGION_VALUE_COLUMNS)

    statement = f"""
        INSERT INTO obs_region_hourly
            (zone_key, period_utc, source, {", ".join(REGION_VALUE_COLUMNS)},
             first_seen_at, revised_at, ingested_at)
        VALUES (%s, %s, %s, %s, %s, %s, now(), NULL, now())
        ON CONFLICT (zone_key, period_utc, source) DO UPDATE
           SET {assignments},
               revised_at = now(),
               ingested_at = now()
         WHERE ({current}) IS DISTINCT FROM ({incoming})
        RETURNING (xmax = 0) AS inserted, (revised_at IS NOT NULL) AS revised
    """

    rows: list[tuple[bool, bool, datetime]] = []
    unchanged = 0
    with connection.cursor() as cursor:
        for observation in observations:
            cursor.execute(
                statement,
                (
                    observation.zone_key,
                    observation.period_utc,
                    observation.source,
                    observation.demand_mw,
                    observation.net_generation_mw,
                    observation.total_interchange_mw,
                ),
            )
            row = cursor.fetchone()
            if row is None:
                unchanged += 1
            else:
                rows.append((bool(row[0]), bool(row[1]), observation.period_utc))

    result = _tally(rows)
    result.unchanged += unchanged
    return result


def write_mix(connection: psycopg.Connection, observations: list[MixObservation]) -> WriteResult:
    """Upsert generation-mix observations with their derived shares."""
    if not observations:
        return WriteResult()

    value_columns = [f"{mode}_mw" for mode in MIX_MODE_COLUMNS] + [
        "total_generation_mw",
        "renewable_share",
        "low_carbon_share",
        "raw",
        "aggregated",
        "n_intervals",
        "expected_intervals",
    ]
    placeholders = ", ".join(["%s"] * (3 + len(value_columns)))
    assignments = ", ".join(f"{c} = EXCLUDED.{c}" for c in value_columns)
    # `raw` is jsonb and has no equality operator issue, but comparing it as part of a
    # row constructor requires a cast; compare the measured columns instead.
    compared = [f"{mode}_mw" for mode in MIX_MODE_COLUMNS] + ["total_generation_mw"]
    current = ", ".join(f"obs_mix_hourly.{c}" for c in compared)
    incoming = ", ".join(f"EXCLUDED.{c}" for c in compared)

    statement = f"""
        INSERT INTO obs_mix_hourly
            (zone_key, period_utc, source, {", ".join(value_columns)},
             first_seen_at, revised_at, ingested_at)
        VALUES ({placeholders}, now(), NULL, now())
        ON CONFLICT (zone_key, period_utc, source) DO UPDATE
           SET {assignments},
               revised_at = now(),
               ingested_at = now()
         WHERE ({current}) IS DISTINCT FROM ({incoming})
        RETURNING (xmax = 0) AS inserted, (revised_at IS NOT NULL) AS revised
    """

    rows: list[tuple[bool, bool, datetime]] = []
    unchanged = 0
    with connection.cursor() as cursor:
        for observation in observations:
            values = [observation.modes.get(mode) for mode in MIX_MODE_COLUMNS]
            cursor.execute(
                statement,
                (
                    observation.zone_key,
                    observation.period_utc,
                    observation.source,
                    *values,
                    observation.total_generation_mw,
                    observation.renewable_share,
                    observation.low_carbon_share,
                    Json(observation.raw),
                    observation.aggregated,
                    observation.n_intervals,
                    observation.expected_intervals,
                ),
            )
            row = cursor.fetchone()
            if row is None:
                unchanged += 1
            else:
                rows.append((bool(row[0]), bool(row[1]), observation.period_utc))

    result = _tally(rows)
    result.unchanged += unchanged
    return result


def write_interchange(
    connection: psycopg.Connection, observations: list[InterchangeObservation]
) -> WriteResult:
    """Upsert directed interchange."""
    if not observations:
        return WriteResult()

    statement = """
        INSERT INTO obs_interchange_hourly
            (from_zone, to_zone, period_utc, source, mw, first_seen_at, revised_at, ingested_at)
        VALUES (%s, %s, %s, %s, %s, now(), NULL, now())
        ON CONFLICT (from_zone, to_zone, period_utc, source) DO UPDATE
           SET mw = EXCLUDED.mw, revised_at = now(), ingested_at = now()
         WHERE obs_interchange_hourly.mw IS DISTINCT FROM EXCLUDED.mw
        RETURNING (xmax = 0) AS inserted, (revised_at IS NOT NULL) AS revised
    """

    rows: list[tuple[bool, bool, datetime]] = []
    unchanged = 0
    with connection.cursor() as cursor:
        for observation in observations:
            cursor.execute(
                statement,
                (
                    observation.from_zone,
                    observation.to_zone,
                    observation.period_utc,
                    observation.source,
                    observation.mw,
                ),
            )
            row = cursor.fetchone()
            if row is None:
                unchanged += 1
            else:
                rows.append((bool(row[0]), bool(row[1]), observation.period_utc))

    result = _tally(rows)
    result.unchanged += unchanged
    return result


def write_forecast_issues(connection: psycopg.Connection, issues: list[ForecastIssue]) -> int:
    """Append forecast vintages.

    Append-only: a vintage already captured is left exactly as it was. The unique
    constraint absorbs the duplicate, so re-running a cycle adds nothing.
    """
    if not issues:
        return 0

    statement = """
        INSERT INTO forecast_issues
            (source, model, zone_key, issue_time_utc, target_time_utc, metric, value)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (source, model, zone_key, issue_time_utc, target_time_utc, metric)
        DO NOTHING
        RETURNING id
    """

    written = 0
    with connection.cursor() as cursor:
        for issue in issues:
            cursor.execute(
                statement,
                (
                    issue.source,
                    issue.model,
                    issue.zone_key,
                    issue.issue_time_utc,
                    issue.target_time_utc,
                    issue.metric,
                    issue.value,
                ),
            )
            if cursor.fetchone() is not None:
                written += 1
    return written


def record_status(
    connection: psycopg.Connection,
    source: str,
    job: str,
    *,
    succeeded: bool,
    error: str | None = None,
    rows_written: int = 0,
    requests_made: int = 0,
    duration_seconds: float = 0.0,
    data_latest_period: datetime | None = None,
) -> None:
    """Record the outcome of a job run, on both the success and failure paths.

    §7: a job that stops running must be visible as a stale `last_run_at` rather than
    as silence. Writing only on success is how a broken ingest looks healthy.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO source_status
                (source, job, last_run_at, last_success_at, last_failure_at, last_error,
                 rows_written, requests_made, duration_seconds, data_latest_period, updated_at)
            VALUES (%(source)s, %(job)s, now(),
                    CASE WHEN %(ok)s THEN now() END,
                    CASE WHEN %(ok)s THEN NULL ELSE now() END,
                    %(error)s, %(rows)s, %(requests)s, %(duration)s, %(latest)s, now())
            ON CONFLICT (source, job) DO UPDATE
               SET last_run_at = now(),
                   last_success_at = CASE WHEN %(ok)s THEN now()
                                          ELSE source_status.last_success_at END,
                   last_failure_at = CASE WHEN %(ok)s THEN source_status.last_failure_at
                                          ELSE now() END,
                   last_error = %(error)s,
                   rows_written = %(rows)s,
                   requests_made = %(requests)s,
                   duration_seconds = %(duration)s,
                   data_latest_period = COALESCE(%(latest)s, source_status.data_latest_period),
                   updated_at = now()
            """,
            {
                "source": source,
                "job": job,
                "ok": succeeded,
                "error": error,
                "rows": rows_written,
                "requests": requests_made,
                "duration": duration_seconds,
                "latest": data_latest_period,
            },
        )
