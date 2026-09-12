"""Configuration loading and validation.

The point of these tests is the error messages as much as the rejections: an invalid
config must fail startup with a message that names the file and the field.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml

from workers.config import (
    ConfigError,
    load_config,
    load_modes,
    load_zones,
)

VALID_ZONE: dict[str, Any] = {
    "key": "US-TEX-ERCO",
    "eia_respondent": "ERCO",
    "name": "Electric Reliability Council of Texas, Inc.",
    "short_name": "ERCOT",
    "interconnection": "texas",
    "timezone": "America/Chicago",
    "type": "balancing_authority",
    "parent": None,
    "in_map": True,
    "capabilities": {
        "demand": True,
        "demand_forecast": True,
        "net_generation": True,
        "fuel_mix": True,
        "interchange": True,
    },
}

VALID_MODES: dict[str, Any] = {
    "canonical_modes": ["coal", "gas", "hydro", "wind", "solar", "nuclear", "imports", "unknown"],
    "renewable": ["hydro", "wind", "solar"],
    "low_carbon": ["hydro", "wind", "solar", "nuclear"],
    "excluded_from_mix_percent": ["imports"],
    "sources": {"eia": {"COL": "coal", "NG": "gas"}},
}

VALID_SOURCES: list[dict[str, Any]] = [
    {
        "id": "eia",
        "label": "EIA Form 930",
        "attribution": "U.S. Energy Information Administration",
        "url": "https://www.eia.gov/electricity/gridmonitor/",
        "license": "Public domain (U.S. Government work)",
        "independent": True,
        "notes": "Hourly.",
        "active": True,
    }
]


def write_config(
    directory: Path,
    *,
    zones: Any = None,
    excluded: Any = None,
    modes: Any = None,
    sources: Any = None,
) -> Path:
    """Write a complete config directory, overriding individual files."""
    files = {
        "zones.yaml": [VALID_ZONE] if zones is None else zones,
        "excluded_respondents.yaml": [] if excluded is None else excluded,
        "modes.yaml": VALID_MODES if modes is None else modes,
        "sources.yaml": VALID_SOURCES if sources is None else sources,
    }
    for name, content in files.items():
        (directory / name).write_text(yaml.safe_dump(content), encoding="utf-8")
    return directory


def zone_with(**overrides: Any) -> dict[str, Any]:
    zone = {**VALID_ZONE, **overrides}
    return zone


def test_repository_config_is_valid() -> None:
    """The committed config files load without error."""
    config = load_config()
    assert config.zones.by_respondent("ERCO") is not None
    assert "eia" in config.modes.sources
    assert config.sources.by_id("eia") is not None


def test_valid_config_round_trips(tmp_path: Path) -> None:
    config = load_config(write_config(tmp_path))
    zone = config.zones.by_key("US-TEX-ERCO")
    assert zone is not None
    assert zone.capabilities.fuel_mix is True
    assert config.zones.in_map() == [zone]


def test_missing_file_names_the_file(tmp_path: Path) -> None:
    with pytest.raises(ConfigError) as exc:
        load_zones(tmp_path)
    assert "zones.yaml" in str(exc.value)
    assert "does not exist" in str(exc.value)


def test_yaml_syntax_error_reports_line(tmp_path: Path) -> None:
    (tmp_path / "zones.yaml").write_text("- key: US-TEX-ERCO\n   bad indent: true\n", "utf-8")
    with pytest.raises(ConfigError) as exc:
        load_zones(tmp_path)
    message = str(exc.value)
    assert "zones.yaml" in message
    assert "line" in message


def test_unknown_field_is_rejected(tmp_path: Path) -> None:
    write_config(tmp_path, zones=[zone_with(colour="blue")])
    with pytest.raises(ConfigError) as exc:
        load_zones(tmp_path)
    message = str(exc.value)
    assert "entry 1.colour" in message
    assert "zones.yaml" in message


def test_bad_enum_names_entry_and_field(tmp_path: Path) -> None:
    write_config(tmp_path, zones=[zone_with(interconnection="atlantic")])
    with pytest.raises(ConfigError) as exc:
        load_zones(tmp_path)
    assert "entry 1.interconnection" in str(exc.value)


def test_invalid_timezone_is_rejected(tmp_path: Path) -> None:
    write_config(tmp_path, zones=[zone_with(timezone="Mars/Olympus")])
    with pytest.raises(ConfigError) as exc:
        load_zones(tmp_path)
    assert "not an IANA time zone" in str(exc.value)


def test_duplicate_zone_key_is_rejected(tmp_path: Path) -> None:
    second = zone_with(eia_respondent="CISO")
    write_config(tmp_path, zones=[VALID_ZONE, second])
    with pytest.raises(ConfigError) as exc:
        load_zones(tmp_path)
    assert "duplicate key 'US-TEX-ERCO'" in str(exc.value)


def test_duplicate_respondent_is_rejected(tmp_path: Path) -> None:
    second = zone_with(key="US-CAL-CISO")
    write_config(tmp_path, zones=[VALID_ZONE, second])
    with pytest.raises(ConfigError) as exc:
        load_zones(tmp_path)
    assert "duplicate eia_respondent 'ERCO'" in str(exc.value)


def test_unknown_parent_is_rejected(tmp_path: Path) -> None:
    write_config(tmp_path, zones=[zone_with(parent="US-NOWHERE")])
    with pytest.raises(ConfigError) as exc:
        load_zones(tmp_path)
    assert "parent 'US-NOWHERE' is not a zone key" in str(exc.value)


def test_aggregate_may_not_be_on_the_map(tmp_path: Path) -> None:
    """Aggregates would be double-counted against the zones they contain."""
    write_config(
        tmp_path,
        zones=[zone_with(key="US-US48", eia_respondent="US48", type="country_total", in_map=True)],
    )
    with pytest.raises(ConfigError) as exc:
        load_zones(tmp_path)
    assert "in_map must be false for type 'country_total'" in str(exc.value)


def test_balancing_authority_needs_an_interconnection(tmp_path: Path) -> None:
    write_config(tmp_path, zones=[zone_with(interconnection=None)])
    with pytest.raises(ConfigError) as exc:
        load_zones(tmp_path)
    assert "interconnection is required for a balancing_authority" in str(exc.value)


def test_facet_code_mapped_to_unknown_mode_is_rejected(tmp_path: Path) -> None:
    modes = {**VALID_MODES, "sources": {"eia": {"COL": "coal", "XYZ": "antimatter"}}}
    write_config(tmp_path, modes=modes)
    with pytest.raises(ConfigError) as exc:
        load_modes(tmp_path)
    assert "sources.eia.XYZ: 'antimatter' is not in canonical_modes" in str(exc.value)


def test_renewable_must_be_canonical(tmp_path: Path) -> None:
    modes = {**VALID_MODES, "renewable": ["hydro", "tidal"]}
    write_config(tmp_path, modes=modes)
    with pytest.raises(ConfigError) as exc:
        load_modes(tmp_path)
    assert "renewable: 'tidal' is not in canonical_modes" in str(exc.value)


def test_renewable_may_not_be_excluded_from_the_denominator(tmp_path: Path) -> None:
    modes = {**VALID_MODES, "excluded_from_mix_percent": ["imports", "solar"]}
    write_config(tmp_path, modes=modes)
    with pytest.raises(ConfigError) as exc:
        load_modes(tmp_path)
    assert "renewable and excluded_from_mix_percent overlap" in str(exc.value)


def test_every_renewable_mode_is_low_carbon(tmp_path: Path) -> None:
    modes = {**VALID_MODES, "low_carbon": ["nuclear"]}
    write_config(tmp_path, modes=modes)
    with pytest.raises(ConfigError) as exc:
        load_modes(tmp_path)
    assert "low_carbon is missing renewable modes" in str(exc.value)


def test_respondent_cannot_be_both_zone_and_excluded(tmp_path: Path) -> None:
    write_config(tmp_path, excluded=[{"code": "ERCO", "reason": "duplicated by mistake"}])
    with pytest.raises(ConfigError) as exc:
        load_config(tmp_path)
    assert "respondent 'ERCO' is both a zone" in str(exc.value)


def test_excluded_respondent_needs_a_reason(tmp_path: Path) -> None:
    write_config(tmp_path, excluded=[{"code": "YAD", "reason": ""}])
    with pytest.raises(ConfigError) as exc:
        load_config(tmp_path)
    assert "entry 1.reason" in str(exc.value)


def test_sources_must_register_eia(tmp_path: Path) -> None:
    other = {**VALID_SOURCES[0], "id": "other"}
    write_config(tmp_path, sources=[other])
    with pytest.raises(ConfigError) as exc:
        load_config(tmp_path)
    assert "the 'eia' source must be registered" in str(exc.value)
