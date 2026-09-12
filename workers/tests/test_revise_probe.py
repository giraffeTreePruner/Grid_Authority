"""The revision sweep and the publication-lag probe."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import psycopg
import pytest
import respx

from workers.config import load_config
from workers.db.migrate import migrate_up
from workers.db.zones import sync_zones
from workers.eia.client import ROUTE_FUEL_TYPE, ROUTE_REGION, EiaClient
from workers.eia.errors import EiaRequestError
from workers.eia.poll import run_poll
from workers.eia.probe import run_probe
from workers.eia.revise import run_revise
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


# -- revise ----------------------------------------------------------------------------


@respx.mock
@requires_database
def test_a_sweep_over_unchanged_data_reports_nothing_changed(
    prepared: psycopg.Connection,
) -> None:
    """The measurement only means something if a no-op sweep counts zero."""
    mock_eia()
    run_poll(prepared, client(), CONFIG, NOW)

    summary = run_revise(prepared, client(), CONFIG, now=NOW)

    assert summary.changed_rows == 0
    assert summary.region.revised == 0
    with prepared.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM obs_region_hourly WHERE revised_at IS NOT NULL")
        assert one(cursor)[0] == 0


@respx.mock
@requires_database
def test_a_sweep_counts_and_dates_genuine_changes(prepared: psycopg.Connection) -> None:
    mock_eia()
    run_poll(prepared, client(), CONFIG, NOW)

    with prepared.cursor() as cursor:
        cursor.execute(
            "UPDATE obs_region_hourly SET demand_mw = demand_mw + 5 "
            "WHERE demand_mw IS NOT NULL AND zone_key IN ("
            "  SELECT zone_key FROM obs_region_hourly WHERE demand_mw IS NOT NULL LIMIT 2)"
        )
        touched = cursor.rowcount
    prepared.commit()
    assert touched > 0

    summary = run_revise(prepared, client(), CONFIG, now=NOW)

    assert summary.changed_rows == touched
    with prepared.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM obs_region_hourly WHERE revised_at IS NOT NULL")
        assert one(cursor)[0] == touched


@respx.mock
@requires_database
def test_a_sweep_restores_the_published_value(prepared: psycopg.Connection) -> None:
    mock_eia()
    run_poll(prepared, client(), CONFIG, NOW)

    with prepared.cursor() as cursor:
        cursor.execute(
            "SELECT zone_key, period_utc, demand_mw FROM obs_region_hourly "
            "WHERE demand_mw IS NOT NULL ORDER BY zone_key LIMIT 1"
        )
        zone, period, original = one(cursor)
        cursor.execute(
            "UPDATE obs_region_hourly SET demand_mw = 1 WHERE zone_key = %s AND period_utc = %s",
            (zone, period),
        )
    prepared.commit()

    run_revise(prepared, client(), CONFIG, now=NOW)

    with prepared.cursor() as cursor:
        cursor.execute(
            "SELECT demand_mw FROM obs_region_hourly WHERE zone_key = %s AND period_utc = %s",
            (zone, period),
        )
        assert one(cursor)[0] == original


@respx.mock
@requires_database
def test_only_changed_hours_get_a_new_snapshot(prepared: psycopg.Connection) -> None:
    """Rebuilding a week of hours every night would be wasted work."""
    mock_eia()
    run_poll(prepared, client(), CONFIG, NOW)
    summary = run_revise(prepared, client(), CONFIG, now=NOW)
    assert summary.snapshots_built == 0


@respx.mock
@requires_database
def test_the_summary_reports_changed_rows(prepared: psycopg.Connection) -> None:
    mock_eia()
    run_poll(prepared, client(), CONFIG, NOW)
    import json

    parsed = json.loads(run_revise(prepared, client(), CONFIG, now=NOW).as_json())
    assert parsed["job"] == "revise"
    assert "changed_rows" in parsed


@respx.mock
@requires_database
def test_a_failed_sweep_is_recorded_and_raised(prepared: psycopg.Connection) -> None:
    mock_eia()
    respx.get(url(f"{ROUTE_REGION}/data")).mock(return_value=httpx.Response(500))
    with pytest.raises(EiaRequestError):
        run_revise(prepared, client(), CONFIG, now=NOW)
    with prepared.cursor() as cursor:
        cursor.execute(
            "SELECT last_failure_at FROM source_status WHERE source='eia' AND job='revise'"
        )
        assert one(cursor)[0] is not None


# -- probe -----------------------------------------------------------------------------


@respx.mock
@requires_database
def test_the_probe_records_one_reading_per_dataset(prepared: psycopg.Connection) -> None:
    mock_eia()
    summary = run_probe(prepared, client(), NOW)

    assert len(summary.readings) == 3
    with prepared.cursor() as cursor:
        cursor.execute("SELECT count(DISTINCT dataset) FROM probe_log")
        assert one(cursor)[0] == 3


@respx.mock
@requires_database
def test_the_probe_measures_the_lag_that_was_recorded(
    prepared: psycopg.Connection,
) -> None:
    """Interchange was 42 hours behind at the capture hour; that is what it should say."""
    mock_eia()
    run_probe(prepared, client(), datetime(2026, 9, 12, 1, tzinfo=UTC))

    with prepared.cursor() as cursor:
        cursor.execute(
            "SELECT lag_minutes, latest_period FROM probe_log WHERE dataset = 'interchange-data'"
        )
        lag, latest = one(cursor)
    assert lag == 42 * 60
    assert latest == datetime(2026, 9, 10, 7, tzinfo=UTC)


@respx.mock
@requires_database
def test_a_dataset_ahead_of_now_reports_no_lag(prepared: psycopg.Connection) -> None:
    """region-data's endPeriod runs ahead because it contains the forecast."""
    mock_eia()
    run_probe(prepared, client(), datetime(2026, 9, 12, 1, tzinfo=UTC))
    with prepared.cursor() as cursor:
        cursor.execute("SELECT lag_minutes FROM probe_log WHERE dataset = 'region-data'")
        assert one(cursor)[0] == 0


