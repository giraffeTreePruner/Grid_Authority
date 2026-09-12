-- Operational tables: what each job did, what the map serves, and how far behind
-- each dataset actually runs.

-- One row per source and job. Written on both paths, success and failure, so a job
-- that stops running is visible as a stale last_run_at rather than as silence.
CREATE TABLE source_status (
    source              text NOT NULL,
    job                 text NOT NULL,
    last_run_at         timestamptz,
    last_success_at     timestamptz,
    last_failure_at     timestamptz,
    last_error          text,
    rows_written        integer,
    requests_made       integer,
    duration_seconds    numeric(12, 2),
    data_latest_period  timestamptz,
    updated_at          timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (source, job)
);

COMMENT ON COLUMN source_status.data_latest_period IS
    'Newest period this source has data for, as reported by the API rather than '
    'inferred from what was written.';


-- Precomputed hourly map payloads. Holds the exact bytes /map/snapshot serves, so
-- serving the map never touches an observation table.
CREATE TABLE map_snapshot (
    period_utc  timestamptz PRIMARY KEY,
    payload     jsonb       NOT NULL,
    built_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT map_snapshot_hour_aligned
        CHECK (period_utc
               = date_trunc('hour', period_utc AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
);


-- Measured publication lag, written by the probe. This is what lets /api/v1/sources
-- report observed latency instead of a guess.
CREATE TABLE probe_log (
    id             bigserial PRIMARY KEY,
    dataset        text        NOT NULL,
    checked_at     timestamptz NOT NULL DEFAULT now(),
    latest_period  timestamptz,
    lag_minutes    integer,
    changed_rows   integer
);

CREATE INDEX probe_log_dataset_checked_idx
    ON probe_log (dataset, checked_at DESC);
