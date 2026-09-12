"""Access to the recorded EIA responses in tests/fixtures/eia.

No test makes a network call. These files are the only EIA data the suite sees.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "eia"


def load(relative: str) -> dict[str, Any]:
    """One recorded response, exactly as committed."""
    payload = json.loads((FIXTURE_DIR / relative).read_text(encoding="utf-8"))
    assert isinstance(payload, dict)
    return payload


def rows(relative: str) -> list[dict[str, Any]]:
    data = load(relative)["response"]["data"]
    assert isinstance(data, list)
    return data


def envelope(data: list[dict[str, Any]], total: int | None = None) -> dict[str, Any]:
    """Wrap rows in the API's response envelope.

    Used to build a page that no capture contains, such as the second half of a
    paginated sequence, without inventing row content.
    """
    return {
        "response": {"total": total if total is not None else len(data), "data": data},
        "request": {"params": {"api_key": "REDACTED"}},
        "apiVersion": "2.1.8",
    }