@respx.mock
@requires_database
def test_the_probe_costs_one_request_per_dataset(prepared: psycopg.Connection) -> None:
    """Route metadata carries endPeriod, so no rows need transferring to measure lag."""
    mock_eia()
    probe_client = client()
    run_probe(prepared, probe_client, NOW)
    assert probe_client.requests_made == 3


@respx.mock
@requires_database
def test_readings_accumulate_over_time(prepared: psycopg.Connection) -> None:
    """A week of these is what lets /sources report observed rather than assumed lag."""
    mock_eia()
    run_probe(prepared, client(), NOW)
    run_probe(prepared, client(), NOW + timedelta(hours=1))
    with prepared.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM probe_log")
        assert one(cursor)[0] == 6


@respx.mock
@requires_database
def test_a_failed_probe_is_recorded_and_raised(prepared: psycopg.Connection) -> None:
    mock_eia()
    respx.get(url(ROUTE_FUEL_TYPE)).mock(return_value=httpx.Response(500))
    with pytest.raises(EiaRequestError):
        run_probe(prepared, client(), NOW)
    with prepared.cursor() as cursor:
        cursor.execute(
            "SELECT last_failure_at FROM source_status WHERE source='eia' AND job='probe'"
        )
        assert one(cursor)[0] is not None


@respx.mock
@requires_database
def test_the_probe_records_status_on_success(prepared: psycopg.Connection) -> None:
    mock_eia()
    run_probe(prepared, client(), NOW)
    with prepared.cursor() as cursor:
        cursor.execute(
            "SELECT last_success_at, data_latest_period FROM source_status "
            "WHERE source='eia' AND job='probe'"
        )
        success, latest = one(cursor)
    assert success is not None
    assert latest is not None
