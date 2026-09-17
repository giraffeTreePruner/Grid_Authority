"""Keeping the visitor-salt retention promise.

`visitor_salt` holds one random salt per UTC day, and the privacy claim on the stats
page is that a salt is deleted after eight days: once it is gone, that day's visitor
hashes cannot be re-derived by anyone, including whoever runs the server.

Something has to actually delete them, and it cannot be the API. The API is granted
`SELECT, INSERT` on the analytics tables and nothing else, deliberately, so that a bug
in it cannot rewrite or destroy a record. A `DELETE` issued from there fails on
permissions in production however reasonable it looks in the source.

So the prune runs here, from the poll job, under the owner role -- which is what
`0007_analytics.up.sql` said all along.
"""

from __future__ import annotations

import psycopg

#: Days a salt is kept. Must match SALT_RETENTION_DAYS in the API's analytics route:
#: that one documents the promise to a reader, this one keeps it.
SALT_RETENTION_DAYS = 8


def prune_visitor_salts(
    connection: psycopg.Connection, retention_days: int = SALT_RETENTION_DAYS
) -> int:
    """Delete salts older than the retention window. Returns how many went.

    Keyed on the database's own `current_date` rather than a Python clock, so the
    boundary cannot move with the caller's time zone.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM visitor_salt WHERE day < current_date - %(days)s::integer",
            {"days": retention_days},
        )
        return cursor.rowcount
