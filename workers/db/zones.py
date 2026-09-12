"""Sync the zone registry from ``config/zones.yaml`` into the database.

Upsert-only. A zone is never deleted, because observations reference it and losing the
registry row would orphan real measurements. A zone that disappears from the YAML is
reported, not removed.

The sync is idempotent in the strict sense: a row is rewritten only when one of its
fields actually differs, so re-running leaves `updated_at` alone and the second run
reports no changes at all.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import psycopg
from psycopg.types.json import Json

from workers.config import AppConfig, Zone

# Ordered to match the INSERT below. `key` is the conflict target; the rest are the
# fields compared to decide whether an update is a real change.
MUTABLE_COLUMNS = (
    "eia_respondent",
    "name",
    "short_name",
    "interconnection",
    "timezone",
    "type",
    "parent",
    "in_map",
    "capabilities",
)


class ZoneSyncError(RuntimeError):
    """The registry cannot be synced as it stands."""


@dataclass
class SyncResult:
    """What one sync changed."""

    inserted: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    orphaned: list[str] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.inserted or self.updated)

    def summary(self) -> str:
        parts = [
            f"{len(self.inserted)} inserted",
            f"{len(self.updated)} updated",
            f"{len(self.unchanged)} unchanged",
        ]
        if self.orphaned:
            parts.append(f"{len(self.orphaned)} in the database but not in the registry")
        return ", ".join(parts)


def validate_against_respondents(config: AppConfig, discovered: set[str]) -> None:
    """Fail if a respondent EIA publishes is in neither the registry nor the exclusions.

    §7.5: an unaccounted respondent is a hard failure. Silently ignoring one is how a
    new balancing authority goes unnoticed for months.
    """
    accounted = config.zones.respondents() | config.excluded_respondents.codes()
    unaccounted = sorted(discovered - accounted)
    if unaccounted:
        raise ZoneSyncError(
            "EIA publishes respondents that are in neither zones.yaml nor "
            f"excluded_respondents.yaml: {', '.join(unaccounted)}. "
            "Add each as a zone, or exclude it with a reason."
        )


def in_dependency_order(zones: list[Zone]) -> list[Zone]:
    """Order zones so a parent is always written before its children.

    `zones.parent` is a self-referencing foreign key, so the national total has to
    land before the regions and the regions before the balancing authorities.
    """
    remaining = list(zones)
    written: set[str] = set()
    ordered: list[Zone] = []

    while remaining:
        ready = [z for z in remaining if z.parent is None or z.parent in written]
        if not ready:
            stuck = sorted(z.key for z in remaining)
            raise ZoneSyncError(f"zone parents form a cycle or reference a missing zone: {stuck}")
        for zone in ready:
            ordered.append(zone)
            written.add(zone.key)
        remaining = [z for z in remaining if z.key not in written]

    return ordered


def sync_zones(
    connection: psycopg.Connection,
    config: AppConfig,
    discovered_respondents: set[str] | None = None,
) -> SyncResult:
    """Upsert every zone in the registry. Returns what changed."""
    if discovered_respondents is not None:
        validate_against_respondents(config, discovered_respondents)

    result = SyncResult()
    columns = ", ".join(MUTABLE_COLUMNS)
    excluded = ", ".join(f"EXCLUDED.{c}" for c in MUTABLE_COLUMNS)
    assignments = ", ".join(f"{c} = EXCLUDED.{c}" for c in MUTABLE_COLUMNS)
    current = ", ".join(f"zones.{c}" for c in MUTABLE_COLUMNS)

    statement = f"""
        INSERT INTO zones (key, {columns}, updated_at)
        VALUES (%s, {", ".join(["%s"] * len(MUTABLE_COLUMNS))}, now())
        ON CONFLICT (key) DO UPDATE
           SET {assignments}, updated_at = now()
         WHERE ({current}) IS DISTINCT FROM ({excluded})
        RETURNING (xmax = 0) AS inserted
    """

    with connection.cursor() as cursor:
        for zone in in_dependency_order(config.zones.zones):
            cursor.execute(
                statement,
                (
                    zone.key,
                    zone.eia_respondent,
                    zone.name,
                    zone.short_name,
                    zone.interconnection,
                    zone.timezone,
                    zone.type,
                    zone.parent,
                    zone.in_map,
                    Json(zone.capabilities.model_dump()),
                ),
            )
            row = cursor.fetchone()
            if row is None:
                # The WHERE clause suppressed the update: every field already matched.
                result.unchanged.append(zone.key)
            elif row[0]:
                result.inserted.append(zone.key)
            else:
                result.updated.append(zone.key)

        cursor.execute("SELECT key FROM zones")
        in_database = {r[0] for r in cursor.fetchall()}

    result.orphaned = sorted(in_database - {z.key for z in config.zones.zones})
    return result


def zones_with_observations(connection: psycopg.Connection, keys: list[str]) -> list[str]:
    """Which of these zones have observations referencing them.

    Used to explain why an orphaned zone is being kept rather than removed.
    """
    if not keys:
        return []
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT DISTINCT key FROM (
                SELECT zone_key AS key FROM obs_region_hourly WHERE zone_key = ANY(%(keys)s)
                UNION ALL
                SELECT zone_key FROM obs_mix_hourly WHERE zone_key = ANY(%(keys)s)
                UNION ALL
                SELECT from_zone FROM obs_interchange_hourly WHERE from_zone = ANY(%(keys)s)
                UNION ALL
                SELECT zone_key FROM forecast_issues WHERE zone_key = ANY(%(keys)s)
            ) AS referenced
            """,
            {"keys": keys},
        )
        return sorted(r[0] for r in cursor.fetchall())
