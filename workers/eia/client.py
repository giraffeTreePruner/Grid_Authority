"""Client for the EIA v2 API.

Three things this class refuses to do quietly, because each would corrupt the data
rather than break it:

- Assume one response is complete. Every data request is paginated to `total`.
- Retry a request the server rejected on its merits. Only 429 and 5xx are retried.
- Accept a facet code configuration does not know. An unrecognised code is fatal.
"""

from __future__ import annotations

import random
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from workers.config import AppConfig
from workers.eia.errors import EiaRequestError, UnknownFacetCode
from workers.eia.ratelimit import RateLimiter

BASE_URL = "https://api.eia.gov/v2/"
PAGE_SIZE = 5000
TIMEOUT_SECONDS = 30.0
MAX_ATTEMPTS = 3
BACKOFF_BASE_SECONDS = 2.0
FACET_CACHE_SECONDS = 24 * 3600

ROUTE_REGION = "electricity/rto/region-data"
ROUTE_FUEL_TYPE = "electricity/rto/fuel-type-data"
ROUTE_INTERCHANGE = "electricity/rto/interchange-data"

DATASETS = (ROUTE_REGION, ROUTE_FUEL_TYPE, ROUTE_INTERCHANGE)

SERIES_TYPES = ("D", "DF", "NG", "TI")


def hour_label(moment: datetime) -> str:
    """EIA's hourly period format, always UTC."""
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H")


def parse_period(period: str) -> datetime:
    """Parse an hourly period as a UTC interval start.

    §0.4: normalise at the parser boundary and never downstream. An hour labelled
    2026-09-11T14 covers 14:00:00 to 14:59:59 UTC.
    """
    return datetime.strptime(period, "%Y-%m-%dT%H").replace(tzinfo=UTC)


@dataclass
class RouteMetadata:
    """What a dataset says about itself."""

    dataset: str
    start_period: str
    end_period: str
    units: str | None

    @property
    def latest(self) -> datetime:
        return parse_period(self.end_period)

    def lag(self, now: datetime) -> timedelta:
        return now - self.latest


@dataclass
class Facets:
    """Code lists discovered from the facet endpoints."""

    respondents: set[str] = field(default_factory=set)
    series_types: set[str] = field(default_factory=set)
    fuel_types: set[str] = field(default_factory=set)
    interchange_from: set[str] = field(default_factory=set)
    discovered_at: float = 0.0

    def stale(self, now: float, ttl: float = FACET_CACHE_SECONDS) -> bool:
        return now - self.discovered_at >= ttl


