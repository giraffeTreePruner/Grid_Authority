"""The poll cycle, end to end, against recorded responses and a real database."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx
import psycopg
import pytest
import respx

from workers.config import load_config
from workers.db.migrate import migrate_up
from workers.db.zones import sync_zones
from workers.eia.client import (
    BASE_URL,
    ROUTE_FUEL_TYPE,
    ROUTE_INTERCHANGE,
    ROUTE_REGION,
    EiaClient,
)
from workers.eia.errors import EiaRequestError
from workers.eia.poll import observation_window, run_poll
from workers.tests.conftest import one, requires_database
from workers.tests.fixtures import load, rows

CONFIG = load_config()
KEY = "test-key-not-a-real-credential"

# The hour the recorded responses were captured against.
NOW = datetime(2026, 9, 12, 2, tzinfo=UTC)


@pytest.fixture
def prepared(db: psycopg.Connection) -> psycopg.Connection:
    """A migrated database with the registry synced, both committed.

    Committing matters: a failing poll rolls back, and an uncommitted schema would
    be rolled back with it. In production these are separate deploy steps.
    """
    migrate_up(db)
    sync_zones(db, CONFIG)
    db.commit()
    return db


@pytest.fixture
def client() -> EiaClient:
    return EiaClient(KEY, sleep=lambda _s: None)


def url(route: str) -> str:
    return f"{BASE_URL}{route}/"


def mock_eia(region: object = None, fuel: object = None, interchange: object = None) -> None:
    """Serve every endpoint a poll cycle touches from recorded fixtures."""
    for route, fixture in {
        f"{ROUTE_REGION}/facet/respondent": "facets/region-respondent.json",
        f"{ROUTE_REGION}/facet/type": "facets/region-type.json",
        f"{ROUTE_FUEL_TYPE}/facet/fueltype": "facets/fueltype.json",
        f"{ROUTE_INTERCHANGE}/facet/fromba": "facets/interchange-fromba.json",
        ROUTE_REGION: "routes/region-data.json",
        ROUTE_FUEL_TYPE: "routes/fuel-type-data.json",
        ROUTE_INTERCHANGE: "routes/interchange-data.json",
    }.items():
        respx.get(url(route)).mock(return_value=httpx.Response(200, json=load(fixture)))

    def region_response(request: httpx.Request) -> httpx.Response:
        wanted = request.url.params.get_list("facets[type][]")
        fixture = "poll/region-df.json" if wanted == ["DF"] else "poll/region-d-ng-ti.json"
        return httpx.Response(200, json=region or load(fixture))

    respx.get(url(f"{ROUTE_REGION}/data")).mock(side_effect=region_response)
    respx.get(url(f"{ROUTE_FUEL_TYPE}/data")).mock(
        return_value=httpx.Response(200, json=fuel or load("pagination/fuel-type-page-000.json"))
    )
    respx.get(url(f"{ROUTE_INTERCHANGE}/data")).mock(
        return_value=httpx.Response(200, json=interchange or load("poll/interchange.json"))
    )


# -- the adaptive window ---------------------------------------------------------------


def test_a_lagging_dataset_is_followed_down_to_its_data() -> None:
    """Interchange ran 42 hours behind; a now-12h window would return nothing."""
    latest = datetime(2026, 9, 10, 7, tzinfo=UTC)
    start, end = observation_window(latest, NOW)
    assert end == latest
    assert start == latest - timedelta(hours=12)


def test_a_current_dataset_is_not_asked_for_the_future() -> None:
    """region-data's endPeriod runs ahead of now because it includes the forecast."""
    latest = datetime(2026, 9, 12, 7, tzinfo=UTC)
    start, end = observation_window(latest, NOW)
    assert end == datetime(2026, 9, 12, 2, tzinfo=UTC)
    assert start == end - timedelta(hours=12)


# -- a cycle ---------------------------------------------------------------------------


