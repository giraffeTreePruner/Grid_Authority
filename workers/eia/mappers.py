"""Map EIA rows onto the canonical shapes stored in the database.

Three rules run through everything here:

- **Nothing is fabricated.** A value EIA did not publish stays `None`. There is no
  interpolation, no forward-fill, and no zero standing in for a missing measurement.
- **Codes are summed, never overwritten.** Four EIA fuel codes share a canonical mode
  with another (`OTH`/`UNK`, `UES`/`OES`, `WND`/`WNB`, `SUN`/`SNB`). Assigning instead
  of adding would silently discard roughly half of some zones' wind and solar.
- **An unrecognised code is fatal.** Startup validation should already have caught it,
  but a code can appear in data between facet refreshes, and bucketing it as `unknown`
  is exactly the silent distortion this project cannot tolerate.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from workers.config import AppConfig, ModesConfig
from workers.eia.client import parse_period
from workers.eia.errors import UnknownFacetCode

SOURCE = "eia"
FORECAST_MODEL = "eia_df"
FORECAST_METRIC = "demand"

# EIA publishes hourly data directly, so an hour is one interval and never an
# aggregation of finer ones. MVP 2's sub-hourly sources are what these columns exist for.
INTERVALS_PER_HOUR = 1


class MappingError(RuntimeError):
    """A row cannot be mapped onto a canonical shape."""


@dataclass
class RegionObservation:
    """One zone-hour of demand, net generation and total interchange."""

    zone_key: str
    period_utc: datetime
    demand_mw: Decimal | None = None
    net_generation_mw: Decimal | None = None
    total_interchange_mw: Decimal | None = None
    source: str = SOURCE


@dataclass
class MixObservation:
    """One zone-hour of generation by mode, with shares derived on write."""

    zone_key: str
    period_utc: datetime
    modes: dict[str, Decimal] = field(default_factory=dict)
    total_generation_mw: Decimal | None = None
    renewable_share: Decimal | None = None
    low_carbon_share: Decimal | None = None
    raw: dict[str, Any] = field(default_factory=dict)
    aggregated: bool = False
    n_intervals: int = INTERVALS_PER_HOUR
    expected_intervals: int = INTERVALS_PER_HOUR
    source: str = SOURCE


@dataclass
class InterchangeObservation:
    """One directed hourly flow between a zone and a counterparty."""

    from_zone: str
    to_zone: str
    period_utc: datetime
    mw: Decimal | None = None
    source: str = SOURCE


@dataclass
class ForecastIssue:
    """One forecast value as it stood at one moment."""

    zone_key: str
    issue_time_utc: datetime
    target_time_utc: datetime
    value: Decimal | None
    source: str = SOURCE
    model: str = FORECAST_MODEL
    metric: str = FORECAST_METRIC


def parse_value(raw: Any) -> Decimal | None:
    """Parse a published value.

    EIA sends numbers as strings. Absent, null and empty all mean "not published",
    which is `None` and stays `None`.
    """
    if raw is None:
        return None
    if isinstance(raw, Decimal):
        return raw
    text = str(raw).strip()
    if not text:
        return None
    try:
        return Decimal(text)
    except InvalidOperation as error:
        raise MappingError(f"{raw!r} is not a number") from error


def current_hour(now: datetime | None = None) -> datetime:
    """The UTC hour in progress right now."""
    moment = now or datetime.now(UTC)
    return moment.astimezone(UTC).replace(minute=0, second=0, microsecond=0)


def is_complete_hour(period: datetime, now: datetime | None = None) -> bool:
    """Whether an hour has finished.

    §7.1: the hour in progress is never written as complete. Its values are partial
    and would be indistinguishable from a genuine dip in demand.
    """
    return period < current_hour(now)


def zone_for(config: AppConfig, respondent: str) -> str | None:
    """The zone key for a respondent, or None if it is deliberately excluded."""
    zone = config.zones.by_respondent(respondent)
    if zone is not None:
        return zone.key
    if respondent in config.excluded_respondents.codes():
        return None
    raise UnknownFacetCode("respondent", [respondent], "config/zones.yaml", "a zone entry")


def map_region_rows(
    rows: list[dict[str, Any]], config: AppConfig, now: datetime | None = None
) -> list[RegionObservation]:
    """Fold D, NG and TI rows into one observation per zone-hour."""
    observations: dict[tuple[str, datetime], RegionObservation] = {}
    columns = {"D": "demand_mw", "NG": "net_generation_mw", "TI": "total_interchange_mw"}

    for row in rows:
        series = row.get("type")
        if series == "DF":
            continue  # forecasts are vintages, not observations; see map_forecast_rows
        column = columns.get(series or "")
        if column is None:
            raise UnknownFacetCode(
                "series type", [str(series)], "workers/eia/client.py", "SERIES_TYPES"
            )

        zone_key = zone_for(config, row["respondent"])
        if zone_key is None:
            continue
        period = parse_period(row["period"])
        if not is_complete_hour(period, now):
            continue

        key = (zone_key, period)
        observation = observations.get(key)
        if observation is None:
            observation = RegionObservation(zone_key=zone_key, period_utc=period)
            observations[key] = observation
        setattr(observation, column, parse_value(row.get("value")))

    return [observations[key] for key in sorted(observations)]


def map_fuel_rows(
    rows: list[dict[str, Any]], config: AppConfig, now: datetime | None = None
) -> list[MixObservation]:
    """Fold fuel-type rows into one observation per zone-hour, summing shared modes."""
    mapping = config.modes.mapping_for(SOURCE)
    modes: dict[tuple[str, datetime], dict[str, Decimal]] = defaultdict(dict)
    unmapped: dict[tuple[str, datetime], dict[str, Any]] = defaultdict(dict)
    seen: set[tuple[str, datetime]] = set()

    for row in rows:
        zone_key = zone_for(config, row["respondent"])
        if zone_key is None:
            continue
        period = parse_period(row["period"])
        if not is_complete_hour(period, now):
            continue

        code = row.get("fueltype")
        mode = mapping.get(str(code))
        if mode is None:
            raise UnknownFacetCode("fuel type", [str(code)], "config/modes.yaml", "sources.eia")

        key = (zone_key, period)
        seen.add(key)
        value = parse_value(row.get("value"))
        if value is None:
            continue
        # Summed, not assigned: several codes reach the same canonical mode.
        modes[key][mode] = modes[key].get(mode, Decimal(0)) + value

    observations = []
    for key in sorted(seen):
        by_mode = modes.get(key, {})
        total, renewable, low_carbon = compute_shares(by_mode, config.modes)
        observations.append(
            MixObservation(
                zone_key=key[0],
                period_utc=key[1],
                modes=by_mode,
                total_generation_mw=total,
                renewable_share=renewable,
                low_carbon_share=low_carbon,
                raw=unmapped.get(key, {}),
            )
        )
    return observations


def map_interchange_rows(
    rows: list[dict[str, Any]], config: AppConfig, now: datetime | None = None
) -> list[InterchangeObservation]:
    """Map directed interchange.

    The receiving end may be a Canadian or Mexican balancing authority that is not a
    zone, so `to_zone` falls back to the raw EIA code. Zone keys always contain a
    hyphen and EIA codes do not, so the two cannot be confused.
    """
    observations: dict[tuple[str, str, datetime], InterchangeObservation] = {}

    for row in rows:
        from_zone = zone_for(config, row["fromba"])
        if from_zone is None:
            continue
        period = parse_period(row["period"])
        if not is_complete_hour(period, now):
            continue

        counterparty = str(row["toba"])
        zone = config.zones.by_respondent(counterparty)
        to_zone = zone.key if zone is not None else counterparty
        if to_zone == from_zone:
            continue  # a zone cannot trade with itself

        key = (from_zone, to_zone, period)
        observations[key] = InterchangeObservation(
            from_zone=from_zone,
            to_zone=to_zone,
            period_utc=period,
            mw=parse_value(row.get("value")),
        )

    return [observations[key] for key in sorted(observations)]


def map_forecast_rows(
    rows: list[dict[str, Any]],
    config: AppConfig,
    issue_time: datetime,
) -> list[ForecastIssue]:
    """Capture DF rows as forecast vintages.

    Forecasts cover hours that have not happened, so the in-progress-hour rule does
    not apply: a forecast for a future hour is the whole point.
    """
    issues: dict[tuple[str, datetime], ForecastIssue] = {}

    for row in rows:
        if row.get("type") != "DF":
            continue
        zone_key = zone_for(config, row["respondent"])
        if zone_key is None:
            continue
        target = parse_period(row["period"])
        issues[(zone_key, target)] = ForecastIssue(
            zone_key=zone_key,
            issue_time_utc=issue_time,
            target_time_utc=target,
            value=parse_value(row.get("value")),
        )

    return [issues[key] for key in sorted(issues)]


def compute_shares(
    modes: dict[str, Decimal], config: ModesConfig
) -> tuple[Decimal | None, Decimal | None, Decimal | None]:
    """Total generation and the two shares, or None where the answer is unknown.

    The denominator excludes storage and imports: discharge is not generation, and
    counting it would inflate a renewable percentage.

    A share is `None` whenever the denominator is missing, zero or negative. Zero is a
    real measurement — a grid genuinely running no renewables — and must never stand in
    for "we cannot tell".
    """
    if not modes:
        return None, None, None

    excluded = set(config.excluded_from_mix_percent)
    counted = {mode: value for mode, value in modes.items() if mode not in excluded}
    if not counted:
        return None, None, None

    total = sum(counted.values(), Decimal(0))
    if total <= 0:
        return total, None, None

    renewable = sum((counted.get(m, Decimal(0)) for m in config.renewable), Decimal(0))
    low_carbon = sum((counted.get(m, Decimal(0)) for m in config.low_carbon), Decimal(0))

    return total, _fraction(renewable, total), _fraction(low_carbon, total)


def _fraction(part: Decimal, whole: Decimal) -> Decimal:
    """A share in [0, 1], rounded to the four decimals the column stores.

    Negative modes inside the denominator can push a part below zero or above the
    whole; the result is clamped rather than stored as an impossible fraction.
    """
    value = (part / whole).quantize(Decimal("0.0001"))
    return min(max(value, Decimal(0)), Decimal(1))
