"""Schemas for the YAML contracts in ``config/``.

These models are the authority on what a valid configuration looks like. They are
strict by design: unknown keys are rejected rather than ignored, so a typo in a
field name fails startup instead of silently disabling a capability.
"""

from __future__ import annotations

import re
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, RootModel, field_validator, model_validator

Interconnection = Literal["eastern", "western", "texas", "alaska", "hawaii"]
ZoneType = Literal["balancing_authority", "region", "country_total"]

ZONE_KEY_PATTERN = re.compile(r"^[A-Z0-9]+(-[A-Z0-9]+)+$")
RESPONDENT_PATTERN = re.compile(r"^[A-Z0-9-]+$")
MODE_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")


class Strict(BaseModel):
    """Base for every config model: unknown fields are an error."""

    model_config = ConfigDict(extra="forbid")


class Capabilities(Strict):
    """Which EIA series a zone is expected to publish."""

    demand: bool
    demand_forecast: bool
    net_generation: bool
    fuel_mix: bool
    interchange: bool


class Zone(Strict):
    """One entry in the zone registry."""

    key: str
    eia_respondent: str
    name: str = Field(min_length=1)
    short_name: str = Field(min_length=1)
    interconnection: Interconnection | None
    timezone: str
    type: ZoneType
    parent: str | None = None
    in_map: bool
    capabilities: Capabilities

    @field_validator("key")
    @classmethod
    def _check_key(cls, value: str) -> str:
        if not ZONE_KEY_PATTERN.match(value):
            raise ValueError(
                f"'{value}' is not a canonical zone key "
                "(uppercase segments joined by hyphens, for example 'US-TEX-ERCO')"
            )
        return value

    @field_validator("eia_respondent")
    @classmethod
    def _check_respondent(cls, value: str) -> str:
        if not RESPONDENT_PATTERN.match(value):
            raise ValueError(f"'{value}' is not a valid EIA respondent code (uppercase, A-Z0-9-)")
        return value

    @field_validator("timezone")
    @classmethod
    def _check_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"'{value}' is not an IANA time zone name") from exc
        return value

    @model_validator(mode="after")
    def _check_consistency(self) -> Zone:
        if self.type == "balancing_authority" and self.interconnection is None:
            raise ValueError("interconnection is required for a balancing_authority")
        if self.type != "balancing_authority" and self.in_map:
            raise ValueError(
                f"in_map must be false for type '{self.type}': aggregates would be "
                "double-counted against the balancing authorities they contain"
            )
        return self


class ZoneRegistry(RootModel[list[Zone]]):
    """The full zone registry, with registry-wide invariants enforced."""

    @model_validator(mode="after")
    def _check_registry(self) -> ZoneRegistry:
        zones = self.root
        if not zones:
            raise ValueError("the zone registry is empty")

        problems: list[str] = []
        problems += _duplicates("key", [zone.key for zone in zones])
        problems += _duplicates("eia_respondent", [zone.eia_respondent for zone in zones])

        keys = {zone.key for zone in zones}
        for zone in zones:
            if zone.parent is not None and zone.parent not in keys:
                problems.append(f"{zone.key}: parent '{zone.parent}' is not a zone key")
            if zone.parent == zone.key:
                problems.append(f"{zone.key}: parent refers to itself")

        if problems:
            raise ValueError("; ".join(problems))
        return self

    @property
    def zones(self) -> list[Zone]:
        return self.root

    def by_key(self, key: str) -> Zone | None:
        return next((zone for zone in self.root if zone.key == key), None)

    def by_respondent(self, respondent: str) -> Zone | None:
        return next((zone for zone in self.root if zone.eia_respondent == respondent), None)

    def in_map(self) -> list[Zone]:
        return [zone for zone in self.root if zone.in_map]

    def respondents(self) -> set[str]:
        return {zone.eia_respondent for zone in self.root}


class ExcludedRespondent(Strict):
    """An EIA respondent deliberately left out of the zone registry."""

    code: str
    reason: str = Field(min_length=1)

    @field_validator("code")
    @classmethod
    def _check_code(cls, value: str) -> str:
        if not RESPONDENT_PATTERN.match(value):
            raise ValueError(f"'{value}' is not a valid EIA respondent code (uppercase, A-Z0-9-)")
        return value


