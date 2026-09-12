-- Forecast vintages.
--
-- Append-only, never updated, never deleted. This is the one table whose history
-- cannot be reconstructed later: once EIA replaces a day-ahead forecast with a
-- revision, the original issue is gone from the API forever. Capturing each vintage
-- as it is published is the only way to know what was forecast at the time.

CREATE TABLE forecast_issues (
    id               bigserial PRIMARY KEY,
    source           text        NOT NULL,
    model            text        NOT NULL,
    zone_key         text        NOT NULL REFERENCES zones (key),
    issue_time_utc   timestamptz NOT NULL,
    target_time_utc  timestamptz NOT NULL,
    horizon_h        integer GENERATED ALWAYS AS (
                         (EXTRACT(EPOCH FROM (target_time_utc - issue_time_utc)) / 3600)::integer
                     ) STORED,
    metric           text        NOT NULL,
    value            numeric(12, 2),
    ingested_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT forecast_issues_unique_vintage
        UNIQUE (source, model, zone_key, issue_time_utc, target_time_utc, metric),

    CONSTRAINT forecast_issues_target_hour_aligned
        CHECK (target_time_utc
               = date_trunc('hour', target_time_utc AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
);

CREATE INDEX forecast_issues_target_idx
    ON forecast_issues (zone_key, metric, target_time_utc DESC, issue_time_utc DESC);

COMMENT ON TABLE forecast_issues IS
    'Append-only forecast vintages. Never updated, never deleted.';
COMMENT ON COLUMN forecast_issues.horizon_h IS
    'Hours from issue to target, derived rather than stored, so it cannot disagree '
    'with the timestamps it comes from.';
COMMENT ON COLUMN forecast_issues.issue_time_utc IS
    'Start of the poll cycle that first observed this value, not an hour EIA publishes. '
    'It is therefore not constrained to an hour boundary.';
