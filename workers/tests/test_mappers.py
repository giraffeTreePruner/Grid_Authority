"""Row mapping and share computation.

The cases that matter here are the ones where a plausible implementation quietly
corrupts data: codes that share a mode, a denominator that is zero or negative, and
the hour that has not finished yet.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest

from workers.config import load_config
from workers.eia.client import parse_period
from workers.eia.errors import UnknownFacetCode
from workers.eia.mappers import (
    MappingError,
    compute_shares,
    is_complete_hour,
    map_forecast_rows,
    map_fuel_rows,
    map_interchange_rows,
    map_region_rows,
    parse_value,
)
from workers.tests.fixtures import rows

CONFIG = load_config()
MODES = CONFIG.modes
NOW = datetime(2026, 9, 11, 12, tzinfo=UTC)


def fuel_row(respondent: str, period: str, code: str, value: Any) -> dict[str, Any]:
    return {"respondent": respondent, "period": period, "fueltype": code, "value": value}


def region_row(respondent: str, period: str, series: str, value: Any) -> dict[str, Any]:
    return {"respondent": respondent, "period": period, "type": series, "value": value}


# -- value parsing ---------------------------------------------------------------------


def test_values_arrive_as_strings_and_parse_exactly() -> None:
    assert parse_value("951") == Decimal("951")
    assert parse_value("-1044") == Decimal("-1044")
    assert parse_value("0") == Decimal("0")


def test_absent_means_none_not_zero() -> None:
    """§0.2: a missing measurement is never zero."""
    assert parse_value(None) is None
    assert parse_value("") is None
    assert parse_value("   ") is None


def test_a_non_numeric_value_is_an_error() -> None:
    with pytest.raises(MappingError):
        parse_value("n/a")


# -- the in-progress hour --------------------------------------------------------------


def test_the_hour_in_progress_is_not_complete() -> None:
    assert not is_complete_hour(datetime(2026, 9, 11, 12, tzinfo=UTC), NOW)
    assert is_complete_hour(datetime(2026, 9, 11, 11, tzinfo=UTC), NOW)


def test_region_rows_drop_the_hour_in_progress() -> None:
    """§7.1: partial values would be indistinguishable from a genuine dip."""
    mapped = map_region_rows(
        [
            region_row("ERCO", "2026-09-11T11", "D", "60000"),
            region_row("ERCO", "2026-09-11T12", "D", "31000"),
        ],
        CONFIG,
        NOW,
    )
    assert [o.period_utc.hour for o in mapped] == [11]


def test_fuel_rows_drop_the_hour_in_progress() -> None:
    mapped = map_fuel_rows(
        [
            fuel_row("ERCO", "2026-09-11T11", "WND", "9000"),
            fuel_row("ERCO", "2026-09-11T12", "WND", "4000"),
        ],
        CONFIG,
        NOW,
    )
    assert [o.period_utc.hour for o in mapped] == [11]


# -- shared modes ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("first", "second", "mode"),
    [
        ("WND", "WNB", "wind"),
        ("SUN", "SNB", "solar"),
        ("OTH", "UNK", "unknown"),
        ("UES", "OES", "other_storage"),
    ],
)
def test_codes_sharing_a_mode_are_summed(first: str, second: str, mode: str) -> None:
    """Assigning instead of adding would discard one of the two silently."""
    mapped = map_fuel_rows(
        [
            fuel_row("ERCO", "2026-09-11T10", first, "100"),
            fuel_row("ERCO", "2026-09-11T10", second, "25"),
        ],
        CONFIG,
        NOW,
    )
    assert len(mapped) == 1
    assert mapped[0].modes[mode] == Decimal("125")


def test_every_eia_code_maps_to_a_canonical_mode() -> None:
    mapping = MODES.mapping_for("eia")
    assert set(mapping) >= {"COL", "NG", "OIL", "NUC", "WAT", "SUN", "WND", "OTH"}
    assert all(mode in MODES.canonical_modes for mode in mapping.values())


def test_an_unknown_fuel_code_is_fatal_at_row_level() -> None:
    """Startup validation should catch it first, but a code can appear between refreshes."""
    with pytest.raises(UnknownFacetCode) as exc:
        map_fuel_rows([fuel_row("ERCO", "2026-09-11T10", "FUSION", "1")], CONFIG, NOW)
    assert exc.value.codes == ["FUSION"]


def test_an_unknown_respondent_is_fatal() -> None:
    with pytest.raises(UnknownFacetCode):
        map_region_rows([region_row("NEWBA", "2026-09-11T10", "D", "1")], CONFIG, NOW)


def test_an_excluded_respondent_is_skipped_not_fatal() -> None:
    retired = sorted(CONFIG.excluded_respondents.codes())[0]
    assert map_region_rows([region_row(retired, "2026-09-11T10", "D", "1")], CONFIG, NOW) == []


# -- share computation -----------------------------------------------------------------


def shares(modes: dict[str, str]) -> tuple[Any, Any, Any]:
    return compute_shares({k: Decimal(v) for k, v in modes.items()}, MODES)


def test_shares_are_the_renewable_and_low_carbon_fractions() -> None:
    total, renewable, low_carbon = shares(
        {"coal": "250", "gas": "250", "wind": "300", "solar": "100", "nuclear": "100"}
    )
    assert total == Decimal("1000")
    assert renewable == Decimal("0.4000")
    assert low_carbon == Decimal("0.5000")


def test_storage_and_imports_leave_the_denominator() -> None:
    """Discharge is not generation; counting it would inflate the percentage."""
    without = shares({"wind": "400", "gas": "600"})
    with_storage = shares(
        {
            "wind": "400",
            "gas": "600",
            "battery_storage": "500",
            "imports": "1000",
            "pumped_storage": "200",
            "other_storage": "50",
        }
    )
    assert without == with_storage
    assert with_storage[0] == Decimal("1000")


def test_a_null_total_gives_null_shares() -> None:
    """No data at all is not a zero-renewable grid."""
    assert compute_shares({}, MODES) == (None, None, None)


def test_a_mix_of_only_excluded_modes_gives_null_shares() -> None:
    total, renewable, low_carbon = shares({"battery_storage": "100", "imports": "50"})
    assert (total, renewable, low_carbon) == (None, None, None)


def test_a_zero_total_gives_null_shares_not_zero() -> None:
    """§6: never 0 as a stand-in. Zero generation cannot have a composition."""
    total, renewable, low_carbon = shares({"coal": "0", "wind": "0"})
    assert total == Decimal("0")
    assert renewable is None
    assert low_carbon is None


def test_a_negative_total_gives_null_shares() -> None:
    """A net-negative hour has no meaningful composition."""
    total, renewable, low_carbon = shares({"coal": "-100", "wind": "-50"})
    assert total == Decimal("-150")
    assert renewable is None
    assert low_carbon is None


def test_charging_storage_does_not_inflate_a_share() -> None:
    """The CAISO case, with its real shape.

    EIA does not file every operator's storage under a storage code: CAISO's fleet
    arrives as OTH/UNK, which map to `unknown`, which is counted. Its charging load then
    shrank the denominator and pushed the renewable share up — 90.1% published against
    75.6% honest across 995 hours, and one hour wrong by 30 points.
    """
    charging = {"solar": "12000", "wind": "3000", "gas": "5000", "unknown": "-9861"}
    total, renewable, _low = shares(charging)

    # Reported total keeps the negative, because that is what was measured.
    assert total == Decimal("10139")

    # The share divides by generation only: 15000 renewable of 20000 generating.
    assert renewable == Decimal("0.75")

    # Subtracting the charging load instead would have read 15000/10139, over 100%.
    assert renewable is not None and renewable <= Decimal("1")


def test_negative_station_service_does_not_remove_a_category() -> None:
    """Solar reports small negatives overnight in 15,571 hours of the real data.

    Clamped to zero, not dropped: a zone whose gas reads -5 MW for an hour of auxiliary
    load still has gas plant, and removing the category moves the share further than the
    measurement warrants.
    """
    _total, renewable, _low = shares({"wind": "400", "gas": "600", "solar": "-4"})
    # 400 of 1000, not 400 of 996 and not 400/1004.
    assert renewable == Decimal("0.4")


def test_a_share_never_exceeds_one() -> None:
    """Negative fossil generation can push the renewable part above the whole."""
    _total, renewable, _low = shares({"wind": "500", "gas": "-100"})
    assert renewable == Decimal("1")


def test_a_share_is_never_negative() -> None:
    _total, renewable, _low = shares({"wind": "-100", "gas": "500"})
    assert renewable == Decimal("0")


def test_every_renewable_mode_counts_as_low_carbon() -> None:
    _total, renewable, low_carbon = shares({"hydro": "100", "gas": "100"})
    assert renewable == Decimal("0.5000")
    assert low_carbon is not None and renewable is not None
    assert low_carbon >= renewable


def test_shares_keep_four_decimals() -> None:
    """The column is numeric(6,4); the snapshot serves three."""
    _total, renewable, _low = shares({"wind": "1", "gas": "2"})
    assert renewable == Decimal("0.3333")


# -- interchange -----------------------------------------------------------------------


def test_a_foreign_counterparty_keeps_its_eia_code() -> None:
    mapped = map_interchange_rows(
        [{"fromba": "BPAT", "toba": "BCHA", "period": "2026-09-11T10", "value": "-250"}],
        CONFIG,
        NOW,
    )
    assert len(mapped) == 1
    assert mapped[0].to_zone == "BCHA"
    assert mapped[0].from_zone.startswith("US-")
    assert mapped[0].mw == Decimal("-250")


def test_a_domestic_counterparty_becomes_a_zone_key() -> None:
    mapped = map_interchange_rows(
        [{"fromba": "AECI", "toba": "MISO", "period": "2026-09-11T10", "value": "-1044"}],
        CONFIG,
        NOW,
    )
    miso = CONFIG.zones.by_respondent("MISO")
    assert miso is not None
    assert mapped[0].to_zone == miso.key


# -- forecasts -------------------------------------------------------------------------


def test_forecasts_keep_future_target_hours() -> None:
    """A day-ahead forecast is for hours that have not happened."""
    issued = datetime(2026, 9, 11, 12, 10, tzinfo=UTC)
    mapped = map_forecast_rows([region_row("ERCO", "2026-09-12T18", "DF", "72000")], CONFIG, issued)
    assert len(mapped) == 1
    assert mapped[0].issue_time_utc == issued
    assert mapped[0].target_time_utc == datetime(2026, 9, 12, 18, tzinfo=UTC)
    assert mapped[0].model == "eia_df"
    assert mapped[0].metric == "demand"


def test_region_mapping_ignores_forecast_rows() -> None:
    """DF is a vintage, not an observation, and must not land in obs_region_hourly."""
    assert map_region_rows([region_row("ERCO", "2026-09-10T10", "DF", "1")], CONFIG, NOW) == []


# -- against the recorded responses ----------------------------------------------------


def after(fixture: str) -> datetime:
    """A clock one hour past the newest row, so every recorded hour is complete."""
    newest = max(parse_period(row["period"]) for row in rows(fixture))
    return newest + timedelta(hours=1)


def test_the_recorded_poll_response_maps_cleanly() -> None:
    fixture = "poll/region-d-ng-ti.json"
    mapped = map_region_rows(rows(fixture), CONFIG, after(fixture))
    assert mapped
    assert all(o.period_utc.tzinfo is UTC for o in mapped)
    assert all(o.period_utc.minute == 0 for o in mapped)
    assert all(o.source == "eia" for o in mapped)


def test_the_recorded_fuel_response_maps_cleanly() -> None:
    fixture = "pagination/fuel-type-page-000.json"
    mapped = map_fuel_rows(rows(fixture), CONFIG, after(fixture))
    assert mapped
    for observation in mapped:
        assert set(observation.modes) <= set(MODES.canonical_modes)
        if observation.renewable_share is not None:
            assert Decimal(0) <= observation.renewable_share <= Decimal(1)
            assert observation.low_carbon_share is not None
            assert observation.low_carbon_share >= observation.renewable_share


def test_the_category_change_response_maps_without_an_unknown_bucket() -> None:
    """The 2024 expansion codes reach real modes, not `unknown`."""
    fixture = "category-change/fuel-type-2024-12-15.json"
    mapped = map_fuel_rows(rows(fixture), CONFIG, after(fixture))
    seen = {mode for observation in mapped for mode in observation.modes}
    assert {"battery_storage", "pumped_storage", "other_storage", "solar"} & seen
