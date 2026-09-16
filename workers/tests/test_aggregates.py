"""Day, week and month snapshots.

The arithmetic here is the whole point: a coarse period is not a snapshot with a
different label, it is a summary, and a summary computed the obvious way is wrong.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import psycopg
import pytest

from workers.config import load_config
from workers.db.aggregates import (
    RESOLUTIONS,
    batch_ranges,
    build_aggregates,
    refresh_buckets_for,
    store_aggregates,
)
from workers.db.migrate import migrate_up
from workers.db.snapshots import METRICS
from workers.db.zones import sync_zones
from workers.tests.conftest import one, requires_database

CONFIG = load_config()

# A Wednesday, so the week bucket is visibly not the day bucket.
DAY = datetime(2026, 9, 9, tzinfo=UTC)
NEXT_DAY = DAY + timedelta(days=1)


@pytest.fixture
def prepared(db: psycopg.Connection) -> psycopg.Connection:
    migrate_up(db)
    sync_zones(db, CONFIG)
    db.commit()
    return db


def zones(count: int = 2) -> list[str]:
    return [zone.key for zone in CONFIG.zones.in_map()[:count]]


def insert_region(
    connection: psycopg.Connection,
    zone: str,
    hour: int,
    demand: str | None = None,
    generation: str | None = None,
    interchange: str | None = None,
    day: datetime = DAY,
) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO obs_region_hourly (zone_key, period_utc, source, demand_mw, "
            "net_generation_mw, total_interchange_mw) VALUES (%s, %s, 'eia', %s, %s, %s)",
            (zone, day + timedelta(hours=hour), demand, generation, interchange),
        )


def insert_mix(
    connection: psycopg.Connection,
    zone: str,
    hour: int,
    *,
    wind: str,
    gas: str,
    day: datetime = DAY,
) -> None:
    """One wind and one gas hour, which is enough to make a share mean something."""
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO obs_mix_hourly (zone_key, period_utc, source, wind_mw, gas_mw, "
            "total_generation_mw) VALUES (%s, %s, 'eia', %s, %s, %s)",
            (zone, day + timedelta(hours=hour), wind, gas, str(float(wind) + float(gas))),
        )


def one_day(connection: psycopg.Connection) -> dict[str, dict[str, list[float | None]]]:
    periods = build_aggregates(connection, "day", DAY, NEXT_DAY, CONFIG)
    return periods[DAY]["zones"]


# -- shape -----------------------------------------------------------------------------


@requires_database
def test_the_document_carries_both_statistics(prepared: psycopg.Connection) -> None:
    zone = zones(1)[0]
    insert_region(prepared, zone, 0, demand="100")
    insert_region(prepared, zone, 1, demand="300")

    document = build_aggregates(prepared, "day", DAY, NEXT_DAY, CONFIG)[DAY]

    assert document["period"] == "2026-09-09T00:00:00Z"
    assert document["resolution"] == "day"
    assert document["metrics"] == list(METRICS)
    assert document["statistics"] == ["mean", "peak"]
    assert document["zones"][zone]["mean"][0] == 200.0
    assert document["zones"][zone]["peak"][0] == 300.0


@requires_database
def test_a_zone_with_no_data_is_null_in_both_statistics(prepared: psycopg.Connection) -> None:
    """Missing must not become zero at a coarser resolution either."""
    reporting, silent = zones(2)
    insert_region(prepared, reporting, 0, demand="100")

    document = one_day(prepared)

    assert document[silent]["mean"] == [None] * len(METRICS)
    assert document[silent]["peak"] == [None] * len(METRICS)


@requires_database
def test_a_period_nobody_reported_is_absent(prepared: psycopg.Connection) -> None:
    """Not present-and-empty: an unreported day is not a day of zeroes."""
    assert build_aggregates(prepared, "day", DAY, NEXT_DAY, CONFIG) == {}


# -- the arithmetic --------------------------------------------------------------------


@requires_database
def test_a_share_is_weighted_by_generation_not_averaged(prepared: psycopg.Connection) -> None:
    """The reason this module exists.

    Two hours: a quiet one that is entirely wind, and a working one that is almost all
    gas. Averaging the two hourly percentages gives 52.5%; the honest figure, energy
    over energy, is 6.9%. The mean of ratios lets a 100 MW hour outvote a 4,000 MW one.
    """
    zone = zones(1)[0]
    insert_mix(prepared, zone, 0, wind="100", gas="0")  # 100% of 100 MW
    insert_mix(prepared, zone, 1, wind="200", gas="3800")  # 5% of 4,000 MW

    mean_share = one_day(prepared)[zone]["mean"][METRICS.index("renewable_share")]

    # 300 / 4100
    assert mean_share == pytest.approx(0.073, abs=0.0005)
    # And emphatically not the mean of 1.00 and 0.05.
    assert mean_share is not None and mean_share < 0.2


@requires_database
def test_the_peak_share_is_the_best_hour(prepared: psycopg.Connection) -> None:
    """Unlike the mean, a peak share is a real hour and is taken as measured."""
    zone = zones(1)[0]
    with prepared.cursor() as cursor:
        for hour, share in ((0, "0.9000"), (1, "0.1000")):
            cursor.execute(
                "INSERT INTO obs_mix_hourly (zone_key, period_utc, source, renewable_share) "
                "VALUES (%s, %s, 'eia', %s)",
                (zone, DAY + timedelta(hours=hour), share),
            )

    assert one_day(prepared)[zone]["peak"][METRICS.index("renewable_share")] == 0.9


@requires_database
def test_the_interchange_peak_keeps_its_sign(prepared: psycopg.Connection) -> None:
    """Interchange is signed, so the biggest hour is the one furthest from zero.

    max() would report -200 as a peak of 100 and describe a heavy exporter as a light
    importer.
    """
    zone = zones(1)[0]
    insert_region(prepared, zone, 0, interchange="100")
    insert_region(prepared, zone, 1, interchange="-900")

    assert one_day(prepared)[zone]["peak"][METRICS.index("net_interchange_mw")] == -900.0


@requires_database
def test_a_share_with_no_generation_is_null_not_zero(prepared: psycopg.Connection) -> None:
    """Zero generation is a grid we have no mix for, not a grid running no renewables."""
    zone = zones(1)[0]
    insert_mix(prepared, zone, 0, wind="0", gas="0")

    assert one_day(prepared)[zone]["mean"][METRICS.index("renewable_share")] is None


@requires_database
def test_hours_that_did_not_report_do_not_drag_the_mean_down(
    prepared: psycopg.Connection,
) -> None:
    """A mean over reported hours, not over the calendar.

    Three hours of 300 MW in a day is a mean of 300, not 300 * 3 / 24.
    """
    zone = zones(1)[0]
    for hour in range(3):
        insert_region(prepared, zone, hour, demand="300")

    assert one_day(prepared)[zone]["mean"][0] == 300.0


# -- resolutions -----------------------------------------------------------------------


@requires_database
def test_each_resolution_aligns_to_its_own_boundary(prepared: psycopg.Connection) -> None:
    zone = zones(1)[0]
    insert_region(prepared, zone, 12, demand="100")

    for resolution, expected in (
        ("day", "2026-09-09T00:00:00Z"),
        ("week", "2026-09-07T00:00:00Z"),  # the Monday
        ("month", "2026-09-01T00:00:00Z"),
    ):
        periods = build_aggregates(prepared, resolution, DAY, NEXT_DAY, CONFIG)
        assert [document["period"] for document in periods.values()] == [expected]


@requires_database
def test_an_unknown_resolution_is_refused(prepared: psycopg.Connection) -> None:
    with pytest.raises(ValueError, match="resolution must be one of"):
        build_aggregates(prepared, "fortnight", DAY, NEXT_DAY, CONFIG)


@requires_database
def test_a_week_spans_its_days(prepared: psycopg.Connection) -> None:
    """The week's mean is over all its hours, not the mean of its daily means."""
    zone = zones(1)[0]
    insert_region(prepared, zone, 0, demand="100")
    insert_region(prepared, zone, 0, demand="300", day=DAY + timedelta(days=1))

    week = build_aggregates(prepared, "week", DAY, DAY + timedelta(days=2), CONFIG)
    assert len(week) == 1
    assert next(iter(week.values()))["zones"][zone]["mean"][0] == 200.0