@respx.mock
@requires_database
def test_a_cycle_writes_every_table(prepared: psycopg.Connection, client: EiaClient) -> None:
    mock_eia()
    summary = run_poll(prepared, client, CONFIG, NOW)

    assert summary.rows_written > 0
    assert summary.region.inserted > 0
    assert summary.mix.inserted > 0
    assert summary.interchange.inserted > 0
    assert summary.forecast_issues > 0

    with prepared.cursor() as cursor:
        for table in (
            "obs_region_hourly",
            "obs_mix_hourly",
            "obs_interchange_hourly",
            "forecast_issues",
        ):
            cursor.execute(f"SELECT count(*) FROM {table}")
            assert one(cursor)[0] > 0, f"{table} is empty"


@respx.mock
@requires_database
def test_running_twice_produces_identical_state(
    prepared: psycopg.Connection, client: EiaClient
) -> None:
    """The acceptance criterion. Only ingested_at may move."""
    mock_eia()
    run_poll(prepared, client, CONFIG, NOW)

    def snapshot() -> list[tuple[object, ...]]:
        with prepared.cursor() as cursor:
            cursor.execute(
                "SELECT zone_key, period_utc, source, demand_mw, net_generation_mw, "
                "total_interchange_mw, first_seen_at, revised_at "
                "FROM obs_region_hourly ORDER BY zone_key, period_utc"
            )
            return cursor.fetchall()

    before = snapshot()
    second = run_poll(prepared, EiaClient(KEY, sleep=lambda _s: None), CONFIG, NOW)

    assert second.region.inserted == 0
    assert second.region.revised == 0
    assert second.region.unchanged > 0
    assert snapshot() == before


@respx.mock
@requires_database
def test_no_row_is_marked_revised_on_a_repeat(
    prepared: psycopg.Connection, client: EiaClient
) -> None:
    """Re-ingesting the same number is not a revision."""
    mock_eia()
    run_poll(prepared, client, CONFIG, NOW)
    run_poll(prepared, EiaClient(KEY, sleep=lambda _s: None), CONFIG, NOW)

    with prepared.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM obs_region_hourly WHERE revised_at IS NOT NULL")
        assert one(cursor)[0] == 0


@respx.mock
@requires_database
def test_a_changed_value_is_marked_revised(prepared: psycopg.Connection, client: EiaClient) -> None:
    mock_eia()
    run_poll(prepared, client, CONFIG, NOW)

    with prepared.cursor() as cursor:
        cursor.execute(
            "SELECT zone_key, period_utc FROM obs_region_hourly "
            "WHERE demand_mw IS NOT NULL ORDER BY zone_key LIMIT 1"
        )
        zone_key, period = one(cursor)
        cursor.execute(
            "UPDATE obs_region_hourly SET demand_mw = demand_mw + 1 "
            "WHERE zone_key = %s AND period_utc = %s",
            (zone_key, period),
        )

    summary = run_poll(prepared, EiaClient(KEY, sleep=lambda _s: None), CONFIG, NOW)
    assert summary.region.revised == 1

    with prepared.cursor() as cursor:
        cursor.execute(
            "SELECT revised_at FROM obs_region_hourly WHERE zone_key = %s AND period_utc = %s",
            (zone_key, period),
        )
        assert one(cursor)[0] is not None


@respx.mock
@requires_database
def test_the_hour_in_progress_is_never_written(
    prepared: psycopg.Connection, client: EiaClient
) -> None:
    mock_eia()
    run_poll(prepared, client, CONFIG, NOW)
    with prepared.cursor() as cursor:
        cursor.execute("SELECT max(period_utc) FROM obs_region_hourly")
        assert one(cursor)[0] < NOW.replace(minute=0, second=0, microsecond=0)


@respx.mock
@requires_database
def test_shares_are_null_never_zero_where_unknown(
    prepared: psycopg.Connection, client: EiaClient
) -> None:
    mock_eia()
    run_poll(prepared, client, CONFIG, NOW)
    with prepared.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM obs_mix_hourly "
            "WHERE renewable_share = 0 AND total_generation_mw IS NULL"
        )
        assert one(cursor)[0] == 0
        cursor.execute("SELECT count(*) FROM obs_mix_hourly WHERE renewable_share IS NOT NULL")
        assert one(cursor)[0] > 0


