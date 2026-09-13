"""Client-side request pacing.

EIA's published guidance is roughly 9,000 requests an hour and 5 a second. The default
ceiling here is an order of magnitude under that, deliberately: staying far below costs
nothing at the volume the recurring jobs need, and it turns a runaway loop into a loud
failure rather than a ban.

The ceiling is a default, not a law. A backfill covering years legitimately needs more
requests than it allows — about 17,000 for the full EIA-930 history — and a limit a
correct job cannot satisfy only teaches an operator to ignore it. `BACKFILL_PER_HOUR`
is the raised figure for that case, still comfortably under EIA's guidance.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field

from workers.eia.errors import EiaRateLimitExceeded

MAX_REQUESTS_PER_SECOND = 4
MAX_REQUESTS_PER_HOUR = 500

# For the one-off backfill, which is bounded by the days it was asked for rather than
# by a loop that could run away. Half of EIA's published guidance.
BACKFILL_PER_HOUR = 4500


@dataclass
class RateLimiter:
    """Paces requests to a rate, and refuses to exceed an hourly ceiling.

    The ceiling raises rather than sleeps: a job that would need to wait out an hour
    has gone wrong, and should fail where an operator can see it.
    """

    per_second: int = MAX_REQUESTS_PER_SECOND
    per_hour: int = MAX_REQUESTS_PER_HOUR
    _recent: deque[float] = field(default_factory=deque, repr=False)
    _hourly: deque[float] = field(default_factory=deque, repr=False)
    requests_made: int = 0

    def _now(self) -> float:
        return time.monotonic()

    def _sleep(self, seconds: float) -> None:
        time.sleep(seconds)

    def acquire(self) -> None:
        """Block until another request may be sent."""
        now = self._now()

        while self._hourly and now - self._hourly[0] >= 3600:
            self._hourly.popleft()
        if len(self._hourly) >= self.per_hour:
            oldest = self._hourly[0]
            raise EiaRateLimitExceeded(
                f"client-side ceiling of {self.per_hour} requests/hour reached "
                f"({len(self._hourly)} in the last hour, oldest "
                f"{now - oldest:.0f}s ago). A job is looping or a window is far "
                "larger than intended."
            )

        while True:
            now = self._now()
            while self._recent and now - self._recent[0] >= 1.0:
                self._recent.popleft()
            if len(self._recent) < self.per_second:
                break
            self._sleep(1.0 - (now - self._recent[0]))

        stamp = self._now()
        self._recent.append(stamp)
        self._hourly.append(stamp)
        self.requests_made += 1
