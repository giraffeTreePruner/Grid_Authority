"""Syncing the zone registry into the database."""

from __future__ import annotations

import psycopg
import pytest

from workers.config import load_config
from workers.db.migrate import migrate_up
from workers.db.zones import (
    ZoneSyncError,
    in_dependency_order,
    sync_zones,
    validate_against_respondents,
    zones_with_observations,
)
from workers.tests.conftest import one, requires_database


@pytest.fixture
def migrated(db: psycopg.Connection) -> psycopg.Connection:
    migrate_up(db)
    return db


def test_parents_are_ordered_before_their_children() -> None:
    """zones.parent is a self-referencing foreign key, so order is not cosmetic."""
    zones = load_config().zones.zones
    written: set[str] = set()
    for zone in in_dependency_order(zones):
        assert zone.parent is None or zone.parent in written, (
            f"{zone.key} is written before its parent {zone.parent}"
        )
        written.add(zone.key)
    assert len(list(in_dependency_order(zones))) == len(zones)


def test_a_parent_cycle_is_rejected() -> None:
    config = load_config()
    zones = list(config.zones.zones[:2])
    zones[0] = zones[0].model_copy(update={"parent": zones[1].key})
    zones[1] = zones[1].model_copy(update={"parent": zones[0].key})
    with pytest.raises(ZoneSyncError) as exc:
        in_dependency_order(zones)
    assert "cycle" in str(exc.value)


def test_an_unaccounted_respondent_fails_the_sync() -> None:
    """§7.5: a respondent EIA publishes that we know nothing about is fatal."""
    config = load_config()
    with pytest.raises(ZoneSyncError) as exc:
        validate_against_respondents(config, config.zones.respondents() | {"NEWBA"})
    assert "NEWBA" in str(exc.value)
    assert "excluded_respondents.yaml" in str(exc.value)


def test_known_respondents_pass_validation() -> None:
    config = load_config()
    known = config.zones.respondents() | config.excluded_respondents.codes()
    # Raises on an unknown respondent; returning is the assertion.
    validate_against_respondents(config, known)


@requires_database
def test_sync_writes_every_zone(migrated: psycopg.Connection) -> None:
    config = load_config()
    result = sync_zones(migrated, config)

    assert len(result.inserted) == len(config.zones.zones)
    assert not result.updated and not result.unchanged and not result.orphaned

    with migrated.cursor() as cursor:
        cursor.execute("SELECT count(*), count(*) FILTER (WHERE in_map) FROM zones")
        total, on_map = one(cursor)
    assert total == len(config.zones.zones)
    assert on_map == len(config.zones.in_map())


@requires_database
def test_the_table_matches_the_yaml(migrated: psycopg.Connection) -> None:
    config = load_config()
    sync_zones(migrated, config)

    with migrated.cursor() as cursor:
        cursor.execute(
            "SELECT key, eia_respondent, name, short_name, interconnection, timezone, "
            "type, parent, in_map, capabilities FROM zones"
        )
        rows = {r[0]: r for r in cursor.fetchall()}

    assert set(rows) == {zone.key for zone in config.zones.zones}
    for zone in config.zones.zones:
        row = rows[zone.key]
        assert row[1:9] == (
            zone.eia_respondent,
            zone.name,
            zone.short_name,
            zone.interconnection,
            zone.timezone,
            zone.type,
            zone.parent,
            zone.in_map,
        )
        assert row[9] == zone.capabilities.model_dump()


@requires_database
def test_re_running_changes_nothing(migrated: psycopg.Connection) -> None:
    """The acceptance criterion: a second sync is a no-op, updated_at included."""
    config = load_config()
    sync_zones(migrated, config)
    with migrated.cursor() as cursor:
        cursor.execute("SELECT key, updated_at FROM zones ORDER BY key")
        before = cursor.fetchall()

    again = sync_zones(migrated, config)

    assert not again.inserted
    assert not again.updated
    assert len(again.unchanged) == len(config.zones.zones)

    with migrated.cursor() as cursor:
        cursor.execute("SELECT key, updated_at FROM zones ORDER BY key")
        assert cursor.fetchall() == before


@requires_database
def test_a_real_change_is_applied_and_nothing_else_is(migrated: psycopg.Connection) -> None:
    config = load_config()
    sync_zones(migrated, config)

    target = config.zones.zones[-1]
    with migrated.cursor() as cursor:
        cursor.execute("UPDATE zones SET short_name = 'STALE' WHERE key = %s", (target.key,))

    result = sync_zones(migrated, config)

    assert result.updated == [target.key]
    assert len(result.unchanged) == len(config.zones.zones) - 1
    with migrated.cursor() as cursor:
        cursor.execute("SELECT short_name FROM zones WHERE key = %s", (target.key,))
        assert one(cursor)[0] == target.short_name


@requires_database
def test_a_zone_missing_from_the_yaml_is_kept_and_reported(
    migrated: psycopg.Connection,
) -> None:
    """Deleting it would orphan observations, so it is reported instead."""
    config = load_config()
    sync_zones(migrated, config)

    with migrated.cursor() as cursor:
        cursor.execute(
            "INSERT INTO zones (key, eia_respondent, name, short_name, interconnection, "
            "timezone, type, parent, in_map, capabilities) VALUES "
            "('US-OLD-GONE', 'GONE', 'Retired BA', 'Gone', 'eastern', 'UTC', "
            "'balancing_authority', NULL, true, '{}'::jsonb)"
        )

    result = sync_zones(migrated, config)
    assert result.orphaned == ["US-OLD-GONE"]

    with migrated.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM zones WHERE key = 'US-OLD-GONE'")
        assert one(cursor)[0] == 1


@requires_database
def test_orphans_holding_observations_are_identified(migrated: psycopg.Connection) -> None:
    config = load_config()
    sync_zones(migrated, config)
    zone = config.zones.in_map()[0]

    assert zones_with_observations(migrated, [zone.key]) == []

    with migrated.cursor() as cursor:
        cursor.execute(
            "INSERT INTO obs_region_hourly (zone_key, period_utc, source, demand_mw) "
            "VALUES (%s, '2026-09-11T14:00:00Z', 'eia', 100)",
            (zone.key,),
        )

    assert zones_with_observations(migrated, [zone.key]) == [zone.key]
