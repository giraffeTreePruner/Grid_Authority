"""Recomputing the stored mix shares.

`renewable_share` and `low_carbon_share` are derived on write, so a change to how they
are derived leaves every existing row saying the old thing. This recomputes them in
place from the mode columns already stored — no EIA requests, and no re-ingest.

The SQL is built from `modes.yaml`, the same source `compute_shares` reads, so the two
cannot drift into computing different numbers. It mirrors that function exactly: named
storage and imports are excluded outright, every remaining mode is clamped at zero
because a negative value is consumption rather than generation, and a share is null
where the denominator is missing or not positive.
"""

from __future__ import annotations

import psycopg

from workers.config import AppConfig


def _sum_of(modes: list[str]) -> str:
    """A SQL sum over the mode columns, each clamped at zero."""
    if not modes:
        return "0"
    return " + ".join(f"greatest(coalesce({mode}_mw, 0), 0)" for mode in sorted(modes))


def recompute_shares(connection: psycopg.Connection, config: AppConfig) -> int:
    """Rewrite both shares wherever the stored value disagrees. Returns rows changed."""
    counted = [
        mode
        for mode in config.modes.canonical_modes
        if mode not in config.modes.excluded_from_mix_percent
    ]
    denominator = _sum_of(counted)
    renewable = _sum_of([m for m in config.modes.renewable if m in counted])
    low_carbon = _sum_of([m for m in config.modes.low_carbon if m in counted])

    statement = f"""
        WITH recomputed AS (
            SELECT zone_key, period_utc, source,
                   CASE WHEN ({denominator}) > 0
                        THEN round((({renewable}) / ({denominator}))::numeric, 4)
                   END AS renewable,
                   CASE WHEN ({denominator}) > 0
                        THEN round((({low_carbon}) / ({denominator}))::numeric, 4)
                   END AS low_carbon
              FROM obs_mix_hourly
        )
        UPDATE obs_mix_hourly m
           SET renewable_share = r.renewable,
               low_carbon_share = r.low_carbon
          FROM recomputed r
         WHERE m.zone_key = r.zone_key
           AND m.period_utc = r.period_utc
           AND m.source = r.source
           AND (m.renewable_share IS DISTINCT FROM r.renewable
                OR m.low_carbon_share IS DISTINCT FROM r.low_carbon)
    """

    with connection.cursor() as cursor:
        cursor.execute(statement)
        return cursor.rowcount
