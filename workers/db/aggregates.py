"""Coarser map snapshots: one document per day, week or month.

The hourly snapshot answers "what was happening at 14:00". These answer "what was that
month like", which is a different question and needs a different summary. Each period
carries two statistics per metric:

- **mean** — the average across the hours that reported. What a typical hour looked like.
- **peak** — the largest hour in the period. Where the stress was.

Both are kept because either alone misleads: a month's mean hides the evening it nearly
ran out, and a month's peak says nothing about the other 743 hours.

One rule dominates the arithmetic here. **A share is re-derived from summed generation,
never averaged.** The mean of twelve hourly percentages weights an hour generating 200 MW
the same as one generating 40,000 MW, so a quiet renewable-heavy night would pull a
month's figure up as hard as a working day pulls it down. The shares below are computed
as summed renewable generation over summed counted generation, which is the same
definition the hourly mapper uses, applied to a longer interval.
"""

from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal
from typing import TypedDict

import psycopg
from psycopg.types.json import Json

from workers.config import AppConfig
from workers.db.snapshots import METRICS, MW_PLACES, SHARE_PLACES, _iso, _round

# Postgres date_trunc units. 'week' starts Monday; 'month' starts the 1st.
RESOLUTIONS = ("day", "week", "month")

STATISTICS = ("mean", "peak")


class AggregateSnapshot(TypedDict):
    """The document served for one coarse period.

    `zones` maps a zone key to one array per statistic, each in `metrics` order, so a
    consumer indexes by position exactly as it does for an hourly snapshot.
    """

    period: str
    resolution: str
    metrics: list[str]
    statistics: list[str]
    zones: dict[str, dict[str, list[float | None]]]
    hours: int
    built_at: str


def _columns(modes: list[str]) -> str:
    """The mix columns for a set of canonical modes, as a SQL sum of coalesced values.

    Built from config rather than written out, so adding a canonical mode cannot leave
    the aggregates quietly counting the old set.
    """
    if not modes:
        return "0"
    return " + ".join(f"COALESCE(m.{mode}_mw, 0)" for mode in sorted(modes))


def _aggregate_query(config: AppConfig) -> str:
    """One pass over the joined observations, grouped by period and zone.

    Grouped in the database rather than a query per period: the full history is about
    2,800 days, and a round trip each would dominate the work.
    """
    renewable = _columns(config.modes.renewable)
    low_carbon = _columns(config.modes.low_carbon)
    counted = _columns(
        [m for m in config.modes.canonical_modes if m not in config.modes.excluded_from_mix_percent]
    )

    # Both sides are filtered to the range BEFORE the join. Filtering after it -- on
    # COALESCE(r.period_utc, m.period_utc) -- reads correctly and cannot use an index:
    # Postgres will not push a predicate through a full outer join, so it scans both
    # tables in full whatever range was asked for. Harmless for a bulk rebuild, which
    # wants every row anyway; ruinous for refresh_buckets_for, which runs on every poll
    # cycle and would scan seven years of observations to refresh one day.
    return f"""
        WITH region AS MATERIALIZED (
            SELECT zone_key, period_utc, source, demand_mw, net_generation_mw,
                   total_interchange_mw
              FROM obs_region_hourly
             WHERE period_utc >= %(start)s AND period_utc < %(end)s
               AND zone_key = ANY(%(keys)s)
        ), mix AS MATERIALIZED (
            SELECT *
              FROM obs_mix_hourly
             WHERE period_utc >= %(start)s AND period_utc < %(end)s
               AND zone_key = ANY(%(keys)s)
        )
        SELECT date_trunc(%(unit)s, COALESCE(r.period_utc, m.period_utc)) AS bucket,
               COALESCE(r.zone_key, m.zone_key) AS zone_key,
               count(*) AS hours,

               avg(r.demand_mw) AS demand_mean,
               max(r.demand_mw) AS demand_peak,
               avg(r.net_generation_mw) AS generation_mean,
               max(r.net_generation_mw) AS generation_peak,
               avg(r.total_interchange_mw) AS interchange_mean,

               -- Interchange is signed: the biggest hour is the one furthest from zero,
               -- and it keeps its sign. max() would report the largest import and call
               -- an exporting zone's peak zero.
               (array_agg(r.total_interchange_mw
                          ORDER BY abs(r.total_interchange_mw) DESC NULLS LAST))[1]
                   AS interchange_peak,

               -- Shares from summed generation, not averaged ratios.
               sum({renewable}) FILTER (WHERE m.zone_key IS NOT NULL) AS renewable_mwh,
               sum({low_carbon}) FILTER (WHERE m.zone_key IS NOT NULL) AS low_carbon_mwh,
               sum({counted}) FILTER (WHERE m.zone_key IS NOT NULL) AS counted_mwh,

               -- The best single hour, which is a real measurement rather than a ratio
               -- of sums and so is taken directly.
               max(m.renewable_share) AS renewable_peak,
               max(m.low_carbon_share) AS low_carbon_peak

          FROM region r
          FULL OUTER JOIN mix m
            ON m.zone_key = r.zone_key
           AND m.period_utc = r.period_utc
           AND m.source = r.source
         GROUP BY 1, 2
         ORDER BY 1, 2
    """


