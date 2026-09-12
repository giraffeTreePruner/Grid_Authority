-- Zone registry. Synced from config/zones.yaml by the sync-zones command.
--
-- The registry is the single source of truth for what exists. Sync is upsert-only:
-- it never deletes a zone that has observations hanging off it.

CREATE TABLE zones (
    key              text PRIMARY KEY,
    eia_respondent   text NOT NULL UNIQUE,
    name             text NOT NULL,
    short_name       text NOT NULL,
    interconnection  text,
    timezone         text NOT NULL,
    type             text NOT NULL,
    parent           text REFERENCES zones (key),
    in_map           boolean NOT NULL,
    capabilities     jsonb NOT NULL,
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT zones_type_known
        CHECK (type IN ('balancing_authority', 'region', 'country_total')),

    CONSTRAINT zones_interconnection_known
        CHECK (interconnection IS NULL
               OR interconnection IN ('eastern', 'western', 'texas', 'alaska', 'hawaii')),

    -- A balancing authority sits in exactly one interconnection. An aggregate spans
    -- several and names none.
    CONSTRAINT zones_balancing_authority_has_interconnection
        CHECK (type <> 'balancing_authority' OR interconnection IS NOT NULL),

    -- Aggregates must stay off the map: drawing them would double-count the
    -- balancing authorities they contain.
    CONSTRAINT zones_only_balancing_authorities_on_map
        CHECK (in_map = false OR type = 'balancing_authority'),

    CONSTRAINT zones_parent_is_not_self
        CHECK (parent IS NULL OR parent <> key)
);

CREATE INDEX zones_in_map_idx ON zones (key) WHERE in_map;

COMMENT ON TABLE zones IS
    'Zone registry, synced from config/zones.yaml. Upsert-only.';
COMMENT ON COLUMN zones.interconnection IS
    'Null for region and country_total zones, which span more than one interconnection.';
COMMENT ON COLUMN zones.capabilities IS
    'Which EIA series this zone publishes, as observed from the API rather than assumed.';
