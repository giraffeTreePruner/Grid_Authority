-- Coarse map snapshots: one document per day, week or month.
--
-- Separate from map_snapshot rather than a `resolution` column on it, because the two
-- carry different documents: an hourly snapshot has one value per metric, a coarse one
-- has a mean and a peak. Folding them into one table would mean every consumer checking
-- which shape it received.
--
-- Derived data. Everything here is rebuildable from the observation tables by
-- `eia rebuild-aggregates`, so it is never the only copy of anything.

CREATE TABLE map_snapshot_agg (
    resolution  text        NOT NULL,
    period_utc  timestamptz NOT NULL,
    payload     jsonb       NOT NULL,
    built_at    timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (resolution, period_utc),

    CONSTRAINT map_snapshot_agg_resolution_known
        CHECK (resolution IN ('day', 'week', 'month')),

    -- date_trunc puts a day and a month at midnight, and a week on a Monday midnight.
    -- Enforced here so a period label always means what it says, the same way the
    -- hourly tables enforce hour alignment.
    CONSTRAINT map_snapshot_agg_period_aligned
        CHECK (period_utc
               = date_trunc(resolution, period_utc AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
);

CREATE INDEX map_snapshot_agg_period_idx
    ON map_snapshot_agg (resolution, period_utc DESC);

COMMENT ON TABLE map_snapshot_agg IS
    'Day, week and month map snapshots. Derived; rebuildable from observations.';
COMMENT ON COLUMN map_snapshot_agg.payload IS
    'Per zone, a mean and a peak array in the fixed metric order.';
