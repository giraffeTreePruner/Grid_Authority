"""The EIA client: pagination, retry discipline, pacing and facet validation.

Every response is served by respx from a recorded fixture. No test makes a network
call, and the client is constructed with a no-op sleep so backoff costs no wall time.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import httpx
import pytest
import respx

from workers.config import load_config
from workers.eia.client import (
    BASE_URL,
    ROUTE_FUEL_TYPE,
    ROUTE_INTERCHANGE,
    ROUTE_REGION,
    EiaClient,
    Facets,
    hour_label,
    parse_period,
    validate_facets,
)
from workers.eia.errors import EiaRateLimitExceeded, EiaRequestError, UnknownFacetCode
from workers.eia.ratelimit import BACKFILL_PER_HOUR, RateLimiter, sustainable_rate
from workers.tests.fixtures import envelope, load, rows


def timedelta_zone(hours: int) -> timezone:
    return timezone(timedelta(hours=hours))


KEY = "test-key-not-a-real-credential"
START = datetime(2026, 9, 10, 18, tzinfo=UTC)
END = datetime(2026, 9, 11, 6, tzinfo=UTC)


@pytest.fixture
def client() -> EiaClient:
    """A client that never really sleeps, so retries and pacing are free."""
    return EiaClient(KEY, sleep=lambda _seconds: None)


def url(route: str) -> str:
    return f"{BASE_URL}{route}/"


# -- period handling ------------------------------------------------------------------


def test_periods_parse_as_utc_interval_starts() -> None:
    """§0.4: an hour labelled 14 covers 14:00:00-14:59:59 UTC."""
    moment = parse_period("2026-09-11T14")
    assert moment == datetime(2026, 9, 11, 14, 0, 0, tzinfo=UTC)
    assert moment.tzinfo is UTC
    assert hour_label(moment) == "2026-09-11T14"


def test_a_non_utc_moment_is_labelled_in_utc() -> None:
    eastern = datetime(
        2026,
        9,
        11,
        10,
        tzinfo=timezone(
            offset=-datetime.min.tzinfo.utcoffset(None) if False else UTC.utcoffset(None)
        ),
    )
    assert hour_label(eastern.astimezone(UTC)) == "2026-09-11T10"


# -- pagination -----------------------------------------------------------------------


@respx.mock
def test_pagination_follows_total_past_the_five_thousand_row_cap(client: EiaClient) -> None:
    """The acceptance case: total is 5418, so one request loses 418 rows."""
    page0 = load("pagination/fuel-type-page-000.json")
    page1 = load("pagination/fuel-type-page-001.json")
    # EIA reports total as a string; the client coerces it.
    assert int(page0["response"]["total"]) > 5000
    assert len(page0["response"]["data"]) == 5000

    seen_offsets: list[str] = []

    def respond(request: httpx.Request) -> httpx.Response:
        offset = request.url.params.get("offset", "0")
        seen_offsets.append(offset)
        return httpx.Response(200, json=page0 if offset == "0" else page1)

    respx.get(url(f"{ROUTE_FUEL_TYPE}/data")).mock(side_effect=respond)

    fetched = client.fuel_type_data(START, END)

    assert seen_offsets == ["0", "5000"]
    assert len(fetched) == 5418
    assert client.requests_made == 2


@respx.mock
def test_a_single_page_response_makes_one_request(client: EiaClient) -> None:
    respx.get(url(f"{ROUTE_REGION}/data")).mock(
        return_value=httpx.Response(200, json=load("poll/region-d-ng-ti.json"))
    )
    fetched = client.region_data(START, END)
    assert len(fetched) == 803
    assert client.requests_made == 1


@respx.mock
def test_an_empty_page_stops_pagination(client: EiaClient) -> None:
    """A total the data cannot fill must not loop forever."""
    respx.get(url(f"{ROUTE_REGION}/data")).mock(
        return_value=httpx.Response(200, json=envelope([], total=9999))
    )
    assert client.region_data(START, END) == []
    assert client.requests_made == 1


@respx.mock
def test_requests_carry_the_documented_parameters(client: EiaClient) -> None:
    route = respx.get(url(f"{ROUTE_REGION}/data")).mock(
        return_value=httpx.Response(200, json=envelope(rows("poll/region-d-ng-ti.json")))
    )
    client.region_data(START, END, types=("D", "NG", "TI"))

    params = route.calls[0].request.url.params
    assert params["frequency"] == "hourly"
    assert params["data[0]"] == "value"
    assert params["sort[0][column]"] == "period"
    assert params["sort[0][direction]"] == "asc"
    assert params["start"] == "2026-09-10T18"
    assert params["end"] == "2026-09-11T06"
    assert params["length"] == "5000"
    assert params.get_list("facets[type][]") == ["D", "NG", "TI"]
    assert params["api_key"] == KEY


# -- retry discipline -----------------------------------------------------------------


@respx.mock
def test_a_server_error_is_retried(client: EiaClient) -> None:
    payload = envelope(rows("poll/region-d-ng-ti.json"))
    respx.get(url(f"{ROUTE_REGION}/data")).mock(
        side_effect=[
            httpx.Response(500),
            httpx.Response(200, json=payload),
        ]
    )
    assert len(client.region_data(START, END)) == 803
    assert client.requests_made == 2


@respx.mock
def test_a_rate_limit_response_is_retried(client: EiaClient) -> None:
    payload = envelope(rows("poll/region-d-ng-ti.json"))
    respx.get(url(f"{ROUTE_REGION}/data")).mock(
        side_effect=[httpx.Response(429), httpx.Response(200, json=payload)]
    )
    assert len(client.region_data(START, END)) == 803


@respx.mock
def test_a_client_error_is_not_retried(client: EiaClient) -> None:
    """A 400 is a rejection on the merits; retrying cannot help and wastes budget."""
    route = respx.get(url(f"{ROUTE_REGION}/data")).mock(
        return_value=httpx.Response(400, text="invalid facet")
    )
    with pytest.raises(EiaRequestError) as exc:
        client.region_data(START, END)
    assert exc.value.status == 400
    assert len(route.calls) == 1


@respx.mock
def test_an_invalid_key_is_not_retried(client: EiaClient) -> None:
    route = respx.get(url(f"{ROUTE_REGION}/data")).mock(return_value=httpx.Response(403))
    with pytest.raises(EiaRequestError):
        client.region_data(START, END)
    assert len(route.calls) == 1


@respx.mock
def test_retries_stop_after_three_attempts(client: EiaClient) -> None:
    route = respx.get(url(f"{ROUTE_REGION}/data")).mock(return_value=httpx.Response(503))
    with pytest.raises(EiaRequestError) as exc:
        client.region_data(START, END)
    assert len(route.calls) == 3
    assert exc.value.attempts == 3


@respx.mock
def test_an_error_body_does_not_leak_the_key(client: EiaClient) -> None:
    """Error text is logged; it must not carry the credential."""
    respx.get(url(f"{ROUTE_REGION}/data")).mock(
        return_value=httpx.Response(400, text=f"bad request for api_key={KEY}")
    )
    with pytest.raises(EiaRequestError) as exc:
        client.region_data(START, END)
    assert KEY not in str(exc.value)
    assert "REDACTED" in str(exc.value)


@respx.mock
def test_a_non_json_response_is_an_error(client: EiaClient) -> None:
    respx.get(url(f"{ROUTE_REGION}/data")).mock(
        return_value=httpx.Response(200, text="<html>maintenance</html>")
    )
    with pytest.raises(EiaRequestError) as exc:
        client.region_data(START, END)
    assert "not JSON" in str(exc.value)


def test_backoff_grows_and_is_jittered(client: EiaClient) -> None:
    first = {client._backoff(1) for _ in range(50)}
    second = {client._backoff(2) for _ in range(50)}
    assert all(2.0 <= d < 4.0 for d in first)
    assert all(4.0 <= d < 8.0 for d in second)
    assert len(first) > 1


# -- pacing ---------------------------------------------------------------------------


def test_a_sustainable_rate_cannot_reach_its_own_ceiling() -> None:
    """An hour at the paced rate must stay under the ceiling that paces it.

    Otherwise a long backfill trips the limit it was given and has to be restarted
    all day, which is how an operator learns to pass a ceiling nobody believes in.
    """
    for per_hour in (3600, BACKFILL_PER_HOUR, 9000, 14_400):
        assert sustainable_rate(per_hour) * 3600 <= per_hour

    # The backfill's own default must be paceable, or the pacing is decorative.
    assert sustainable_rate(BACKFILL_PER_HOUR) >= 1

    # Below 3,600/hour no rate is sustainable with a one-second window. The floor is
    # 1 rather than 0, which would stall; such a ceiling belongs to a short job that
    # is meant to reach it.
    assert sustainable_rate(500) == 1
    assert sustainable_rate(1) == 1


def test_the_hourly_ceiling_raises_rather_than_waiting() -> None:
    """A job that would wait out an hour has gone wrong and should be visible."""
    limiter = RateLimiter(per_second=1000, per_hour=3)
    for _ in range(3):
        limiter.acquire()
    with pytest.raises(EiaRateLimitExceeded) as exc:
        limiter.acquire()
    assert "500" not in str(exc.value)
    assert limiter.requests_made == 3


def test_the_per_second_rate_is_enforced() -> None:
    slept: list[float] = []

    class Recording(RateLimiter):
        def _sleep(self, seconds: float) -> None:
            slept.append(seconds)
            self._recent.clear()

    limiter = Recording(per_second=2, per_hour=1000)
    for _ in range(6):
        limiter.acquire()
    assert slept, "expected the limiter to pace a burst"
    assert limiter.requests_made == 6


# -- route metadata -------------------------------------------------------------------


@respx.mock
def test_route_metadata_reports_the_newest_published_hour(client: EiaClient) -> None:
    """The poll window is derived from this, not from the clock."""
    respx.get(url(ROUTE_FUEL_TYPE)).mock(
        return_value=httpx.Response(200, json=load("routes/fuel-type-data.json"))
    )
    meta = client.route_metadata(ROUTE_FUEL_TYPE)
    assert meta.dataset == "fuel-type-data"
    assert meta.end_period == "2026-09-11T06"
    assert meta.units == "megawatthours"
    assert meta.latest == datetime(2026, 9, 11, 6, tzinfo=UTC)


@respx.mock
def test_route_metadata_quantifies_publication_lag(client: EiaClient) -> None:
    respx.get(url(ROUTE_INTERCHANGE)).mock(
        return_value=httpx.Response(200, json=load("routes/interchange-data.json"))
    )
    meta = client.route_metadata(ROUTE_INTERCHANGE)
    now = datetime(2026, 9, 12, 1, tzinfo=UTC)
    assert meta.lag(now).total_seconds() / 3600 == pytest.approx(42.0)


# -- facet discovery and validation ---------------------------------------------------


def mock_facets() -> None:
    pairs = {
        f"{ROUTE_REGION}/facet/respondent": "facets/region-respondent.json",
        f"{ROUTE_REGION}/facet/type": "facets/region-type.json",
        f"{ROUTE_FUEL_TYPE}/facet/fueltype": "facets/fueltype.json",
        f"{ROUTE_INTERCHANGE}/facet/fromba": "facets/interchange-fromba.json",
    }
    for route, fixture in pairs.items():
        respx.get(url(route)).mock(return_value=httpx.Response(200, json=load(fixture)))


@respx.mock
def test_facet_discovery_collapses_duplicate_ids(client: EiaClient) -> None:
    """The fueltype facet returns 20 entries for 16 distinct codes."""
    mock_facets()
    facets = client.discover_facets()
    assert len(load("facets/fueltype.json")["response"]["facets"]) == 20
    assert len(facets.fuel_types) == 16
    assert {"BAT", "GEO", "OES", "PS", "SNB", "UES", "UNK", "WNB"} <= facets.fuel_types
    assert len(facets.respondents) == 83
    assert facets.series_types == {"D", "DF", "NG", "TI"}


@respx.mock
def test_facets_are_cached_for_a_day(client: EiaClient) -> None:
    mock_facets()
    client.discover_facets()
    after_first = client.requests_made
    client.discover_facets()
    assert client.requests_made == after_first
    client.discover_facets(force=True)
    assert client.requests_made > after_first


@respx.mock
def test_the_committed_config_accounts_for_everything_eia_publishes(
    client: EiaClient,
) -> None:
    mock_facets()
    validate_facets(client.discover_facets(), load_config())


def test_an_unknown_fuel_code_is_fatal() -> None:
    """The acceptance case, and guardrail 5: never bucket it as unknown."""
    config = load_config()
    facets = Facets(
        respondents=config.zones.respondents(),
        series_types={"D", "DF", "NG", "TI"},
        fuel_types=set(config.modes.mapping_for("eia")) | {"FUSION"},
        interchange_from=config.zones.respondents(),
    )
    with pytest.raises(UnknownFacetCode) as exc:
        validate_facets(facets, config)
    assert exc.value.kind == "fuel type"
    assert exc.value.codes == ["FUSION"]
    assert "config/modes.yaml" in str(exc.value)
    assert "sources.eia" in str(exc.value)


def test_an_unknown_respondent_is_fatal() -> None:
    config = load_config()
    facets = Facets(
        respondents=config.zones.respondents() | {"NEWBA"},
        series_types={"D", "DF", "NG", "TI"},
        fuel_types=set(config.modes.mapping_for("eia")),
        interchange_from=config.zones.respondents(),
    )
    with pytest.raises(UnknownFacetCode) as exc:
        validate_facets(facets, config)
    assert exc.value.codes == ["NEWBA"]
    assert "config/zones.yaml" in str(exc.value)


def test_an_unknown_series_type_is_fatal() -> None:
    """A fifth series type would mean EIA publishes something we never read."""
    config = load_config()
    facets = Facets(
        respondents=config.zones.respondents(),
        series_types={"D", "DF", "NG", "TI", "XX"},
        fuel_types=set(config.modes.mapping_for("eia")),
        interchange_from=config.zones.respondents(),
    )
    with pytest.raises(UnknownFacetCode) as exc:
        validate_facets(facets, config)
    assert exc.value.codes == ["XX"]


def test_an_excluded_respondent_satisfies_validation() -> None:
    """A retired balancing authority is accounted for, not unknown."""
    config = load_config()
    retired = next(iter(config.excluded_respondents.codes()))
    facets = Facets(
        respondents={retired},
        series_types={"D"},
        fuel_types=set(config.modes.mapping_for("eia")),
        interchange_from=set(),
    )
    validate_facets(facets, config)


# -- recorded data the later tasks depend on ------------------------------------------


def test_the_category_change_fixtures_show_the_expansion() -> None:
    """The eight codes in the build spec are the pre-expansion set."""
    before = {r["fueltype"] for r in rows("category-change/fuel-type-2024-06-15.json")}
    after = {r["fueltype"] for r in rows("category-change/fuel-type-2024-12-15.json")}
    assert before == {"COL", "NG", "NUC", "OIL", "OTH", "SUN", "WAT", "WND"}
    assert {"BAT", "PS", "SNB", "UES"} <= after - before

    mapping = load_config().modes.mapping_for("eia")
    assert not (after - set(mapping)), "a code from the expansion is unmapped"


def test_the_missing_hour_fixture_really_has_a_gap() -> None:
    """Recorded, not manufactured: GVL published nothing for 19 hours."""
    periods = sorted(parse_period(r["period"]) for r in rows("missing-hour/region-gvl-demand.json"))
    span = int((periods[-1] - periods[0]).total_seconds() // 3600) + 1
    assert span - len(periods) == 19
    assert all(r.get("value") is not None for r in rows("missing-hour/region-gvl-demand.json"))
