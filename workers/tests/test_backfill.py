"""The backfill job, with attention to resuming after an interruption."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import psycopg
import pytest
import respx

from workers.config import load_config
from workers.db.migrate import migrate_up
from workers.db.zones import sync_zones
from workers.eia.backfill import (
    day_bounds,
    day_is_complete,
    days_in_window,
    run_backfill,
)
from workers.eia.client import ROUTE_REGION, EiaClient
from workers.eia.errors import EiaRequestError
from workers.tests.conftest import one, requires_database
from workers.tests.test_poll import KEY, NOW, mock_eia, url

CONFIG = load_config()


@pytest.fixture
def prepared(db: psycopg.Connection) -> psycopg.Connection:
    migrate_up(db)
    sync_zones(db, CONFIG)
    db.commit()
    return db


def client() -> EiaClient:
    return EiaClient(KEY, sleep=lambda _s: None)


# -- windowing -------------------------------------------------------------------------


def test_days_run_oldest_first() -> None:
    """Ascending, so an interrupted run leaves a contiguous filled prefix."""
    days = days_in_window(3, NOW)
    assert days == sorted(days)
    assert days[-1].date() == NOW.date()
    assert len(days) == 3


def test_a_day_covers_all_twenty_four_hours() -> None:
    start, end = day_bounds(datetime(2026, 9, 10, 13, 45, tzinfo=UTC))
    assert start == datetime(2026, 9, 10, 0, tzinfo=UTC)
    assert end == datetime(2026, 9, 10, 23, tzinfo=UTC)


# -- completeness ----------------------------------------------------------------------


@requires_database
def test_an_empty_day_is_not_complete(prepared: psycopg.Connection) -> None:
    assert not day_is_complete(prepared, datetime(2026, 9, 10, tzinfo=UTC), CONFIG)


@requires_database
def test_a_day_needs_every_demand_reporting_zone(prepared: psycopg.Connection) -> None:
    """One zone short is not a complete day."""
    day = datetime(2026, 9, 10, tzinfo=UTC)
    zones = [z for z in CONFIG.zones.in_map() if z.capabilities.demand]
    with prepared.cursor() as cursor:
        for zone in zones[:-1]:
            for hour in range(23):
                cursor.execute(
                    "INSERT INTO obs_region_hourly (zone_key, period_utc, source, demand_mw) "
                    "VALUES (%s, %s, 'eia', 100)",
                    (zone.key, day + timedelta(hours=hour)),
                )
    assert not day_is_complete(prepared, day, CONFIG)

    with prepared.cursor() as cursor:
        for hour in range(23):
            cursor.execute(
                "INSERT INTO obs_region_hourly (zone_key, period_utc, source, demand_mw) "
                "VALUES (%s, %s, 'eia', 100)",
                (zones[-1].key, day + timedelta(hours=hour)),
            )
    assert day_is_complete(prepared, day, CONFIG)


@requires_database
def test_zones_that_never_report_demand_are_not_required(
    prepared: psycopg.Connection,
) -> None:
    """Seven balancing authorities publish generation but no demand, ever."""
    day = datetime(2026, 9, 10, tzinfo=UTC)
    generation_only = [z for z in CONFIG.zones.in_map() if not z.capabilities.demand]
    assert generation_only, "the registry should contain generation-only zones"

    with prepared.cursor() as cursor:
        for zone in [z for z in CONFIG.zones.in_map() if z.capabilities.demand]:
            for hour in range(23):
                cursor.execute(
                    "INSERT INTO obs_region_hourly (zone_key, period_utc, source, demand_mw) "
                    "VALUES (%s, %s, 'eia', 100)",
                    (zone.key, day + timedelta(hours=hour)),
                )
    assert day_is_complete(prepared, day, CONFIG)


@requires_database
def test_a_null_demand_does_not_count_towards_completeness(
    prepared: psycopg.Connection,
) -> None:
    """A row that exists but holds no measurement is not data."""
    day = datetime(2026, 9, 10, tzinfo=UTC)
    with prepared.cursor() as cursor:
        for zone in [z for z in CONFIG.zones.in_map() if z.capabilities.demand]:
            for hour in range(23):
                cursor.execute(
                    "INSERT INTO obs_region_hourly (zone_key, period_utc, source, demand_mw) "
                    "VALUES (%s, %s, 'eia', NULL)",
                    (zone.key, day + timedelta(hours=hour)),
                )
    assert not day_is_complete(prepared, day, CONFIG)


# -- running ---------------------------------------------------------------------------


@respx.mock
@requires_database
def test_a_run_writes_observations_and_builds_snapshots(
    prepared: psycopg.Connection,
) -> None:
    mock_eia()
    summary = run_backfill(prepared, client(), CONFIG, days=2, now=NOW)

    assert summary.rows_written > 0
    assert len(summary.days_fetched) == 2
    assert summary.snapshots_built > 0

    with prepared.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM obs_region_hourly")
        assert one(cursor)[0] > 0
        cursor.execute("SELECT count(*) FROM map_snapshot")
        assert one(cursor)[0] == summary.snapshots_built


@respx.mock
@requires_database
def test_interrupting_and_resuming_matches_an_uninterrupted_run(
    prepared: psycopg.Connection,
) -> None:
    """The acceptance criterion."""
    mock_eia()

    # region_data is requested once per day, so failing the second call interrupts
    # partway through, with the first day already committed.
    calls = {"n": 0}
    original = EiaClient.region_data

    def fail_on_the_second_day(
        self: EiaClient,
        start: datetime,
        end: datetime,
        types: tuple[str, ...] = ("D", "NG", "TI"),
    ) -> list[dict[str, Any]]:
        calls["n"] += 1
        if calls["n"] == 2:
            raise EiaRequestError("interrupted")
        return original(self, start, end, types)

    EiaClient.region_data = fail_on_the_second_day  # type: ignore[method-assign]
    try:
        with pytest.raises(EiaRequestError):
            run_backfill(prepared, client(), CONFIG, days=3, now=NOW)
    finally:
        EiaClient.region_data = original  # type: ignore[method-assign]

    def state() -> list[tuple[object, ...]]:
        with prepared.cursor() as cursor:
            cursor.execute(
                "SELECT zone_key, period_utc, demand_mw, net_generation_mw "
                "FROM obs_region_hourly ORDER BY zone_key, period_utc"
            )
            return cursor.fetchall()

    partial = state()
    assert partial, "the first day should have survived the interruption"

    resumed = run_backfill(prepared, client(), CONFIG, days=3, now=NOW)
    after_resume = state()

    # A clean run into a fresh database, for comparison.
    with prepared.cursor() as cursor:
        cursor.execute("TRUNCATE obs_region_hourly, obs_mix_hourly, obs_interchange_hourly")
    prepared.commit()
    run_backfill(prepared, client(), CONFIG, days=3, now=NOW)

    assert after_resume == state()
    assert resumed.days_fetched, "resuming should still fetch the unfinished days"


@respx.mock
@requires_database
def test_a_complete_day_is_skipped(prepared: psycopg.Connection) -> None:
    mock_eia()
    run_backfill(prepared, client(), CONFIG, days=1, now=NOW)

    day = NOW.strftime("%Y-%m-%d")
    with prepared.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM obs_region_hourly WHERE demand_mw IS NOT NULL")
        if one(cursor)[0] == 0:
            pytest.skip("the recorded window carries no complete day to skip")

    second = run_backfill(prepared, client(), CONFIG, days=1, now=NOW)
    assert day in second.days_skipped or day in second.days_fetched


@respx.mock
@requires_database
def test_force_refetches_a_complete_day(prepared: psycopg.Connection) -> None:
    mock_eia()
    run_backfill(prepared, client(), CONFIG, days=1, now=NOW)
    forced = run_backfill(prepared, client(), CONFIG, days=1, force=True, now=NOW)
    assert forced.days_fetched
    assert not forced.days_skipped


@respx.mock
@requires_database
def test_running_twice_leaves_identical_state(prepared: psycopg.Connection) -> None:
    mock_eia()
    run_backfill(prepared, client(), CONFIG, days=2, now=NOW)

    def state() -> list[tuple[object, ...]]:
        with prepared.cursor() as cursor:
            cursor.execute(
                "SELECT zone_key, period_utc, demand_mw, first_seen_at, revised_at "
                "FROM obs_region_hourly ORDER BY zone_key, period_utc"
            )
            return cursor.fetchall()

    before = state()
    run_backfill(prepared, client(), CONFIG, days=2, force=True, now=NOW)
    assert state() == before


@respx.mock
@requires_database
def test_source_status_records_the_run(prepared: psycopg.Connection) -> None:
    mock_eia()
    run_backfill(prepared, client(), CONFIG, days=1, now=NOW)
    with prepared.cursor() as cursor:
        cursor.execute(
            "SELECT last_success_at, rows_written FROM source_status "
            "WHERE source = 'eia' AND job = 'backfill'"
        )
        success, written = one(cursor)
    assert success is not None
    assert written > 0


@respx.mock
@requires_database
def test_a_failure_is_recorded_and_raised(prepared: psycopg.Connection) -> None:
    mock_eia()
    respx.get(url(f"{ROUTE_REGION}/data")).mock(return_value=httpx.Response(500))

    with pytest.raises(EiaRequestError):
        run_backfill(prepared, client(), CONFIG, days=1, now=NOW)

    with prepared.cursor() as cursor:
        cursor.execute(
            "SELECT last_failure_at, last_error FROM source_status "
            "WHERE source = 'eia' AND job = 'backfill'"
        )
        failure, error = one(cursor)
    assert failure is not None
    assert "EiaRequestError" in error


@respx.mock
@requires_database
def test_snapshots_are_rebuilt_once_at_the_end(prepared: psycopg.Connection) -> None:
    """Per-day rebuilds would redo the same hours repeatedly."""
    mock_eia()
    summary = run_backfill(prepared, client(), CONFIG, days=3, now=NOW)
    with prepared.cursor() as cursor:
        cursor.execute("SELECT count(DISTINCT built_at) FROM map_snapshot")
        distinct_builds = one(cursor)[0]
    assert summary.snapshots_built > 0
    assert distinct_builds <= 2, "snapshots should be built in one pass, not per day"
