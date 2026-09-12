"""Errors raised by the EIA client.

Every one of these is fatal to the job that hit it. A job that cannot trust what it
fetched must not write, and must exit non-zero so the failure is visible in
source_status rather than showing up as a quietly incomplete day.
"""

from __future__ import annotations


class EiaError(RuntimeError):
    """Base for every EIA client failure."""


class EiaRequestError(EiaError):
    """A request failed and will not be retried, or ran out of attempts."""

    def __init__(self, message: str, *, status: int | None = None, attempts: int = 1) -> None:
        super().__init__(message)
        self.status = status
        self.attempts = attempts


class EiaRateLimitExceeded(EiaError):
    """The client's own hourly ceiling was reached.

    Raised before a request is sent. This is a self-imposed limit well under EIA's, so
    hitting it means a job is looping or a window is far larger than intended.
    """


class UnknownFacetCode(EiaError):
    """The API returned a code that configuration does not account for.

    §5.2 and guardrail 5: an unrecognised code is fatal, never bucketed as `unknown`.
    Absorbing it silently is how a category expansion goes unnoticed and a zone's
    generation mix quietly loses a fuel.
    """

    def __init__(self, kind: str, codes: list[str], config_file: str, config_path: str) -> None:
        self.kind = kind
        self.codes = codes
        listed = ", ".join(codes)
        super().__init__(
            f"EIA published {len(codes)} unrecognised {kind} code(s): {listed}. "
            f"Add each to {config_path} in {config_file}. "
            "Refusing to continue: an unmapped code would silently distort the data."
        )
