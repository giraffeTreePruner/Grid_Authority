"""Forecast vintages.

This is the one table whose history cannot be reconstructed later. Once EIA replaces a
day-ahead forecast with a revision, the original is gone from the API, so capturing
each vintage as it is published is the only way to know what was forecast at the time.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import psycopg
import pytest
import respx

from workers.config import load_config
from workers.db.migrate import migrate_up
from workers.db.observations import write_forecast_issues
from workers.db.zones import sync_zones
from workers.eia.client import EiaClient
from workers.eia.mappers import ForecastIssue, map_forecast_rows
from workers.eia.poll import run_poll
from workers.tests.conftest import one, requires_database
from workers.tests.fixtures import rows
from workers.tests.test_poll import KEY, NOW, mock_eia

CONFIG = load_config()


@pytest.fixture
def prepared(db: psycopg.Connection) -> psycopg.Connection:
    migrate_up(db)
    sync_zones(db, CONFIG)
    db.commit()
    return db


def issue(zone: str, issued: datetime, target: datetime, value: str) -> ForecastIssue:
    from decimal import Decimal

    return ForecastIssue(
        zone_key=zone, issue_time_utc=issued, target_time_utc=target, value=Decimal(value)
    )


# -- horizon -------------------------------------------------------------------------


@requires_database
def test_horizon_is_derived_from_the_timestamps(prepared: psycopg.Connection) -> None:
    """A stored horizon could disagree with its own timestamps; a derived one cannot."""
    zone = CONFIG.zones.in_map()[0].key
    issued = datetime(2026, 9, 11, 12, tzinfo=UTC)
    write_forecast_issues(
        prepared,
        [issue(zone, issued, issued + timedelta(hours=h), "1000") for h in (1, 24, 26, 48)],
    )
    with prepared.cursor() as cursor:
        cursor.execute("SELECT horizon_h FROM forecast_issues ORDER BY horizon_h")
        assert [r[0] for r in cursor.fetchall()] == [1, 24, 26, 48]


@requires_database
def test_a_horizon_rounds_to_the_nearest_hour(prepared: psycopg.Connection) -> None:
    """Issue times are cycle starts, not hour boundaries, so horizons are fractional.

    Postgres rounds on the cast to integer rather than truncating. A forecast issued
    at 12:10 for 13:00 is fifty minutes out, which is nearer one hour than zero.
    """
    zone = CONFIG.zones.in_map()[0].key
    issued = datetime(2026, 9, 11, 12, 10, tzinfo=UTC)
    write_forecast_issues(
        prepared, [issue(zone, issued, datetime(2026, 9, 11, 13, tzinfo=UTC), "1000")]
    )
    with prepared.cursor() as cursor:
        cursor.execute("SELECT horizon_h FROM forecast_issues")
        assert one(cursor)[0] == 1


# -- vintages ------------------------------------------------------------------------


@respx.mock
@requires_database
def test_two_cycles_produce_two_vintages_for_the_same_target(
    prepared: psycopg.Connection,
) -> None:
    """The acceptance criterion: overlapping target hours, distinct issue times."""
    mock_eia()

    first_cycle = NOW
    second_cycle = NOW + timedelta(minutes=30)
    run_poll(prepared, EiaClient(KEY, sleep=lambda _s: None), CONFIG, first_cycle)
    run_poll(prepared, EiaClient(KEY, sleep=lambda _s: None), CONFIG, second_cycle)

    with prepared.cursor() as cursor:
        cursor.execute("SELECT count(DISTINCT issue_time_utc) FROM forecast_issues")
        assert one(cursor)[0] == 2

        cursor.execute(
            """
            SELECT zone_key, target_time_utc, count(*) AS vintages
              FROM forecast_issues
             GROUP BY zone_key, target_time_utc
            HAVING count(*) > 1
             LIMIT 1
            """
        )
        overlapping = one(cursor)
    assert overlapping[2] == 2, "the same target hour should carry both vintages"


@respx.mock
@requires_database
def test_the_same_cycle_twice_adds_nothing(prepared: psycopg.Connection) -> None:
    """Append-only, but the unique constraint absorbs a repeat."""
    mock_eia()
    run_poll(prepared, EiaClient(KEY, sleep=lambda _s: None), CONFIG, NOW)
    with prepared.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM forecast_issues")
        after_first = one(cursor)[0]

    summary = run_poll(prepared, EiaClient(KEY, sleep=lambda _s: None), CONFIG, NOW)
    assert summary.forecast_issues == 0

    with prepared.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM forecast_issues")
        assert one(cursor)[0] == after_first


@requires_database
def test_a_vintage_is_never_overwritten(prepared: psycopg.Connection) -> None:
    """Append-only: the first value observed at an issue time stands."""
    zone = CONFIG.zones.in_map()[0].key
    issued = datetime(2026, 9, 11, 12, tzinfo=UTC)
    target = datetime(2026, 9, 12, 18, tzinfo=UTC)

    write_forecast_issues(prepared, [issue(zone, issued, target, "70000")])
    written = write_forecast_issues(prepared, [issue(zone, issued, target, "99999")])

    assert written == 0
    with prepared.cursor() as cursor:
        cursor.execute("SELECT value, count(*) OVER () FROM forecast_issues")
        value, count = one(cursor)
    assert count == 1
    assert value == 70000


@respx.mock
@requires_database
def test_vintages_cover_hours_that_have_not_happened(prepared: psycopg.Connection) -> None:
    """A forecast is worthless if only past hours are captured."""
    mock_eia()
    run_poll(prepared, EiaClient(KEY, sleep=lambda _s: None), CONFIG, NOW)
    with prepared.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM forecast_issues WHERE target_time_utc > %s", (NOW,))
        assert one(cursor)[0] > 0


@respx.mock
@requires_database
def test_forecasts_never_reach_the_observation_tables(prepared: psycopg.Connection) -> None:
    """DF is a vintage, not a measurement."""
    mock_eia()
    run_poll(prepared, EiaClient(KEY, sleep=lambda _s: None), CONFIG, NOW)
    with prepared.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM obs_region_hourly WHERE period_utc > %s", (NOW,))
        assert one(cursor)[0] == 0


def test_the_published_forecast_horizon_is_short() -> None:
    """Recorded behaviour, and a constraint on what task 15 can show.

    The capture asked for 48 hours ahead. EIA returned targets reaching only
    2026-09-12T07, six hours past the 2026-09-12T01 capture hour. A selection rule
    that wants an issue at or before `target - 24h` will find nothing at this horizon,
    so the rule and the data have to be reconciled rather than assumed compatible.
    """
    captured_hour = datetime(2026, 9, 12, 1, tzinfo=UTC)
    targets = sorted(
        m.target_time_utc
        for m in map_forecast_rows(rows("poll/region-df.json"), CONFIG, captured_hour)
    )
    ahead = (targets[-1] - captured_hour).total_seconds() / 3600
    assert ahead == 6.0, "if this changes, the forecast selection rule can be revisited"
    assert targets[-1] == datetime(2026, 9, 12, 7, tzinfo=UTC)


def test_every_vintage_is_labelled_as_a_day_ahead_demand_forecast() -> None:
    issued = datetime(2026, 9, 11, 13, tzinfo=UTC)
    mapped = map_forecast_rows(rows("poll/region-df.json"), CONFIG, issued)
    assert mapped
    assert all(m.model == "eia_df" and m.metric == "demand" for m in mapped)