# -- storage ---------------------------------------------------------------------------


@requires_database
def test_storing_is_idempotent(prepared: psycopg.Connection) -> None:
    zone = zones(1)[0]
    insert_region(prepared, zone, 0, demand="100")
    periods = build_aggregates(prepared, "day", DAY, NEXT_DAY, CONFIG)

    store_aggregates(prepared, "day", periods)
    store_aggregates(prepared, "day", periods)

    with prepared.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM map_snapshot_agg WHERE resolution = 'day'")
        assert one(cursor)[0] == 1


@requires_database
def test_refreshing_a_bucket_covers_every_resolution(prepared: psycopg.Connection) -> None:
    zone = zones(1)[0]
    insert_region(prepared, zone, 5, demand="100")

    built = refresh_buckets_for(prepared, {DAY + timedelta(hours=5)}, CONFIG)

    assert built == len(RESOLUTIONS)
    with prepared.cursor() as cursor:
        cursor.execute("SELECT DISTINCT resolution FROM map_snapshot_agg ORDER BY 1")
        assert [row[0] for row in cursor.fetchall()] == sorted(RESOLUTIONS)


@requires_database
def test_a_refresh_rebuilds_the_whole_bucket_not_just_the_new_hour(
    prepared: psycopg.Connection,
) -> None:
    """A revision to one hour must not be averaged into a bucket twice."""
    zone = zones(1)[0]
    insert_region(prepared, zone, 0, demand="100")
    refresh_buckets_for(prepared, {DAY}, CONFIG)

    insert_region(prepared, zone, 1, demand="300")
    refresh_buckets_for(prepared, {DAY + timedelta(hours=1)}, CONFIG)

    with prepared.cursor() as cursor:
        cursor.execute(
            "SELECT payload FROM map_snapshot_agg WHERE resolution = 'day' AND period_utc = %s",
            (DAY,),
        )
        payload = one(cursor)[0]
    assert payload["zones"][zone]["mean"][0] == 200.0


