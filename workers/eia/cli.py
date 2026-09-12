"""Command-line entry point for the EIA ingest workers.

Each subcommand is a standalone job: it exits 0 on success, non-zero on failure,
and prints a single-line JSON summary as its last line of stdout.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Annotated

import typer

from workers.config import ConfigError, load_config

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
