"""Warming the zone-detail cache.

The API computes a bucketed window on first request and stores it. That makes the second
reader fast and leaves the first one waiting — and for a large zone over seven years the
first one waits past the statement timeout and gets an error instead of a panel.

So something else asks first. This walks every in-map zone and every bucketed window and
requests it from the local API, which computes and stores each document as a side effect
of answering. Nothing here knows how a document is built: there is one implementation of
that, in the route, and this only causes it to run. Two implementations of the same
query would eventually disagree, and the disagreement would show as a panel that changes
its numbers depending on whether the cache was warm.

Failures are counted, not fatal. A warm cache is an optimisation — if a zone cannot be
warmed the site still works, more slowly, and the next run tries again.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field

import httpx

from workers.config import AppConfig

JOB = "warm-zone-detail"

#: Windows the API caches. The hourly ones are fast and deliberately not cached.
BUCKETED_WINDOWS = ("30d", "90d", "1y", "all")

#: Long enough for a cold `all` on the largest zone, which is the case being fixed.
REQUEST_TIMEOUT_S = 30.0

#: Seconds between requests.
#:
#: The API limits a client to 60 requests a minute and this job is a client like any
#: other. Sent as fast as they can be issued, 208 requests finish in under a second and
#: three quarters of them come back 429 — which is the limiter working correctly and the
#: job being wrong about it.
#:
#: Not exempted for loopback, deliberately. `trustProxy` is on, so the address the
#: limiter counts comes from a forwarded header, and an allowlist entry for 127.0.0.1
#: would be a rate-limit bypass for anyone willing to claim that address.
#:
#: 1.2s keeps a full pass at roughly 50 requests a minute. It takes about four minutes,
#: which is nothing for an hourly job whose whole purpose is to be early.
PACE_SECONDS = 1.2


@dataclass
class WarmSummary:
    """What a warming run did."""

    job: str = JOB
    requested: int = 0
    warmed: int = 0
    failed: int = 0
    duration_s: float = 0.0
    warnings: list[str] = field(default_factory=list)

    def as_json(self) -> str:
        return json.dumps(
            {
                "job": self.job,
                "requested": self.requested,
                "warmed": self.warmed,
                "failed": self.failed,
                "duration_s": round(self.duration_s, 3),
                "warnings": self.warnings,
            },
            separators=(",", ":"),
        )


def warm_zone_detail(
    config: AppConfig,
    base_url: str,
    *,
    client: httpx.Client | None = None,
    pace_seconds: float = PACE_SECONDS,
    sleep: Callable[[float], None] = time.sleep,
) -> WarmSummary:
    """Request every bucketed window for every in-map zone, paced under the API's limit."""
    started = time.monotonic()
    summary = WarmSummary()
    first = True

    owned = client is None
    http = client or httpx.Client(timeout=REQUEST_TIMEOUT_S)

    try:
        for zone in config.zones.in_map():
            for window in BUCKETED_WINDOWS:
                # Paced between requests, not before the first: a run should not sit
                # idle for a second before doing anything.
                if not first and pace_seconds > 0:
                    sleep(pace_seconds)
                first = False

                summary.requested += 1
                url = f"{base_url.rstrip('/')}/api/v1/zones/{zone.key}"
                try:
                    response = http.get(url, params={"window": window})
                except httpx.HTTPError as error:
                    summary.failed += 1
                    summary.warnings.append(f"{zone.key} {window}: {type(error).__name__}")
                    continue

                if response.status_code == 200:
                    summary.warmed += 1
                else:
                    summary.failed += 1
                    summary.warnings.append(f"{zone.key} {window}: HTTP {response.status_code}")
    finally:
        if owned:
            http.close()

    summary.duration_s = time.monotonic() - started
    # Kept short: one line per failure would bury the summary when the API is down.
    if len(summary.warnings) > 10:
        extra = len(summary.warnings) - 10
        summary.warnings = [*summary.warnings[:10], f"and {extra} more"]
    return summary
