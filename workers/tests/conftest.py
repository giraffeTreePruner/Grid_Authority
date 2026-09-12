"""Shared test fixtures.

Database tests run against a throwaway schema inside the development database, so a
test run never touches real observations and two runs cannot collide.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest


def database_url() -> str | None:
    """The configured test database, if there is one."""
    return os.environ.get("DATABASE_URL", "").strip() or None


requires_database = pytest.mark.skipif(
    database_url() is None,
    reason="DATABASE_URL is not set; start docker compose and export it to run these",
)


def one(cursor: psycopg.Cursor) -> tuple[Any, ...]:
    """The single row a query was expected to return.

    psycopg types fetchone() as optional; a query written to return exactly one row
    should fail loudly here rather than at an unhelpful index error later.
    """
    row = cursor.fetchone()
    assert row is not None, "expected exactly one row, got none"
    return row


@pytest.fixture
def db() -> Iterator[psycopg.Connection]:
    """A connection whose search_path points at a schema created just for this test."""
    url = database_url()
    if url is None:
        pytest.skip("DATABASE_URL is not set")

    schema = f"test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(url) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SET TIME ZONE 'UTC'")
            cursor.execute(f'CREATE SCHEMA "{schema}"')
            cursor.execute(f'SET search_path TO "{schema}"')
        connection.commit()
        try:
            yield connection
        finally:
            connection.rollback()
            with connection.cursor() as cursor:
                cursor.execute("SET search_path TO public")
                cursor.execute(f'DROP SCHEMA "{schema}" CASCADE')
            connection.commit()