class ExcludedRespondents(RootModel[list[ExcludedRespondent]]):
    """Respondents accounted for by exclusion rather than by a zone entry."""

    @model_validator(mode="after")
    def _check_unique(self) -> ExcludedRespondents:
        problems = _duplicates("code", [entry.code for entry in self.root])
        if problems:
            raise ValueError("; ".join(problems))
        return self

    def codes(self) -> set[str]:
        return {entry.code for entry in self.root}

    def reason_for(self, code: str) -> str | None:
        return next((entry.reason for entry in self.root if entry.code == code), None)


class ModesConfig(Strict):
    """Canonical generation modes and the per-source facet-code mapping."""

    canonical_modes: list[str]
    renewable: list[str]
    low_carbon: list[str]
    excluded_from_mix_percent: list[str]
    sources: dict[str, dict[str, str]]

    @field_validator("canonical_modes")
    @classmethod
    def _check_modes(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("at least one canonical mode is required")
        problems = _duplicates("mode", value)
        problems += [
            f"'{mode}' is not a valid mode name (lowercase snake_case)"
            for mode in value
            if not MODE_PATTERN.match(mode)
        ]
        if problems:
            raise ValueError("; ".join(problems))
        return value

    @model_validator(mode="after")
    def _check_references(self) -> ModesConfig:
        canonical = set(self.canonical_modes)
        problems: list[str] = []

        for field in ("renewable", "low_carbon", "excluded_from_mix_percent"):
            members: list[str] = getattr(self, field)
            problems += _duplicates(f"{field} entry", members)
            problems += [
                f"{field}: '{mode}' is not in canonical_modes"
                for mode in members
                if mode not in canonical
            ]

        for source, mapping in self.sources.items():
            for code, mode in mapping.items():
                if mode not in canonical:
                    problems.append(f"sources.{source}.{code}: '{mode}' is not in canonical_modes")

        overlap = set(self.renewable) & set(self.excluded_from_mix_percent)
        if overlap:
            problems.append(
                "renewable and excluded_from_mix_percent overlap on "
                f"{sorted(overlap)}: a mode cannot both count as renewable and be "
                "excluded from the denominator"
            )

        missing_low_carbon = sorted(set(self.renewable) - set(self.low_carbon))
        if missing_low_carbon:
            problems.append(
                f"low_carbon is missing renewable modes {missing_low_carbon}: "
                "every renewable mode is also low carbon"
            )

        if problems:
            raise ValueError("; ".join(problems))
        return self

    def mapping_for(self, source: str) -> dict[str, str]:
        """Facet code to canonical mode for one source."""
        return self.sources.get(source, {})


class Source(Strict):
    """A registered data source, active or reserved."""

    id: str
    label: str = Field(min_length=1)
    attribution: str = Field(min_length=1)
    url: str
    license: str = Field(min_length=1)
    independent: bool
    notes: str = ""
    active: bool

    @field_validator("url")
    @classmethod
    def _check_url(cls, value: str) -> str:
        if not value.startswith(("http://", "https://")):
            raise ValueError(f"'{value}' is not an http(s) URL")
        return value


class SourcesConfig(RootModel[list[Source]]):
    """The data source registry, including entries that are not yet active."""

    @model_validator(mode="after")
    def _check_registry(self) -> SourcesConfig:
        problems = _duplicates("id", [source.id for source in self.root])
        if not any(source.id == "eia" for source in self.root):
            problems.append("the 'eia' source must be registered")
        if problems:
            raise ValueError("; ".join(problems))
        return self

    def by_id(self, source_id: str) -> Source | None:
        return next((source for source in self.root if source.id == source_id), None)

    def active(self) -> list[Source]:
        return [source for source in self.root if source.active]


def _duplicates(label: str, values: list[str]) -> list[str]:
    """Report each value that appears more than once."""
    seen: set[str] = set()
    repeated: list[str] = []
    for value in values:
        if value in seen and value not in repeated:
            repeated.append(value)
        seen.add(value)
    return [f"duplicate {label} '{value}'" for value in repeated]