# -- batching ---------------------------------------------------------------------------


@requires_database
def test_a_week_across_the_new_year_is_built_whole(prepared: psycopg.Connection) -> None:
    """The bug this batching was written with, and then fixed.

    A week straddles 1 January. Batched on the calendar year it is built twice — the
    December days in one batch, the January days in the next — and the second write
    overwrites the first, leaving a week that reports four days as though they were
    seven. Nothing about the result looks wrong.
    """
    zone = CONFIG.zones.in_map()[0].key
    # Mon 29 Dec 2025 starts the week; the year splits it after three days.
    december = datetime(2025, 12, 30, tzinfo=UTC)
    january = datetime(2026, 1, 1, tzinfo=UTC)

    with prepared.cursor() as cursor:
        for day, value in ((december, "100"), (january, "300")):
            cursor.execute(
                "INSERT INTO obs_region_hourly (zone_key, period_utc, source, demand_mw) "
                "VALUES (%s, %s, 'eia', %s)",
                (zone, day, value),
            )

    start, end = datetime(2025, 1, 1, tzinfo=UTC), datetime(2026, 12, 31, tzinfo=UTC)
    for batch_start, batch_end in batch_ranges(prepared, "week", start, end):
        store_aggregates(
            prepared, "week", build_aggregates(prepared, "week", batch_start, batch_end, CONFIG)
        )

    with prepared.cursor() as cursor:
        cursor.execute(
            "SELECT payload FROM map_snapshot_agg "
            " WHERE resolution = 'week' AND period_utc = date_trunc('week', %s::timestamptz)",
            (december,),
        )
        payload = one(cursor)[0]

    # Both days, so a mean of 200. Split batches would report 300 — January alone.
    assert payload["zones"][zone]["mean"][0] == 200.0


@requires_database
def test_batches_start_where_a_bucket_starts(prepared: psycopg.Connection) -> None:
    """Every batch edge is a bucket edge, so no bucket spans two batches."""
    start, end = datetime(2019, 1, 1, tzinfo=UTC), datetime(2026, 9, 16, tzinfo=UTC)

    for resolution in RESOLUTIONS:
        ranges = batch_ranges(prepared, resolution, start, end)
        assert ranges, resolution

        with prepared.cursor() as cursor:
            for batch_start, _batch_end in ranges:
                cursor.execute(
                    "SELECT date_trunc(%s, %s::timestamptz) = %s",
                    (resolution, batch_start, batch_start),
                )
                assert one(cursor)[0] is True, f"{resolution} batch cuts a bucket"

        # Contiguous: each batch begins where the last ended, so nothing is skipped.
        for (_, previous_end), (next_start, _) in zip(ranges, ranges[1:], strict=False):
            assert previous_end == next_start, resolution
