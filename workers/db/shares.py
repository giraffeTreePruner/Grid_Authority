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

from collections.abc import Callable
from datetime import UTC, datetime

import psycopg

from workers.config import AppConfig


def _sum_of(modes: list[str]) -> str:
    """A SQL sum over the mode columns, each clamped at zero."""
    if not modes:
        return "0"
    return " + ".join(f"greatest(coalesce({mode}_mw, 0), 0)" for mode in sorted(modes))


def recompute_shares(
    connection: psycopg.Connection,
    config: AppConfig,
    *,
    on_progress: Callable[[str, int], None] | None = None,
) -> int:
    """Rewrite both shares wherever the stored value disagrees. Returns rows changed.

    A plain UPDATE with the expression inline, batched a year at a time.

    The first version joined a CTE of every row back to the table it came from. That
    reads well and is the wrong shape: a four-million-row hash join against a
    four-million-row table, on a host with 2 GB of memory and a 4 MB work_mem, spills to
    disk and makes no visible progress for as long as anyone is willing to wait. There
    is no need for a join — every value the new share depends on is in the row being
    updated.

    Batching by year keeps each transaction small, so WAL does not balloon, progress is
    visible, and an interrupt costs one year rather than all seven.
    """
    counted = [
        mode
        for mode in config.modes.canonical_modes
        if mode not in config.modes.excluded_from_mix_percent
    ]
    denominator = _sum_of(counted)
    renewable = _sum_of([m for m in config.modes.renewable if m in counted])
    low_carbon = _sum_of([m for m in config.modes.low_carbon if m in counted])

    share = (
        f"CASE WHEN ({denominator}) > 0 THEN round((({{part}}) / ({denominator}))::numeric, 4) END"
    )
    renewable_expr = share.format(part=renewable)
    low_carbon_expr = share.format(part=low_carbon)

    statement = f"""
        UPDATE obs_mix_hourly
           SET renewable_share = {renewable_expr},
               low_carbon_share = {low_carbon_expr}
         WHERE period_utc >= %(start)s
           AND period_utc < %(end)s
           AND (renewable_share IS DISTINCT FROM ({renewable_expr})
                OR low_carbon_share IS DISTINCT FROM ({low_carbon_expr}))
    """

    with connection.cursor() as cursor:
        cursor.execute("SELECT min(period_utc), max(period_utc) FROM obs_mix_hourly")
        row = cursor.fetchone()
    if row is None or row[0] is None:
        return 0

    first: datetime = row[0]
    last: datetime = row[1]

    total = 0
    year = datetime(first.year, 1, 1, tzinfo=UTC)
    while year <= last:
        following = datetime(year.year + 1, 1, 1, tzinfo=UTC)
        with connection.cursor() as cursor:
            cursor.execute(statement, {"start": year, "end": following})
            changed = cursor.rowcount
        # Committed per year, so an interrupt keeps what is already correct.
        connection.commit()
        total += changed
        if on_progress is not None:
            on_progress(str(year.year), changed)
        year = following

    return total
