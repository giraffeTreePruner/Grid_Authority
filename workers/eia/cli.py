"""Command-line entry point for the EIA ingest workers.

Each subcommand is a standalone job: it exits 0 on success, non-zero on failure,
and prints a single-line JSON summary as its last line of stdout.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Annotated

import typer

from workers.config import ConfigError, load_config
from workers.db import (
    MigrationError,
    ZoneSyncError,
    applied_versions,
    connect,
    migrate_down,
    migrate_up,
    sync_zones,
    zones_with_observations,
)
from workers.db.migrate import available_migrations, pending_migrations
from workers.eia.client import EiaClient
from workers.eia.poll import run_poll

app = typer.Typer(
    add_completion=False,
    help="EIA-930 ingest jobs for Grid Authority.",
    no_args_is_help=True,
)


@app.callback()
def _root() -> None:
    """Group the jobs under one entry point rather than collapsing to a single command."""


@app.command("check-config")
def check_config(
    config_dir: Annotated[
        Path | None,
        typer.Option(
            "--config-dir",
            help="Directory holding the YAML config files. Defaults to the repository config/.",
        ),
    ] = None,
) -> None:
    """Load and validate every config file, then report what was found.

    This is the same code path every job runs at startup, so a config that passes
    here is a config the jobs will accept.
    """
    try:
        config = load_config(config_dir)
    except ConfigError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(code=1) from error

    on_map = len(config.zones.in_map())
    typer.echo(
        f"{len(config.zones.zones)} zones ({on_map} on the map), "
        f"{len(config.excluded_respondents.codes())} excluded respondents, "
        f"{len(config.modes.canonical_modes)} canonical modes, "
        f"{len(config.sources.root)} sources"
    )


def main() -> None:
    """Console-script entry point."""
    app()


if __name__ == "__main__":
    sys.exit(app())


def _api_key() -> str:
    key = os.environ.get("EIA_API_KEY", "").strip()
    if not key:
        typer.echo(
            "EIA_API_KEY is not set. Add it to .env and run with "
            "`uv run --env-file .env ...`, or export it.",
            err=True,
        )
        raise typer.Exit(code=1)
    return key


@app.command("poll")
def poll_command(
    config_dir: Annotated[
        Path | None,
        typer.Option("--config-dir", help="Directory holding the YAML config files."),
    ] = None,
) -> None:
    """Fetch and store a recent window of every EIA series.

    Exits non-zero on any failure, having recorded it in source_status. The last line
    of stdout is a single-line JSON summary.
    """
    try:
        config = load_config(config_dir)
    except ConfigError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(code=1) from error

    key = _api_key()
    try:
        with connect() as connection, EiaClient(key) as client:
            summary = run_poll(connection, client, config)
    except Exception as error:
        typer.echo(f"{type(error).__name__}: {error}", err=True)
        raise typer.Exit(code=1) from error

    for warning in summary.warnings:
        typer.echo(f"warning: {warning}", err=True)
    typer.echo(summary.as_json())


@app.command("sync-zones")
def sync_zones_command(
    config_dir: Annotated[
        Path | None,
        typer.Option("--config-dir", help="Directory holding the YAML config files."),
    ] = None,
) -> None:
    """Upsert the zone registry from zones.yaml into the database.

    Upsert-only: a zone present in the database but absent from the registry is
    reported, never deleted, because observations reference it.
    """
    try:
        config = load_config(config_dir)
    except ConfigError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(code=1) from error

    try:
        with connect() as connection:
            result = sync_zones(connection, config)
            if result.orphaned:
                referenced = zones_with_observations(connection, result.orphaned)
            else:
                referenced = []
            connection.commit()
    except ZoneSyncError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(code=1) from error

    typer.echo(result.summary())
    for key in result.orphaned:
        why = "has observations" if key in referenced else "no observations"
        typer.echo(f"  kept, not in zones.yaml: {key} ({why})", err=True)


migrate = typer.Typer(
    add_completion=False,
    help="Apply or revert the numbered SQL migrations in db/migrations.",
    no_args_is_help=True,
)
app.add_typer(migrate, name="migrate")


@migrate.command("up")
def migrate_up_command() -> None:
    """Apply every migration this database has not yet applied."""
    try:
        with connect() as connection:
            applied = migrate_up(connection)
    except MigrationError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(code=1) from error

    if not applied:
        typer.echo("already up to date")
        return
    for migration in applied:
        typer.echo(f"applied {migration.label}")


@migrate.command("down")
def migrate_down_command(
    steps: Annotated[
        int, typer.Option("--steps", help="How many migrations to revert, newest first.")
    ] = 1,
) -> None:
    """Revert the most recently applied migrations."""
    try:
        with connect() as connection:
            reverted = migrate_down(connection, steps)
    except MigrationError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(code=1) from error

    if not reverted:
        typer.echo("nothing to revert")
        return
    for migration in reverted:
        typer.echo(f"reverted {migration.label}")


@migrate.command("status")
def migrate_status_command() -> None:
    """Show which migrations are applied and which are pending."""
    try:
        with connect() as connection:
            applied = set(applied_versions(connection))
            pending = {m.version for m in pending_migrations(connection)}
            for migration in available_migrations():
                if migration.version in applied:
                    state = "applied"
                elif migration.version in pending:
                    state = "pending"
                else:
                    state = "unknown"
                typer.echo(f"{state:<8} {migration.label}")
    except MigrationError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(code=1) from error
