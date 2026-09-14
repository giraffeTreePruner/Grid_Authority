"""The hourly map snapshot.

The snapshot is what the map actually renders, so its shape is a contract: fixed metric
order, null for missing, only zones that belong on the map.
"""

from __future__ import annotations

import gzip
import json
from datetime import UTC, datetime
from decimal import Decimal

import psycopg
import pytest
import respx

from workers.config import load_config
from workers.db.migrate import migrate_up
from workers.db.snapshots import (
    METRICS,
    SNAPSHOT_QUERY,
    build_snapshot,
    snapshot_bytes,
    store_snapshot,
)
from workers.db.zones import sync_zones
from workers.eia.client import EiaClient
from workers.eia.poll import run_poll
from workers.tests.conftest import one, requires_database
from workers.tests.test_poll import KEY, NOW, mock_eia

CONFIG = load_config()
PERIOD = datetime(2026, 9, 11, 14, tzinfo=UTC)


@pytest.fixture
def prepared(db: psycopg.Connection) -> psycopg.Connection:
    migrate_up(db)
    sync_zones(db, CONFIG)
    db.commit()
    return db


def insert_region(
    connection: psycopg.Connection,
    zone: str,
    demand: str | None,
    generation: str | None,
    interchange: str | None,
    period: datetime = PERIOD,
) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO obs_region_hourly (zone_key, period_utc, source, demand_mw, "
            "net_generation_mw, total_interchange_mw) VALUES (%s, %s, 'eia', %s, %s, %s)",
            (zone, period, demand, generation, interchange),
        )


def insert_mix(
    connection: psycopg.Connection,
    zone: str,
    renewable: str | None,
    low_carbon: str | None,
    period: datetime = PERIOD,
) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO obs_mix_hourly (zone_key, period_utc, source, renewable_share, "
            "low_carbon_share) VALUES (%s, %s, 'eia', %s, %s)",
            (zone, period, renewable, low_carbon),
        )


# -- shape ----------------------------------------------------------------------------


@requires_database
def test_the_document_matches_the_contract(prepared: psycopg.Connection) -> None:
    zone = CONFIG.zones.in_map()[0].key
    insert_region(prepared, zone, "58231", "57980", "-251")
    insert_mix(prepared, zone, "0.4120", "0.5180")

    snapshot = build_snapshot(prepared, PERIOD, CONFIG)

    assert snapshot["period"] == "2026-09-11T14:00:00Z"
    assert snapshot["metrics"] == list(METRICS)
    assert snapshot["zones"][zone] == [58231.0, 57980.0, -251.0, 0.412, 0.518]
    assert str(snapshot["built_at"]).endswith("Z")


@requires_database
def test_a_zone_with_no_data_is_all_nulls_never_zeros(prepared: psycopg.Connection) -> None:
    """§0.2: missing data must render as missing, not as a grid at zero demand."""
    snapshot = build_snapshot(prepared, PERIOD, CONFIG)
    zone = CONFIG.zones.in_map()[0].key
    assert snapshot["zones"][zone] == [None] * len(METRICS)


@requires_database
def test_a_genuine_zero_survives(prepared: psycopg.Connection) -> None:
    """Zero generation is a reading, and must stay distinguishable from no reading."""
    zone = CONFIG.zones.in_map()[0].key
    insert_region(prepared, zone, "0", None, None)
    snapshot = build_snapshot(prepared, PERIOD, CONFIG)
    assert snapshot["zones"][zone][0] == 0.0
    assert snapshot["zones"][zone][1] is None


@requires_database
def test_only_zones_on_the_map_appear(prepared: psycopg.Connection) -> None:
    """Aggregates would double-count the balancing authorities they contain."""
    snapshot = build_snapshot(prepared, PERIOD, CONFIG)
    assert set(snapshot["zones"]) == {z.key for z in CONFIG.zones.in_map()}
    aggregates = {z.key for z in CONFIG.zones.zones if z.type != "balancing_authority"}
    assert not (set(snapshot["zones"]) & aggregates)


@requires_database
def test_every_row_has_one_value_per_metric(prepared: psycopg.Connection) -> None:
    snapshot = build_snapshot(prepared, PERIOD, CONFIG)
    assert all(len(values) == len(METRICS) for values in snapshot["zones"].values())


@requires_database
def test_rounding_is_one_place_for_power_and_three_for_shares(
    prepared: psycopg.Connection,
) -> None:
    zone = CONFIG.zones.in_map()[0].key
    insert_region(prepared, zone, "58231.27", None, None)
    insert_mix(prepared, zone, "0.4127", None)
    snapshot = build_snapshot(prepared, PERIOD, CONFIG)
    assert snapshot["zones"][zone][0] == 58231.3
    assert snapshot["zones"][zone][3] == 0.413


@requires_database
def test_a_zone_with_only_a_mix_row_still_appears(prepared: psycopg.Connection) -> None:
    """The join must not drop a zone that reported a mix but no demand."""
    zone = CONFIG.zones.in_map()[0].key
    insert_mix(prepared, zone, "0.6000", "0.7000")
    snapshot = build_snapshot(prepared, PERIOD, CONFIG)
    assert snapshot["zones"][zone] == [None, None, None, 0.6, 0.7]


