"""Database connections.

Every connection is UTC. The container, the server and the session all agree, so a
timestamp never changes meaning on its way in or out.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager

import psycopg


class DatabaseUrlMissing(RuntimeError):
    """DATABASE_URL is not set."""

    def __init__(self) -> None:
        super().__init__(
            "DATABASE_URL is not set. Copy .env.example to .env and fill it in, then run "
            "with `uv run --env-file .env ...`, or export it in the environment."
        )


def database_url() -> str:
    """Connection string from the environment."""
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        raise DatabaseUrlMissing
    return url


@contextmanager
def connect(url: str | None = None, *, autocommit: bool = False) -> Iterator[psycopg.Connection]:
    """Open a UTC connection, closing it on the way out."""
    with psycopg.connect(url or database_url(), autocommit=autocommit) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SET TIME ZONE 'UTC'")
        yield connection