class EiaClient:
    """Paginating, rate-limited, retrying client for the EIA v2 API."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = BASE_URL,
        client: httpx.Client | None = None,
        limiter: RateLimiter | None = None,
        sleep: Any = time.sleep,
    ) -> None:
        if not api_key:
            raise ValueError("an EIA API key is required")
        self.api_key = api_key
        self.base_url = base_url
        self.limiter = limiter or RateLimiter()
        self._sleep = sleep
        self._client = client or httpx.Client(timeout=TIMEOUT_SECONDS)
        self._owns_client = client is None
        self._facets: Facets | None = None

    def __enter__(self) -> EiaClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    @property
    def requests_made(self) -> int:
        return self.limiter.requests_made

    # -- transport ------------------------------------------------------------------

    def _get(self, route: str, params: dict[str, Any]) -> dict[str, Any]:
        """One request, retried only where retrying can help."""
        url = f"{self.base_url}{route.strip('/')}/"
        query: list[tuple[str, str | int | float | bool | None]] = [("api_key", self.api_key)]
        for name, value in params.items():
            if isinstance(value, (list, tuple)):
                query.extend((name, str(item)) for item in value)
            else:
                query.append((name, str(value)))

        last: str = ""
        for attempt in range(1, MAX_ATTEMPTS + 1):
            self.limiter.acquire()
            try:
                response = self._client.get(url, params=query)
            except httpx.TimeoutException as error:
                last = f"timed out after {TIMEOUT_SECONDS:.0f}s: {error}"
            except httpx.HTTPError as error:
                last = f"transport error: {error}"
            else:
                if response.status_code == 200:
                    return self._decode(route, response)
                # A 4xx other than 429 is a rejection on the merits. Retrying it
                # wastes the budget and cannot succeed.
                if response.status_code != 429 and response.status_code < 500:
                    raise EiaRequestError(
                        f"{route}: HTTP {response.status_code}: "
                        f"{self._redact(response.text)[:300]}",
                        status=response.status_code,
                        attempts=attempt,
                    )
                last = f"HTTP {response.status_code}"

            if attempt < MAX_ATTEMPTS:
                self._sleep(self._backoff(attempt))

        raise EiaRequestError(
            f"{route}: gave up after {MAX_ATTEMPTS} attempts ({last})",
            attempts=MAX_ATTEMPTS,
        )

    def _decode(self, route: str, response: httpx.Response) -> dict[str, Any]:
        try:
            payload = response.json()
        except ValueError as error:
            raise EiaRequestError(f"{route}: response was not JSON: {error}") from error
        if not isinstance(payload, dict) or "response" not in payload:
            raise EiaRequestError(f"{route}: response envelope is missing a 'response' object")
        return payload

    def _backoff(self, attempt: int) -> float:
        """Exponential backoff with jitter, starting at two seconds."""
        jitter: float = random.random()
        delay: float = BACKOFF_BASE_SECONDS * (2.0 ** (attempt - 1)) * (1.0 + jitter)
        return delay

    def _redact(self, text: str) -> str:
        return text.replace(self.api_key, "REDACTED")

    # -- reading --------------------------------------------------------------------

    def route_metadata(self, dataset: str) -> RouteMetadata:
        """What a dataset reports about its own coverage.

        `endPeriod` is the newest hour the dataset holds. The poll window is derived
        from it rather than from the clock: fuel-type and interchange run many hours
        behind, and a window ending at `now` returns nothing at all for them.
        """
        payload = self._get(dataset, {})
        body = payload["response"]
        units = None
        data = body.get("data")
        if isinstance(data, dict):
            value = data.get("value")
            if isinstance(value, dict):
                units = value.get("units")
        return RouteMetadata(
            dataset=body.get("id", dataset),
            start_period=body.get("startPeriod", ""),
            end_period=body.get("endPeriod", ""),
            units=units,
        )

    def facet_values(self, dataset: str, facet: str) -> set[str]:
        """Distinct codes from a facet endpoint.

        The fueltype facet returns some ids twice under different labels, so this
        collapses to a set rather than trusting the response to be unique.
        """
        payload = self._get(f"{dataset}/facet/{facet}", {})
        body = payload["response"]
        entries = body.get("facets")
        if not isinstance(entries, list):
            entries = body.get("data") if isinstance(body.get("data"), list) else []
        return {entry["id"] for entry in entries if isinstance(entry, dict) and "id" in entry}

    def discover_facets(self, *, force: bool = False) -> Facets:
        """Fetch and cache the code lists for 24 hours."""
        now = time.monotonic()
        if self._facets is not None and not force and not self._facets.stale(now):
            return self._facets

        facets = Facets(
            respondents=self.facet_values(ROUTE_REGION, "respondent"),
            series_types=self.facet_values(ROUTE_REGION, "type"),
            fuel_types=self.facet_values(ROUTE_FUEL_TYPE, "fueltype"),
            interchange_from=self.facet_values(ROUTE_INTERCHANGE, "fromba"),
            discovered_at=now,
        )
        self._facets = facets
        return facets

    def iter_rows(self, route: str, params: dict[str, Any]) -> Iterator[dict[str, Any]]:
        """Every row for a query, following pagination to `total`.

        EIA caps a response at 5,000 rows whatever length is requested, so a single
        request is never assumed to be the whole answer.
        """
        offset = 0
        total: int | None = None
        seen = 0

        while True:
            payload = self._get(route, {**params, "offset": offset, "length": PAGE_SIZE})
            body = payload["response"]

            if total is None:
                raw_total = body.get("total")
                total = int(raw_total) if raw_total is not None else 0

            rows = body.get("data")
            if not isinstance(rows, list):
                raise EiaRequestError(f"{route}: response.data is not a list of rows")

            yield from rows
            seen += len(rows)

            # An empty page with rows outstanding would otherwise loop forever.
            if not rows or seen >= total:
                break
            offset += PAGE_SIZE

    def fetch_rows(self, route: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        return list(self.iter_rows(route, params))

    # -- queries --------------------------------------------------------------------

    def region_data(
        self, start: datetime, end: datetime, types: tuple[str, ...] = ("D", "NG", "TI")
    ) -> list[dict[str, Any]]:
        return self.fetch_rows(
            f"{ROUTE_REGION}/data",
            _data_params(start, end, **{"facets[type][]": list(types)}),
        )

    def fuel_type_data(self, start: datetime, end: datetime) -> list[dict[str, Any]]:
        return self.fetch_rows(f"{ROUTE_FUEL_TYPE}/data", _data_params(start, end))

    def interchange_data(self, start: datetime, end: datetime) -> list[dict[str, Any]]:
        return self.fetch_rows(f"{ROUTE_INTERCHANGE}/data", _data_params(start, end))


def _data_params(start: datetime, end: datetime, **extra: Any) -> dict[str, Any]:
    """Parameters shared by every hourly data request."""
    return {
        "frequency": "hourly",
        "data[0]": "value",
        "sort[0][column]": "period",
        "sort[0][direction]": "asc",
        "start": hour_label(start),
        "end": hour_label(end),
        **extra,
    }


def validate_facets(facets: Facets, config: AppConfig) -> None:
    """Fail on any code configuration does not account for.

    §5.2: this is what turns the next category expansion into a loud startup failure
    instead of a fuel silently vanishing from a zone's generation mix.
    """
    accounted = config.zones.respondents() | config.excluded_respondents.codes()
    unknown_respondents = sorted(facets.respondents - accounted)
    if unknown_respondents:
        raise UnknownFacetCode(
            "respondent", unknown_respondents, "config/zones.yaml", "a zone entry"
        )

    mapped = set(config.modes.mapping_for("eia"))
    unknown_fuels = sorted(facets.fuel_types - mapped)
    if unknown_fuels:
        raise UnknownFacetCode("fuel type", unknown_fuels, "config/modes.yaml", "sources.eia")

    unknown_types = sorted(facets.series_types - set(SERIES_TYPES))
    if unknown_types:
        raise UnknownFacetCode(
            "series type", unknown_types, "workers/eia/client.py", "SERIES_TYPES"
        )

    unknown_reporters = sorted(facets.interchange_from - accounted)
    if unknown_reporters:
        raise UnknownFacetCode(
            "interchange respondent", unknown_reporters, "config/zones.yaml", "a zone entry"
        )
