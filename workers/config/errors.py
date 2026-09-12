"""Configuration errors.

Configuration is validated once, at startup, and an invalid file is always fatal.
Every message names the file and the field so the fix is obvious from the error alone.
"""

from __future__ import annotations

from pathlib import Path


class ConfigError(Exception):
    """A configuration file is missing, unparseable or invalid.

    Raised at startup only. Callers let it propagate: the process exits non-zero
    with the message rather than continuing on a partially valid config.
    """

    def __init__(self, path: Path | str, problems: list[str]) -> None:
        self.path = str(path)
        self.problems = problems
        detail = "\n".join(f"  - {problem}" for problem in problems)
        super().__init__(f"{self.path} is invalid:\n{detail}")
