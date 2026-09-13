"""The hourly map snapshot.

One JSON document per hour, built on write and served verbatim, so rendering the map
never touches an observation table.

Two rules the format depends on: a zone with no measurement for a metric is `null` and
never `0`, and only zones marked `in_map` appear. Aggregates are excluded because
drawing them would double-count the balancing authorities they contain.
"""

from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal
from typing import TypedDict

import psycopg
from psycopg.types.json import Json

from workers.config import AppConfig

# Fixed order. Consumers index into the array by position, so this is part of the
# contract and may not be reordered without changing the served `metrics` list.
METRICS = (
    "demand_mw",
    "net_generation_mw",
    "net_interchange_mw",
    "renewable_share",
    "low_carbon_share",
)

MW_PLACES = Decimal("0.1")
SHARE_PLACES = Decimal("0.001")


class Snapshot(TypedDict):
    """The document served verbatim by GET /map/snapshot.

    `zones` maps a zone key to one value per entry in `metrics`, in that order.
    """

    period: str
    metrics: list[str]
    zones: dict[str, list[float | None]]
    built_at: str


def _round(value: Decimal | None, places: Decimal) -> float | None:
    """Round for transport, preserving null.

    Zero is a real measurement. Only an absent one becomes null.
    """
    if value is None:
        return None
    return float(value.quantize(places))


def build_snapshot(connection: psycopg.Connection, period: datetime, config: AppConfig) -> Snapshot:
    """Assemble the document for one hour.

    Every in-map zone appears, whether or not it reported, so a consumer can tell
    "no data" from "not a zone" without consulting the registry.
    """
    in_map = [zone.key for zone in config.zones.in_map()]

    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT COALESCE(r.zone_key, m.zone_key) AS zone_key,
                   r.demand_mw,
                   r.net_generation_mw,
                   r.total_interchange_mw,
                   m.renewable_share,
                   m.low_carbon_share
              FROM obs_region_hourly r
              FULL OUTER JOIN obs_mix_hourly m
                ON m.zone_key = r.zone_key
               AND m.period_utc = r.period_utc
               AND m.source = r.source
             WHERE COALESCE(r.period_utc, m.period_utc) = %(period)s
               AND COALESCE(r.zone_key, m.zone_key) = ANY(%(keys)s)
            """,
            {"period": period, "keys": in_map},
        )
        measured = {
            row[0]: (
                _round(row[1], MW_PLACES),
                _round(row[2], MW_PLACES),
                _round(row[3], MW_PLACES),
                _round(row[4], SHARE_PLACES),
                _round(row[5], SHARE_PLACES),
            )
            for row in cursor.fetchall()
        }

    empty: tuple[float | None, ...] = (None,) * len(METRICS)
    return Snapshot(
        period=_iso(period),
        metrics=list(METRICS),
        zones={key: list(measured.get(key, empty)) for key in sorted(in_map)},
        built_at=_iso(datetime.now(tz=period.tzinfo)),
    )


def _iso(moment: datetime) -> str:
    """An ISO-8601 instant with a Z suffix, as the contract shows."""
    return moment.astimezone(tz=moment.tzinfo).strftime("%Y-%m-%dT%H:%M:%SZ")


def store_snapshot(connection: psycopg.Connection, period: datetime, payload: Snapshot) -> None:
    """Write the exact bytes the API will serve for this hour."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO map_snapshot (period_utc, payload, built_at)
            VALUES (%s, %s, now())
            ON CONFLICT (period_utc) DO UPDATE
               SET payload = EXCLUDED.payload, built_at = now()
            """,
            (period, Json(payload)),
        )


def rebuild_snapshots(
    connection: psycopg.Connection, periods: set[datetime], config: AppConfig
) -> int:
    """Rebuild the snapshot for each period. Returns how many were written."""
    for period in sorted(periods):
        store_snapshot(connection, period, build_snapshot(connection, period, config))
    return len(periods)


def hours_needing_snapshots(
    connection: psycopg.Connection,
    start: datetime,
    end: datetime,
    *,
    missing_only: bool = True,
) -> set[datetime]:
    """Observed hours in the range, by default only those with no snapshot yet.

    An hour can hold observations and no snapshot: the snapshot is derived, and a run
    that stored observations but did not reach its rebuild leaves the two out of step.
    Nothing here contacts EIA — the snapshot is built entirely from stored rows.
    """
    # All three observation tables, matching what an ingest job counts as touched, so
    # a repair reproduces exactly the set the interrupted run would have built.
    observed = """
        SELECT DISTINCT period_utc FROM obs_region_hourly
         WHERE period_utc BETWEEN %(start)s AND %(end)s
        UNION
        SELECT DISTINCT period_utc FROM obs_mix_hourly
         WHERE period_utc BETWEEN %(start)s AND %(end)s
        UNION
        SELECT DISTINCT period_utc FROM obs_interchange_hourly
         WHERE period_utc BETWEEN %(start)s AND %(end)s
    """
    if missing_only:
        observed += """
        EXCEPT
        SELECT period_utc FROM map_snapshot
         WHERE period_utc BETWEEN %(start)s AND %(end)s
    """
    with connection.cursor() as cursor:
        cursor.execute(observed, {"start": start, "end": end})
        return {row[0] for row in cursor.fetchall()}


def recent_complete_hours(connection: psycopg.Connection, count: int = 2) -> set[datetime]:
    """The newest hours that have any observation.

    §7.1 rebuilds these every cycle regardless of what was touched, so a snapshot is
    never left stale because an hour happened to receive no revision.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT DISTINCT period_utc FROM obs_region_hourly ORDER BY period_utc DESC LIMIT %s",
            (count,),
        )
        return {row[0] for row in cursor.fetchall()}


def snapshot_bytes(payload: Snapshot) -> bytes:
    """The serialised document, as stored and served."""
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")
