"""Migration runner for the numbered SQL files in ``db/migrations``.

Each migration is a pair of files, ``NNNN_name.up.sql`` and ``NNNN_name.down.sql``.
Both are required: a migration that cannot be reverted is not accepted, because the
acceptance criterion for the schema is up, then down, then up again on the same
database.

Each migration runs inside a transaction together with the ledger row that records it,
so a failure leaves neither a half-applied schema nor a lying ledger.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import psycopg

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "db" / "migrations"
FILENAME_PATTERN = re.compile(
    r"^(?P<version>\d{4})_(?P<name>[a-z0-9_]+)\.(?P<direction>up|down)\.sql$"
)

LEDGER_DDL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text PRIMARY KEY,
    name        text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
)
"""


class MigrationError(RuntimeError):
    """A migration is malformed, missing, or failed to apply."""


@dataclass(frozen=True)
class Migration:
    """One reversible schema change."""

    version: str
    name: str
    up_path: Path
    down_path: Path

    @property
    def label(self) -> str:
        return f"{self.version}_{self.name}"

    def up_sql(self) -> str:
        return self.up_path.read_text(encoding="utf-8")

    def down_sql(self) -> str:
        return self.down_path.read_text(encoding="utf-8")


def available_migrations(directory: Path | None = None) -> list[Migration]:
    """Every migration on disk, in version order.

    A missing counterpart file, a duplicate version or an unrecognised filename is an
    error rather than a skipped file: silently ignoring a migration is how a database
    and its schema drift apart.
    """
    base = directory or MIGRATIONS_DIR
    if not base.is_dir():
        raise MigrationError(f"{base} is not a directory")

    ups: dict[str, Path] = {}
    downs: dict[str, Path] = {}
    names: dict[str, str] = {}

    for path in sorted(base.iterdir()):
        if path.name.startswith(".") or not path.is_file():
            continue
        match = FILENAME_PATTERN.match(path.name)
        if not match:
            raise MigrationError(
                f"{path.name} is not a valid migration filename; "
                "expected NNNN_name.up.sql or NNNN_name.down.sql"
            )

        version = match["version"]
        name = match["name"]
        side = ups if match["direction"] == "up" else downs

        if version in side:
            raise MigrationError(
                f"duplicate {match['direction']} migration for version {version}: "
                f"{side[version].name} and {path.name}"
            )
        if names.setdefault(version, name) != name:
            raise MigrationError(
                f"version {version} is used by two different names: {names[version]} and {name}"
            )
        side[version] = path

    problems = [f"{version}: no .down.sql" for version in sorted(set(ups) - set(downs))]
    problems += [f"{version}: no .up.sql" for version in sorted(set(downs) - set(ups))]
    if problems:
        raise MigrationError("every migration needs both directions; " + "; ".join(problems))

    return [
        Migration(
            version=version, name=names[version], up_path=ups[version], down_path=downs[version]
        )
        for version in sorted(ups)
    ]


def ensure_ledger(connection: psycopg.Connection) -> None:
    """Create the ledger table if this database has never been migrated."""
    with connection.cursor() as cursor:
        cursor.execute(LEDGER_DDL)


def applied_versions(connection: psycopg.Connection) -> list[str]:
    """Versions recorded as applied, oldest first."""
    ensure_ledger(connection)
    with connection.cursor() as cursor:
        cursor.execute("SELECT version FROM schema_migrations ORDER BY version")
        return [row[0] for row in cursor.fetchall()]


def pending_migrations(
    connection: psycopg.Connection, directory: Path | None = None
) -> list[Migration]:
    """Migrations on disk that this database has not applied.

    An applied version with no file on disk means the database is ahead of the
    checkout, which is reported rather than ignored.
    """
    applied = set(applied_versions(connection))
    migrations = available_migrations(directory)
    known = {migration.version for migration in migrations}

    orphans = sorted(applied - known)
    if orphans:
        raise MigrationError(
            "the database has migrations this checkout does not: "
            + ", ".join(orphans)
            + ". The working copy is behind the database."
        )

    return [migration for migration in migrations if migration.version not in applied]


def migrate_up(connection: psycopg.Connection, directory: Path | None = None) -> list[Migration]:
    """Apply every pending migration in order. Returns what was applied."""
    applied: list[Migration] = []
    for migration in pending_migrations(connection, directory):
        try:
            with connection.transaction(), connection.cursor() as cursor:
                cursor.execute(migration.up_sql())
                cursor.execute(
                    "INSERT INTO schema_migrations (version, name) VALUES (%s, %s)",
                    (migration.version, migration.name),
                )
        except psycopg.Error as error:
            raise MigrationError(f"{migration.label} failed to apply: {error}") from error
        applied.append(migration)
    return applied


def migrate_down(
    connection: psycopg.Connection, steps: int = 1, directory: Path | None = None
) -> list[Migration]:
    """Revert the most recently applied migrations, newest first."""
    if steps < 1:
        raise MigrationError("steps must be at least 1")

    applied = set(applied_versions(connection))
    migrations = [m for m in available_migrations(directory) if m.version in applied]
    reverted: list[Migration] = []

    for migration in reversed(migrations[-steps:] if steps <= len(migrations) else migrations):
        try:
            with connection.transaction(), connection.cursor() as cursor:
                cursor.execute(migration.down_sql())
                cursor.execute(
                    "DELETE FROM schema_migrations WHERE version = %s", (migration.version,)
                )
        except psycopg.Error as error:
            raise MigrationError(f"{migration.label} failed to revert: {error}") from error
        reverted.append(migration)

    return reverted
