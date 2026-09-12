"""Scaffold check: the worker packages import and the CLI app is constructed."""

from workers.eia.cli import app


def test_cli_app_exists() -> None:
    assert app.info.help is not None
