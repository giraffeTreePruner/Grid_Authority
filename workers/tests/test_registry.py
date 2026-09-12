"""The registry against what EIA actually publishes.

These run off committed facet fixtures, never the network. Their job is to fail when
EIA adds a code: §5.2 makes an unrecognised respondent or fuel type a fatal startup
error, and that guarantee is only worth anything if something checks it.
"""

from __future__ import annotations

import json
from pathlib import Path

from workers.config import load_config

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "eia" / "facets"


def facet_codes(name: str) -> set[str]:
    """Distinct ids from a facet response.

    The fueltype facet returns some ids twice under different labels, so this
    deliberately collapses to a set.
    """
    payload = json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))
    response = payload["response"]
    entries = response.get("facets", response.get("data"))
    return {entry["id"] for entry in entries}


def test_every_respondent_is_a_zone_or_documented_exclusion() -> None:
    """§4.1: a respondent in neither file is a failure, not a default."""
    config = load_config()
    accounted = config.zones.respondents() | config.excluded_respondents.codes()
    unaccounted = sorted(facet_codes("region-respondent") - accounted)
    assert not unaccounted, (
        f"EIA respondents missing from config: {unaccounted}. "
        "Add each to zones.yaml or excluded_respondents.yaml with a reason."
    )


def test_no_configured_respondent_has_disappeared() -> None:
    """A zone for a respondent EIA no longer lists would never receive data."""
    config = load_config()
    published = facet_codes("region-respondent")
    configured = config.zones.respondents() | config.excluded_respondents.codes()
    stale = sorted(configured - published)
    assert not stale, f"configured respondents EIA no longer publishes: {stale}"


def test_every_fuel_code_maps_to_a_canonical_mode() -> None:
    """§5.2 and guardrail 5: an unmapped fuel code must be impossible to ignore."""
    config = load_config()
    mapping = config.modes.mapping_for("eia")
    unmapped = sorted(facet_codes("fueltype") - set(mapping))
    assert not unmapped, (
        f"EIA fuel type codes with no canonical mode: {unmapped}. "
        "Add each to sources.eia in modes.yaml."
    )


def test_no_mapped_fuel_code_has_disappeared() -> None:
    config = load_config()
    mapping = config.modes.mapping_for("eia")
    stale = sorted(set(mapping) - facet_codes("fueltype"))
    assert not stale, f"mapped fuel codes EIA no longer publishes: {stale}"


def test_series_types_are_the_four_the_spec_consumes() -> None:
    """D, DF, NG and TI. A fifth would mean an unread series."""
    assert facet_codes("region-type") == {"D", "DF", "NG", "TI"}


def test_interchange_reporters_are_all_zones() -> None:
    """Every fromba is a respondent, so every one must resolve to a zone."""
    config = load_config()
    reporters = facet_codes("interchange-fromba")
    accounted = config.zones.respondents() | config.excluded_respondents.codes()
    assert not sorted(reporters - accounted)


def test_aggregates_are_not_drawn_on_the_map() -> None:
    config = load_config()
    on_map = {zone.key for zone in config.zones.in_map()}
    aggregates = {zone.key for zone in config.zones.zones if zone.type != "balancing_authority"}
    assert not (on_map & aggregates)


def test_every_balancing_authority_has_a_regional_parent() -> None:
    """The aggregates partition the balancing authorities, which is what makes the
    demand reconciliation that produced this registry meaningful."""
    config = load_config()
    regions = {zone.key for zone in config.zones.zones if zone.type == "region"}
    orphans = [
        zone.key
        for zone in config.zones.zones
        if zone.type == "balancing_authority" and zone.parent not in regions
    ]
    assert not orphans, f"balancing authorities with no regional parent: {orphans}"


def test_a_zone_claims_no_capability_it_cannot_have() -> None:
    """A zone that forecasts demand must report demand."""
    config = load_config()
    wrong = [
        zone.key
        for zone in config.zones.zones
        if zone.capabilities.demand_forecast and not zone.capabilities.demand
    ]
    assert not wrong, f"zones forecasting a demand series they do not publish: {wrong}"
