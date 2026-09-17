"""The visitor-salt retention promise.

The stats page tells a reader that a day's salt is deleted after eight days, and that
once it is gone that day's visitor hashes cannot be re-derived by anyone. That is a
privacy claim, so something has to actually delete them.

It cannot be the API: that role is granted SELECT and INSERT on the analytics tables and
nothing else, so a DELETE issued from there fails on permissions in production however
reasonable it looks in the source. The prune therefore runs from the poll job, under the
owner role, which is what 0007_analytics.up.sql said from the start.
"""

from __future__ import annotations

from datetime import date, timedelta

import psycopg
import pytest

from workers.db.analytics import SALT_RETENTION_DAYS, prune_visitor_salts
from workers.db.migrate import migrate_up
from workers.tests.conftest import one, requires_database


@pytest.fixture
def migrated(db: psycopg.Connection) -> psycopg.Connection:
    """A migrated schema. No zone registry: the analytics tables reference no zone."""
    migrate_up(db)
    db.commit()
    return db


def add_salt(connection: psycopg.Connection, day: date) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO visitor_salt (day, salt) VALUES (%s, %s)",
            (day, f"salt-for-{day.isoformat()}"),
        )


def days(connection: psycopg.Connection) -> list[date]:
    with connection.cursor() as cursor:
        cursor.execute("SELECT day FROM visitor_salt ORDER BY day")
        return [row[0] for row in cursor.fetchall()]


@requires_database
def test_prune_drops_salts_past_the_window(migrated: psycopg.Connection) -> None:
    today = date.today()
    keep = today - timedelta(days=SALT_RETENTION_DAYS - 1)
    drop = today - timedelta(days=SALT_RETENTION_DAYS + 1)

    add_salt(migrated, today)
    add_salt(migrated, keep)
    add_salt(migrated, drop)

    assert prune_visitor_salts(migrated) == 1
    assert days(migrated) == [keep, today]


@requires_database
def test_prune_keeps_the_boundary_day(migrated: psycopg.Connection) -> None:
    """Exactly at the window is still inside it. Eight days means eight, not seven."""
    today = date.today()
    boundary = today - timedelta(days=SALT_RETENTION_DAYS)

    add_salt(migrated, boundary)

    assert prune_visitor_salts(migrated) == 0
    assert days(migrated) == [boundary]


@requires_database
def test_prune_is_idempotent(migrated: psycopg.Connection) -> None:
    add_salt(migrated, date.today() - timedelta(days=SALT_RETENTION_DAYS + 3))

    assert prune_visitor_salts(migrated) == 1
    assert prune_visitor_salts(migrated) == 0


@requires_database
def test_prune_on_an_empty_table_does_nothing(migrated: psycopg.Connection) -> None:
    assert prune_visitor_salts(migrated) == 0


@requires_database
def test_prune_leaves_page_hits_alone(migrated: psycopg.Connection) -> None:
    """A hit outlives the salt that made its pseudonym.

    That is the point of the scheme: the counts stay, the ability to link them to a
    person does not.
    """
    old_day = date.today() - timedelta(days=SALT_RETENTION_DAYS + 1)
    add_salt(migrated, old_day)
    with migrated.cursor() as cursor:
        cursor.execute(
            "INSERT INTO page_hit (day, path, visitor) VALUES (%s, %s, %s)",
            (old_day, "/", "a" * 32),
        )

    prune_visitor_salts(migrated)

    with migrated.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM page_hit")
        assert one(cursor)[0] == 1
