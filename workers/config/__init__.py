"""Loading and validation of the YAML contracts in ``config/``.

All configuration is read once at startup. Invalid configuration is a fatal error,
never a warning: a job that cannot trust its configuration must not write data.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from workers.config.errors import ConfigError
from workers.config.loader import config_dir, load, read_yaml, validate
from workers.config.models import (
    Capabilities,
    ExcludedRespondent,
    ExcludedRespondents,
    Interconnection,
    ModesConfig,
    Source,
    SourcesConfig,
    Zone,
    ZoneRegistry,
    ZoneType,
)

ZONES_FILE = "zones.yaml"
EXCLUDED_FILE = "excluded_respondents.yaml"
MODES_FILE = "modes.yaml"
SOURCES_FILE = "sources.yaml"


@dataclass(frozen=True)
class AppConfig:
    """Every config file, validated together."""

    zones: ZoneRegistry
    excluded_respondents: ExcludedRespondents
    modes: ModesConfig
    sources: SourcesConfig


def load_zones(directory: Path | None = None) -> ZoneRegistry:
    return load((directory or config_dir()) / ZONES_FILE, ZoneRegistry)


def load_excluded_respondents(directory: Path | None = None) -> ExcludedRespondents:
    return load((directory or config_dir()) / EXCLUDED_FILE, ExcludedRespondents)


def load_modes(directory: Path | None = None) -> ModesConfig:
    return load((directory or config_dir()) / MODES_FILE, ModesConfig)


def load_sources(directory: Path | None = None) -> SourcesConfig:
    return load((directory or config_dir()) / SOURCES_FILE, SourcesConfig)


def load_config(directory: Path | None = None) -> AppConfig:
    """Load and validate every config file.

    Cross-file invariants are checked here: a respondent may not be both a zone and
    an excluded respondent, and a zone may not claim a source that is not registered.
    """
    base = directory or config_dir()
    zones = load_zones(base)
    excluded = load_excluded_respondents(base)
    modes = load_modes(base)
    sources = load_sources(base)

    overlap = sorted(zones.respondents() & excluded.codes())
    if overlap:
        raise ConfigError(
            base / EXCLUDED_FILE,
            [
                f"respondent '{code}' is both a zone in {ZONES_FILE} and excluded here; "
                "it must appear in exactly one"
                for code in overlap
            ],
        )

    if "eia" not in modes.sources:
        raise ConfigError(base / MODES_FILE, ["sources.eia: no mapping for the 'eia' source"])

    return AppConfig(zones=zones, excluded_respondents=excluded, modes=modes, sources=sources)


@lru_cache(maxsize=1)
def cached_config() -> AppConfig:
    """Process-wide configuration, loaded on first use."""
    return load_config()


__all__ = [
    "AppConfig",
    "Capabilities",
    "ConfigError",
    "ExcludedRespondent",
    "ExcludedRespondents",
    "Interconnection",
    "ModesConfig",
    "Source",
    "SourcesConfig",
    "Zone",
    "ZoneRegistry",
    "ZoneType",
    "cached_config",
    "config_dir",
    "load",
    "load_config",
    "load_excluded_respondents",
    "load_modes",
    "load_sources",
    "load_zones",
    "read_yaml",
    "validate",
]
