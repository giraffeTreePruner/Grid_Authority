"""Migration discovery and the up/down/up cycle."""

from __future__ import annotations

from pathlib import Path

import psycopg
import pytest

from workers.db.migrate import (
    MigrationError,
    applied_versions,
    available_migrations,
    migrate_down,
    migrate_up,
    pending_migrations,
)
from workers.tests.conftest import requires_database

UP = "CREATE TABLE widget (id integer PRIMARY KEY);"
DOWN = "DROP TABLE widget;"


def write_pair(directory: Path, version: str, name: str, up: str = UP, down: str = DOWN) -> None:
    (directory / f"{version}_{name}.up.sql").write_text(up, encoding="utf-8")
    (directory / f"{version}_{name}.down.sql").write_text(down, encoding="utf-8")


def test_repository_migrations_are_well_formed() -> None:
    """Every committed migration has both directions and a unique version."""
    migrations = available_migrations()
    assert [m.version for m in migrations] == sorted(m.version for m in migrations)
    assert len({m.version for m in migrations}) == len(migrations)
    for migration in migrations:
        assert migration.up_sql().strip()
        assert migration.down_sql().strip()


def test_discovery_is_ordered_by_version(tmp_path: Path) -> None:
    write_pair(tmp_path, "0002", "second")
    write_pair(tmp_path, "0001", "first")
    assert [m.label for m in available_migrations(tmp_path)] == ["0001_first", "0002_second"]


def test_missing_down_file_is_rejected(tmp_path: Path) -> None:
    """A migration that cannot be reverted is not a migration."""
    (tmp_path / "0001_only_up.up.sql").write_text(UP, encoding="utf-8")
    with pytest.raises(MigrationError) as exc:
        available_migrations(tmp_path)
    assert "0001: no .down.sql" in str(exc.value)


def test_missing_up_file_is_rejected(tmp_path: Path) -> None:
    (tmp_path / "0001_only_down.down.sql").write_text(DOWN, encoding="utf-8")
    with pytest.raises(MigrationError) as exc:
        available_migrations(tmp_path)
    assert "0001: no .up.sql" in str(exc.value)


def test_unrecognised_filename_is_rejected(tmp_path: Path) -> None:
    """An unparseable name is an error, not a file to skip quietly."""
    (tmp_path / "add-some-table.sql").write_text(UP, encoding="utf-8")
    with pytest.raises(MigrationError) as exc:
        available_migrations(tmp_path)
    assert "not a valid migration filename" in str(exc.value)


def test_duplicate_version_is_rejected(tmp_path: Path) -> None:
    """Two complete migrations claiming one version cannot both be applied."""
    write_pair(tmp_path, "0001", "first")
    write_pair(tmp_path, "0001", "also_first")
    with pytest.raises(MigrationError) as exc:
        available_migrations(tmp_path)
    assert "duplicate" in str(exc.value)
    assert "0001" in str(exc.value)


def test_version_reused_under_two_names_is_rejected(tmp_path: Path) -> None:
    """A half-renamed migration would otherwise pair an up with an unrelated down."""
    (tmp_path / "0001_first.up.sql").write_text(UP, encoding="utf-8")
    (tmp_path / "0001_second.down.sql").write_text(DOWN, encoding="utf-8")
    with pytest.raises(MigrationError) as exc:
        available_migrations(tmp_path)
    assert "two different names" in str(exc.value)


@requires_database
def test_up_down_up_leaves_the_same_schema(db: psycopg.Connection) -> None:
    """The acceptance criterion: migrate up, down, then up again cleanly."""

    def table_names() -> set[str]:
        with db.cursor() as cursor:
            cursor.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = current_schema()"
            )
            return {row[0] for row in cursor.fetchall()}

    applied = migrate_up(db)
    assert [m.label for m in applied] == [m.label for m in available_migrations()]
    after_first_up = table_names()
    assert {"zones", "obs_region_hourly", "obs_mix_hourly", "map_snapshot"} <= after_first_up

    reverted = migrate_down(db, steps=len(applied))
    assert [m.version for m in reverted] == [m.version for m in reversed(applied)]
    assert table_names() == {"schema_migrations"}

    migrate_up(db)
    assert table_names() == after_first_up


@requires_database
def test_up_is_idempotent(db: psycopg.Connection) -> None:
    migrate_up(db)
    assert migrate_up(db) == []
    assert pending_migrations(db) == []


@requires_database
def test_down_reverts_one_step_by_default(db: psycopg.Connection) -> None:
    migrate_up(db)
    every = available_migrations()
    reverted = migrate_down(db)
    assert len(reverted) == 1
    assert reverted[0].version == every[-1].version
    assert applied_versions(db) == [m.version for m in every[:-1]]


@requires_database
def test_a_database_ahead_of_the_checkout_is_reported(db: psycopg.Connection) -> None:
    """An applied version with no file on disk means the working copy is behind."""
    migrate_up(db)
    with db.cursor() as cursor:
        cursor.execute(
            "INSERT INTO schema_migrations (version, name) VALUES ('9999', 'from_the_future')"
        )
    with pytest.raises(MigrationError) as exc:
        pending_migrations(db)
    assert "9999" in str(exc.value)
    assert "behind the database" in str(exc.value)


@requires_database
def test_a_failing_migration_leaves_no_trace(db: psycopg.Connection, tmp_path: Path) -> None:
    """A migration and its ledger row commit together or not at all."""
    write_pair(tmp_path, "0001", "good")
    write_pair(tmp_path, "0002", "broken", up="CREATE TABLE ;")

    with pytest.raises(MigrationError) as exc:
        migrate_up(db, tmp_path)
    assert "0002_broken failed to apply" in str(exc.value)

    assert applied_versions(db) == ["0001"]
