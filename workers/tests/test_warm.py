"""Warming the zone-detail cache.

The job's whole purpose is that a reader is never the one who computes a cold `all`
window, so what matters is that it asks for every combination and that a failure to warm
is not a failure of the run.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from workers.config import load_config
from workers.eia.warm import BUCKETED_WINDOWS, PACE_SECONDS, warm_zone_detail

CONFIG = load_config()
BASE = "http://127.0.0.1:3000"


@respx.mock
def test_every_in_map_zone_and_bucketed_window_is_requested() -> None:
    route = respx.get(url__startswith=f"{BASE}/api/v1/zones/").mock(
        return_value=httpx.Response(200, json={})
    )

    summary = warm_zone_detail(CONFIG, BASE, sleep=lambda _s: None)

    expected = len(CONFIG.zones.in_map()) * len(BUCKETED_WINDOWS)
    assert summary.requested == expected
    assert summary.warmed == expected
    assert summary.failed == 0
    assert route.call_count == expected


@respx.mock
def test_only_the_bucketed_windows_are_asked_for() -> None:
    """The hourly windows are fast and change every poll; caching them buys nothing."""
    route = respx.get(url__startswith=f"{BASE}/api/v1/zones/").mock(
        return_value=httpx.Response(200, json={})
    )

    warm_zone_detail(CONFIG, BASE, sleep=lambda _s: None)

    asked = {call.request.url.params["window"] for call in route.calls}
    assert asked == set(BUCKETED_WINDOWS)
    assert "24h" not in asked and "168h" not in asked


@respx.mock
def test_one_failing_zone_does_not_stop_the_rest() -> None:
    """A warm cache is an optimisation. One zone failing must not abandon the others."""
    zones = [zone.key for zone in CONFIG.zones.in_map()]
    respx.get(url__startswith=f"{BASE}/api/v1/zones/{zones[0]}").mock(
        return_value=httpx.Response(503)
    )
    respx.get(url__startswith=f"{BASE}/api/v1/zones/").mock(
        return_value=httpx.Response(200, json={})
    )

    summary = warm_zone_detail(CONFIG, BASE, sleep=lambda _s: None)

    assert summary.failed == len(BUCKETED_WINDOWS)
    assert summary.warmed == summary.requested - summary.failed
    assert summary.warmed > 0


@respx.mock
def test_a_transport_error_is_counted_rather_than_raised() -> None:
    """The API being down is a reason to try again later, not to crash the scheduler."""
    respx.get(url__startswith=f"{BASE}/api/v1/zones/").mock(
        side_effect=httpx.ConnectError("refused")
    )

    summary = warm_zone_detail(CONFIG, BASE, sleep=lambda _s: None)

    assert summary.warmed == 0
    assert summary.failed == summary.requested
    assert summary.warnings


@respx.mock
def test_warnings_are_summarised_rather_than_listed_in_full() -> None:
    """Every zone failing would otherwise bury the summary under two hundred lines."""
    respx.get(url__startswith=f"{BASE}/api/v1/zones/").mock(return_value=httpx.Response(500))

    summary = warm_zone_detail(CONFIG, BASE, sleep=lambda _s: None)

    assert len(summary.warnings) == 11
    assert summary.warnings[-1].startswith("and ")


@respx.mock
def test_the_summary_is_one_line_of_json() -> None:
    respx.get(url__startswith=f"{BASE}/api/v1/zones/").mock(
        return_value=httpx.Response(200, json={})
    )

    line = warm_zone_detail(CONFIG, BASE, sleep=lambda _s: None).as_json()

    assert "\n" not in line
    assert '"job":"warm-zone-detail"' in line


def test_in_map_zones_are_what_gets_warmed() -> None:
    """Off-map zones have no panel to open, so warming them would be work for nobody."""
    assert CONFIG.zones.in_map()
    assert len(CONFIG.zones.in_map()) < len(CONFIG.zones.zones)


@pytest.mark.parametrize("window", BUCKETED_WINDOWS)
def test_each_window_is_one_the_api_caches(window: str) -> None:
    """Asking for a window the API will not cache would warm nothing at all."""
    assert window in {"30d", "90d", "1y", "all"}


def test_the_run_is_paced_under_the_api_rate_limit() -> None:
    """Found by running it: 208 requests at full speed, 150 of them answered 429.

    The API allows 60 requests a minute and this job is a client like any other. The
    limiter was right and the job was wrong about it.
    """
    assert PACE_SECONDS > 0
    # A full pass must stay under 60 requests per minute.
    per_minute = 60 / PACE_SECONDS
    assert per_minute < 60


@respx.mock
def test_it_waits_between_requests_but_not_before_the_first() -> None:
    respx.get(url__startswith=f"{BASE}/api/v1/zones/").mock(
        return_value=httpx.Response(200, json={})
    )
    waits: list[float] = []

    summary = warm_zone_detail(CONFIG, BASE, pace_seconds=0.5, sleep=waits.append)

    # One wait between each pair, and none before the first request.
    assert len(waits) == summary.requested - 1
    assert all(wait == 0.5 for wait in waits)
