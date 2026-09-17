-- Precomputed zone detail for the coarse windows.
--
-- `all` reads seven years of hourly rows for one zone and aggregates seventeen mode
-- columns across them. For a small balancing authority that takes under a second; for
-- Duke, MISO or NYISO it runs past the five-second statement timeout every time, so the
-- panel's longest window was simply broken for most of the map.
--
-- The document is stored exactly as the API serves it, the same arrangement
-- `map_snapshot` uses: computed once, served verbatim, never assembled while someone
-- waits. The API writes its own entry after computing one, and a warming job keeps them
-- fresh so a reader is almost never the one paying for a rebuild.
--
-- Cached for the bucketed windows only. The hourly ones are fast and change every poll,
-- and serving those from a cache would trade a real problem for a staleness one.

CREATE TABLE zone_detail_cache (
    zone_key   text        NOT NULL REFERENCES zones (key),
    window_key text        NOT NULL,
    payload    jsonb       NOT NULL,
    built_at   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (zone_key, window_key),

    CONSTRAINT zone_detail_cache_window_known
        CHECK (window_key IN ('30d', '90d', '1y', 'all'))
);

CREATE INDEX zone_detail_cache_built_idx ON zone_detail_cache (built_at);

COMMENT ON TABLE zone_detail_cache IS
    'Zone detail documents for the bucketed windows. Derived; safe to truncate.';

-- The API is read-only apart from what it derives itself. It may write and refresh its
-- own cache; it still cannot touch an observation.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grid_api') THEN
        GRANT SELECT, INSERT, UPDATE ON zone_detail_cache TO grid_api;
    END IF;
END
$$;
