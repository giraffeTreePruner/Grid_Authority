"""Command-line entry point for the EIA ingest workers.

Each subcommand is a standalone job: it exits 0 on success, non-zero on failure,
and prints a single-line JSON summary as its last line of stdout.
"""

from __future__ import annotations

import typer

app = typer.Typer(
    add_completion=False,
    help="EIA-930 ingest jobs for Grid Authority.",
    no_args_is_help=True,
)


def main() -> None:
    """Console-script entry point."""
    app()


if __name__ == "__main__":
    main()
