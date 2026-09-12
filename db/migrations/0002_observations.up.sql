-- Hourly observations.
--
-- Every row records where it came from, so `source` is part of every primary key.
-- Every period is an interval-start UTC hour: a row labelled 2026-09-11T14:00:00Z
-- covers 14:00:00 to 14:59:59. The hour_aligned checks enforce that at the database
-- boundary so a parser bug cannot quietly write a half-hour offset.
--
-- Missing data is absent or NULL. It is never zero, and it is never interpolated.

-- An interval-start hour, expressed so the check is immutable and therefore usable
-- in a constraint. Both AT TIME ZONE with a literal zone and date_trunc over a plain
-- timestamp are immutable; the bare timestamptz cast would not be.
CREATE TABLE obs_region_hourly (
    zone_key              text        NOT NULL REFERENCES zones (key),
    period_utc            timestamptz NOT NULL,
    source                text        NOT NULL,
    demand_mw             numeric(12, 2),
    net_generation_mw     numeric(12, 2),
    total_interchange_mw  numeric(12, 2),
    first_seen_at         timestamptz NOT NULL DEFAULT now(),
    revised_at            timestamptz,
    ingested_at           timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (zone_key, period_utc, source),

    CONSTRAINT obs_region_hourly_hour_aligned
        CHECK (period_utc
               = date_trunc('hour', period_utc AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
);

CREATE INDEX obs_region_hourly_period_idx
    ON obs_region_hourly (period_utc DESC);
CREATE INDEX obs_region_hourly_zone_period_idx
    ON obs_region_hourly (zone_key, period_utc DESC);

COMMENT ON COLUMN obs_region_hourly.revised_at IS
    'Set only when a published value actually changed, never on a no-op re-ingest.';


CREATE TABLE obs_mix_hourly (
    zone_key             text        NOT NULL REFERENCES zones (key),
    period_utc           timestamptz NOT NULL,
    source               text        NOT NULL,

    -- One column per canonical mode in config/modes.yaml. NULL means not reported.
    coal_mw              numeric(12, 2),
    gas_mw               numeric(12, 2),
    oil_mw               numeric(12, 2),
    nuclear_mw           numeric(12, 2),
    hydro_mw             numeric(12, 2),
    pumped_storage_mw    numeric(12, 2),
    wind_mw              numeric(12, 2),
    solar_mw             numeric(12, 2),
    geothermal_mw        numeric(12, 2),
    biomass_mw           numeric(12, 2),
    battery_storage_mw   numeric(12, 2),
    other_storage_mw     numeric(12, 2),
    imports_mw           numeric(12, 2),
    unknown_mw           numeric(12, 2),

    total_generation_mw  numeric(12, 2),
    -- Shares are numeric(6,4), not the numeric(12,2) used for power values: §8 serves
    -- them rounded to three decimals, which two decimal places cannot represent.
    renewable_share      numeric(6, 4),
    low_carbon_share     numeric(6, 4),

    -- Facet codes that arrived without a canonical mapping. Always populated, even
    -- when empty, so "we saw nothing unmapped" is distinguishable from "never checked".
    raw                  jsonb       NOT NULL DEFAULT '{}'::jsonb,

    aggregated           boolean     NOT NULL DEFAULT false,
    n_intervals          integer,
    expected_intervals   integer,
    first_seen_at        timestamptz NOT NULL DEFAULT now(),
    revised_at           timestamptz,
    ingested_at          timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (zone_key, period_utc, source),

    CONSTRAINT obs_mix_hourly_hour_aligned
        CHECK (period_utc
               = date_trunc('hour', period_utc AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),

    -- A share is a fraction or it is unknown. Zero is a real measurement and must not
    -- stand in for a missing one.
    CONSTRAINT obs_mix_hourly_renewable_share_fraction
        CHECK (renewable_share IS NULL OR renewable_share BETWEEN 0 AND 1),
    CONSTRAINT obs_mix_hourly_low_carbon_share_fraction
        CHECK (low_carbon_share IS NULL OR low_carbon_share BETWEEN 0 AND 1),
    CONSTRAINT obs_mix_hourly_intervals_positive
        CHECK (n_intervals IS NULL OR n_intervals >= 0),
    CONSTRAINT obs_mix_hourly_expected_intervals_positive
        CHECK (expected_intervals IS NULL OR expected_intervals > 0)
);

CREATE INDEX obs_mix_hourly_period_idx
    ON obs_mix_hourly (period_utc DESC);
CREATE INDEX obs_mix_hourly_zone_period_idx
    ON obs_mix_hourly (zone_key, period_utc DESC);

COMMENT ON COLUMN obs_mix_hourly.renewable_share IS
    'Renewable modes over all modes except those excluded_from_mix_percent. '
    'NULL when the denominator is null, zero or negative; never 0 as a stand-in.';


CREATE TABLE obs_interchange_hourly (
    from_zone      text        NOT NULL REFERENCES zones (key),
    to_zone        text        NOT NULL,
    period_utc     timestamptz NOT NULL,
    source         text        NOT NULL,
    mw             numeric(12, 2),
    first_seen_at  timestamptz NOT NULL DEFAULT now(),
    revised_at     timestamptz,
    ingested_at    timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (from_zone, to_zone, period_utc, source),

    CONSTRAINT obs_interchange_hourly_hour_aligned
        CHECK (period_utc
               = date_trunc('hour', period_utc AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
    CONSTRAINT obs_interchange_hourly_distinct_ends
        CHECK (from_zone <> to_zone)
);

CREATE INDEX obs_interchange_hourly_period_idx
    ON obs_interchange_hourly (period_utc DESC);
CREATE INDEX obs_interchange_hourly_to_zone_idx
    ON obs_interchange_hourly (to_zone, period_utc DESC);

COMMENT ON COLUMN obs_interchange_hourly.to_zone IS
    'Canonical zone key when the counterparty is a registered zone, otherwise the raw '
    'EIA counterparty code. The toba facet includes Canadian and Mexican balancing '
    'authorities that are not zones, and no foreign key is claimed for that reason.';