def _share(numerator: Decimal | None, denominator: Decimal | None) -> Decimal | None:
    """A share in [0, 1], or None where the answer is unknown.

    None whenever the denominator is missing, zero or negative — the same rule the
    hourly mapper applies. Zero generation is not a grid running 0% renewables; it is a
    grid we have no mix for.
    """
    if numerator is None or denominator is None or denominator <= 0:
        return None
    return numerator / denominator


def build_aggregates(
    connection: psycopg.Connection,
    resolution: str,
    start: datetime,
    end: datetime,
    config: AppConfig,
) -> dict[datetime, AggregateSnapshot]:
    """Every period of `resolution` between `start` and `end`, built in one pass.

    `end` is exclusive. Periods with no observation at all are absent rather than
    present and empty: an hour nobody reported is not the same as an hour of zeroes.
    """
    if resolution not in RESOLUTIONS:
        raise ValueError(f"resolution must be one of {RESOLUTIONS}, got {resolution!r}")

    in_map = [zone.key for zone in config.zones.in_map()]
    empty: list[float | None] = [None] * len(METRICS)

    with connection.cursor() as cursor:
        cursor.execute(
            _aggregate_query(config),
            {"unit": resolution, "start": start, "end": end, "keys": in_map},
        )
        rows = cursor.fetchall()

    periods: dict[datetime, AggregateSnapshot] = {}
    hours_seen: dict[datetime, int] = {}

    for row in rows:
        (
            bucket,
            zone_key,
            hours,
            demand_mean,
            demand_peak,
            generation_mean,
            generation_peak,
            interchange_mean,
            interchange_peak,
            renewable_mwh,
            low_carbon_mwh,
            counted_mwh,
            renewable_peak,
            low_carbon_peak,
        ) = row

        document = periods.get(bucket)
        if document is None:
            document = AggregateSnapshot(
                period=_iso(bucket),
                resolution=resolution,
                metrics=list(METRICS),
                statistics=list(STATISTICS),
                zones={},
                hours=0,
                built_at=_iso(datetime.now(tz=bucket.tzinfo)),
            )
            periods[bucket] = document

        document["zones"][zone_key] = {
            "mean": [
                _round(demand_mean, MW_PLACES),
                _round(generation_mean, MW_PLACES),
                _round(interchange_mean, MW_PLACES),
                _round(_share(renewable_mwh, counted_mwh), SHARE_PLACES),
                _round(_share(low_carbon_mwh, counted_mwh), SHARE_PLACES),
            ],
            "peak": [
                _round(demand_peak, MW_PLACES),
                _round(generation_peak, MW_PLACES),
                _round(interchange_peak, MW_PLACES),
                _round(renewable_peak, SHARE_PLACES),
                _round(low_carbon_peak, SHARE_PLACES),
            ],
        }
        hours_seen[bucket] = max(hours_seen.get(bucket, 0), hours)

    # Every in-map zone appears in every period that exists at all, so a consumer can
    # tell "no data" from "not a zone" without consulting the registry.
    for bucket, document in periods.items():
        document["hours"] = hours_seen.get(bucket, 0)
        for key in in_map:
            if key not in document["zones"]:
                document["zones"][key] = {"mean": list(empty), "peak": list(empty)}
        document["zones"] = dict(sorted(document["zones"].items()))

    return periods


def store_aggregates(
    connection: psycopg.Connection,
    resolution: str,
    periods: dict[datetime, AggregateSnapshot],
) -> int:
    """Write each period's document. Returns how many were written."""
    with connection.cursor() as cursor:
        for period, payload in sorted(periods.items()):
            cursor.execute(
                """
                INSERT INTO map_snapshot_agg (resolution, period_utc, payload, built_at)
                VALUES (%s, %s, %s, now())
                ON CONFLICT (resolution, period_utc) DO UPDATE
                   SET payload = EXCLUDED.payload, built_at = now()
                """,
                (resolution, period, Json(payload)),
            )
    return len(periods)


def aggregate_bytes(payload: AggregateSnapshot) -> bytes:
    """The serialised document, as stored and served."""
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def refresh_buckets_for(
    connection: psycopg.Connection,
    periods: set[datetime],
    config: AppConfig,
) -> int:
    """Rebuild every day, week and month bucket that `periods` falls inside.

    For the recurring jobs, which touch a handful of recent hours. A bucket is rebuilt
    from all of its hours, not patched with the new ones, so a revision that changes an
    old hour is reflected rather than averaged in twice.
    """
    if not periods:
        return 0

    built = 0
    for resolution in RESOLUTIONS:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT DISTINCT date_trunc(%s, unnest(%s::timestamptz[]))",
                (resolution, sorted(periods)),
            )
            buckets = [row[0] for row in cursor.fetchall()]

        for bucket in buckets:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT (%s::timestamptz + ('1 ' || %s)::interval)", (bucket, resolution)
                )
                row = cursor.fetchone()
            assert row is not None
            built += store_aggregates(
                connection,
                resolution,
                build_aggregates(connection, resolution, bucket, row[0], config),
            )
    return built