# -- size -----------------------------------------------------------------------------


@requires_database
def test_a_full_snapshot_stays_under_twenty_five_kilobytes(
    prepared: psycopg.Connection,
) -> None:
    """§8's budget, measured with every zone carrying a full set of values."""
    for index, zone in enumerate(CONFIG.zones.in_map()):
        insert_region(prepared, zone.key, f"{50000 + index}.5", f"{49000 + index}.5", "-251.5")
        insert_mix(prepared, zone.key, "0.4127", "0.5183")

    payload = build_snapshot(prepared, PERIOD, CONFIG)
    compressed = gzip.compress(snapshot_bytes(payload))

    assert len(payload["zones"]) == len(CONFIG.zones.in_map())
    assert len(compressed) < 25 * 1024, f"{len(compressed)} bytes gzipped"


# -- storage --------------------------------------------------------------------------


@requires_database
def test_a_stored_snapshot_round_trips(prepared: psycopg.Connection) -> None:
    payload = build_snapshot(prepared, PERIOD, CONFIG)
    store_snapshot(prepared, PERIOD, payload)
    with prepared.cursor() as cursor:
        cursor.execute("SELECT payload FROM map_snapshot WHERE period_utc = %s", (PERIOD,))
        assert one(cursor)[0] == json.loads(json.dumps(payload))


@requires_database
def test_rebuilding_replaces_rather_than_duplicates(prepared: psycopg.Connection) -> None:
    zone = CONFIG.zones.in_map()[0].key
    store_snapshot(prepared, PERIOD, build_snapshot(prepared, PERIOD, CONFIG))
    insert_region(prepared, zone, "1234", None, None)
    store_snapshot(prepared, PERIOD, build_snapshot(prepared, PERIOD, CONFIG))

    with prepared.cursor() as cursor:
        cursor.execute("SELECT count(*), max(payload -> 'zones' ->> %s) FROM map_snapshot", (zone,))
        count, values = one(cursor)
    assert count == 1
    assert json.loads(values)[0] == 1234.0


# -- inside a poll cycle --------------------------------------------------------------


@respx.mock
@requires_database
def test_a_poll_cycle_builds_snapshots(prepared: psycopg.Connection) -> None:
    mock_eia()
    summary = run_poll(prepared, EiaClient(KEY, sleep=lambda _s: None), CONFIG, NOW)

    assert summary.snapshots_built > 0
    with prepared.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM map_snapshot")
        assert one(cursor)[0] == summary.snapshots_built


@respx.mock
@requires_database
def test_snapshots_carry_the_values_that_were_ingested(
    prepared: psycopg.Connection,
) -> None:
    """The map must agree with the observations it was built from."""
    mock_eia()
    run_poll(prepared, EiaClient(KEY, sleep=lambda _s: None), CONFIG, NOW)

    with prepared.cursor() as cursor:
        cursor.execute(
            "SELECT period_utc, payload FROM map_snapshot ORDER BY period_utc DESC LIMIT 1"
        )
        period, payload = one(cursor)
        cursor.execute(
            "SELECT zone_key, demand_mw FROM obs_region_hourly "
            "WHERE period_utc = %s AND demand_mw IS NOT NULL",
            (period,),
        )
        observed: dict[str, Decimal] = dict(cursor.fetchall())

    assert observed, "expected at least one demand value in the newest hour"
    for zone_key, demand in observed.items():
        if zone_key in payload["zones"]:
            assert payload["zones"][zone_key][0] == float(Decimal(demand).quantize(Decimal("0.1")))


# -- query shape ------------------------------------------------------------------------


@requires_database
def test_building_a_snapshot_uses_an_index_and_not_a_table_scan(
    prepared: psycopg.Connection,
) -> None:
    """A correctness-neutral property that decides whether a long backfill finishes.

    The obvious way to write this query joins first and filters on
    COALESCE(r.period_utc, m.period_utc). Postgres will not push that predicate through
    a full outer join, so it builds the entire join and filters the result: two
    sequential scans of two growing tables, for every hour built. A ninety-day backfill
    absorbs it. A seven-year one does not -- the work grows with each day completed, and
    the run stops looking finite.

    Asserted on the plan rather than on a duration, because a timing threshold on a
    small fixture would be noise.
    """
    zone = CONFIG.zones.in_map()[0].key
    insert_region(prepared, zone, "58231", "57980", "-251")
    insert_mix(prepared, zone, "0.4120", "0.5180")

    in_map = [z.key for z in CONFIG.zones.in_map()]
    with prepared.cursor() as cursor:
        # Named parameters, so this explains whatever the query happens to be rather
        # than a positional copy of the shape it has today.
        cursor.execute("EXPLAIN " + SNAPSHOT_QUERY, {"period": PERIOD, "keys": in_map})
        plan = "\n".join(row[0] for row in cursor.fetchall())

    assert "Seq Scan" not in plan, f"a table scan crept back into the snapshot query:\n{plan}"
    assert "Index" in plan, f"no index is being used:\n{plan}"