@respx.mock
@requires_database
def test_source_status_records_success(prepared: psycopg.Connection, client: EiaClient) -> None:
    mock_eia()
    summary = run_poll(prepared, client, CONFIG, NOW)
    with prepared.cursor() as cursor:
        cursor.execute(
            "SELECT last_success_at, last_failure_at, rows_written, requests_made, "
            "data_latest_period FROM source_status WHERE source = 'eia' AND job = 'poll'"
        )
        success, failure, written, requests, latest = one(cursor)
    assert success is not None
    assert failure is None
    assert written == summary.rows_written
    assert requests == summary.requests
    assert latest is not None


@respx.mock
@requires_database
def test_source_status_records_failure_and_the_job_raises(
    prepared: psycopg.Connection, client: EiaClient
) -> None:
    """Silent partial success is the failure mode this project cannot tolerate."""
    mock_eia()
    respx.get(url(f"{ROUTE_FUEL_TYPE}/data")).mock(return_value=httpx.Response(500))

    with pytest.raises(EiaRequestError):
        run_poll(prepared, client, CONFIG, NOW)

    with prepared.cursor() as cursor:
        cursor.execute(
            "SELECT last_failure_at, last_success_at, last_error "
            "FROM source_status WHERE source = 'eia' AND job = 'poll'"
        )
        failure, success, error = one(cursor)
    assert failure is not None
    assert success is None
    assert "EiaRequestError" in error


@respx.mock
@requires_database
def test_a_failed_cycle_writes_no_observations(
    prepared: psycopg.Connection, client: EiaClient
) -> None:
    """A cycle that cannot finish must not leave a partial window behind."""
    mock_eia()
    respx.get(url(f"{ROUTE_INTERCHANGE}/data")).mock(return_value=httpx.Response(500))

    with pytest.raises(EiaRequestError):
        run_poll(prepared, client, CONFIG, NOW)

    with prepared.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM obs_region_hourly")
        assert one(cursor)[0] == 0


@respx.mock
@requires_database
def test_the_summary_is_one_line_of_json(prepared: psycopg.Connection, client: EiaClient) -> None:
    mock_eia()
    summary = run_poll(prepared, client, CONFIG, NOW)
    line = summary.as_json()
    assert "\n" not in line
    import json

    parsed = json.loads(line)
    assert set(parsed) == {"job", "rows_written", "requests", "duration_s", "warnings"}
    assert parsed["job"] == "poll"


@respx.mock
@requires_database
def test_a_lagging_dataset_is_warned_about(prepared: psycopg.Connection, client: EiaClient) -> None:
    mock_eia()
    summary = run_poll(prepared, client, CONFIG, NOW)
    assert any("behind" in w for w in summary.warnings)


@respx.mock
@requires_database
def test_values_land_with_the_precision_they_were_published_at(
    prepared: psycopg.Connection, client: EiaClient
) -> None:
    mock_eia()
    run_poll(prepared, client, CONFIG, NOW)

    published = {
        (r["respondent"], r["period"]): Decimal(r["value"])
        for r in rows("poll/region-d-ng-ti.json")
        if r["type"] == "D" and r.get("value") is not None
    }
    zone = CONFIG.zones.by_respondent("ERCO")
    assert zone is not None
    with prepared.cursor() as cursor:
        cursor.execute(
            "SELECT period_utc, demand_mw FROM obs_region_hourly "
            "WHERE zone_key = %s AND demand_mw IS NOT NULL ORDER BY period_utc",
            (zone.key,),
        )
        stored = cursor.fetchall()

    assert stored
    for period, value in stored:
        expected = published[("ERCO", period.strftime("%Y-%m-%dT%H"))]
        assert value == expected
