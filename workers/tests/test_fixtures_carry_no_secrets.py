"""No committed fixture may carry a credential.

The repository is public and the EIA key travels as a query parameter, which the API
echoes back in every response. The capture script replaces the key with REDACTED before
writing, but that only protects the key it was given: EIA has been observed returning a
cached route-metadata response still carrying a *different* caller's api_key. This test
is the backstop, and it runs over whatever is actually committed.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures"

# Long unbroken alphanumeric runs. EIA's own prose and identifiers contain spaces,
# hyphens or slashes, so anything matching this is a token rather than content.
KEY_SHAPED = re.compile(r"[A-Za-z0-9]{20,}")
ALLOWED = {"REDACTED"}


def fixture_files() -> list[Path]:
    return sorted(FIXTURES.rglob("*.json"))


def test_there_are_fixtures_to_check() -> None:
    assert fixture_files(), "no fixtures found; this test would pass vacuously"


@pytest.mark.parametrize("path", fixture_files(), ids=lambda p: str(p.name))
def test_fixture_carries_no_credential(path: Path) -> None:
    found = {m for m in KEY_SHAPED.findall(path.read_text(encoding="utf-8"))} - ALLOWED
    assert not found, (
        f"{path.relative_to(FIXTURES)} contains {len(found)} key-shaped string(s). "
        "Replace the value with REDACTED before committing."
    )


@pytest.mark.parametrize("path", fixture_files(), ids=lambda p: str(p.name))
def test_echoed_api_key_is_redacted(path: Path) -> None:
    """The API echoes request parameters, so api_key is present in every response."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    params = payload.get("request", {}).get("params", {})
    if "api_key" in params:
        assert params["api_key"] == "REDACTED"
