-- Which days the backfill has already fetched.
--
-- Completeness was judged purely from the data: a day was done when every in-map zone
-- with demand capability held 23 of its 24 hours. That works for a recent window, where
-- every such zone reports. It cannot work for history. Capabilities are observed from
-- current EIA data, and a balancing authority that reports today may not have existed in
-- 2019 -- so a 2019 day is missing a zone that will never appear, is never complete, and
-- is re-fetched on every run for ever.
--
-- This records the fetch itself. It is written in the same transaction as the day's
-- observations, so it cannot outlive the data it describes: a rollback takes both. That
-- was the objection to a marker file, and it does not apply to a row that commits
-- atomically with what it marks.

CREATE TABLE backfill_day (
    day              date        PRIMARY KEY,
    source           text        NOT NULL,
    fetched_at       timestamptz NOT NULL DEFAULT now(),
    zones_reporting  integer     NOT NULL,
    rows_written     integer     NOT NULL
);

COMMENT ON TABLE backfill_day IS
    'Days the backfill has fetched. Written atomically with the day''s observations.';
COMMENT ON COLUMN backfill_day.zones_reporting IS
    'How many zones reported demand that day. Records what EIA had, not what we expected.';

-- Days an earlier run already fetched, so upgrading does not re-fetch years of history.
--
-- The evidence that a day was fetched is that it holds a full day's shape for a
-- substantial share of the zones that report. Half is a deliberately loose bar: the
-- cost of marking a day that was in fact partial is that it stays partial until someone
-- runs --force, while the cost of re-fetching every historical day is paid on every run
-- for ever. A day still being written now will not reach the bar and is left unmarked.
INSERT INTO backfill_day (day, source, zones_reporting, rows_written)
SELECT day, 'eia', zones, 0
  FROM (
        SELECT day, count(*) AS zones
          FROM (
                SELECT period_utc::date AS day, zone_key
                  FROM obs_region_hourly
                 WHERE demand_mw IS NOT NULL
                 GROUP BY 1, 2
                HAVING count(*) >= 23
               ) AS full_days
         GROUP BY 1
       ) AS fetched
 WHERE zones >= (
         SELECT greatest(count(*) / 2, 1)
           FROM zones
          WHERE in_map AND (capabilities->>'demand')::boolean
       )
ON CONFLICT (day) DO NOTHING;
