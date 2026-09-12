"""YAML loading and validation for the files in ``config/``.

Loaders are deliberately strict. A file that does not match its schema raises
:class:`ConfigError` naming the file, the offending field path and the reason.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import TypeVar

import yaml
from pydantic import BaseModel, ValidationError

from workers.config.errors import ConfigError

ModelT = TypeVar("ModelT", bound=BaseModel)

DEFAULT_CONFIG_DIR = Path(__file__).resolve().parents[2] / "config"


def config_dir() -> Path:
    """Directory holding the YAML config files.

    ``GRID_CONFIG_DIR`` overrides the repository default so tests and alternate
    deployments can point at another directory.
    """
    override = os.environ.get("GRID_CONFIG_DIR")
    return Path(override) if override else DEFAULT_CONFIG_DIR


def read_yaml(path: Path) -> object:
    """Parse a YAML file, reporting the location of a syntax error."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ConfigError(path, ["file does not exist"]) from exc
    except OSError as exc:
        raise ConfigError(path, [f"could not be read: {exc.strerror}"]) from exc

    try:
        return yaml.safe_load(text)
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        where = f"line {mark.line + 1}, column {mark.column + 1}: " if mark else ""
        problem = getattr(exc, "problem", None) or "could not be parsed as YAML"
        raise ConfigError(path, [f"{where}{problem}"]) from exc


def _format_location(location: tuple[int | str, ...]) -> str:
    """Render a pydantic error location as a readable field path.

    Sequence indices become ``entry N`` (1-based) so the path matches how a person
    counts entries in the file.
    """
    parts: list[str] = []
    for item in location:
        if isinstance(item, int):
            parts.append(f"entry {item + 1}")
        else:
            parts.append(str(item))
    return ".".join(parts) if parts else "(document root)"


def validate(path: Path, model: type[ModelT], data: object) -> ModelT:
    """Validate parsed YAML against a model, naming every failing field."""
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        problems = [f"{_format_location(error['loc'])}: {error['msg']}" for error in exc.errors()]
        raise ConfigError(path, problems) from exc


def load(path: Path, model: type[ModelT]) -> ModelT:
    """Read and validate one config file."""
    return validate(path, model, read_yaml(path))
