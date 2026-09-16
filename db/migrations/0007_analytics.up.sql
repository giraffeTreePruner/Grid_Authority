-- Visitor counting, on terms that do not require trusting anyone.
--
-- Two tables and one deliberate limitation.
--
-- `visitor_salt` holds one random salt per UTC day. A visitor's identity is
-- hash(salt || ip || user_agent), so the same person is one identity within a day and a
-- different one tomorrow. The raw IP is never stored, and once a day's salt is deleted
-- nobody -- including whoever runs this -- can re-derive that day's hashes or link them
-- to anything. Salts older than eight days are dropped by the poll job.
--
-- The consequence, stated plainly because the numbers must be read correctly: a true
-- all-time unique visitor count is impossible here. Counting one person across months
-- requires a stable identifier, which is the thing being refused. Weekly and all-time
-- figures are therefore sums of daily uniques, which counts a returning reader once per
-- day they visit. The page says so.

CREATE TABLE visitor_salt (
    day        date        PRIMARY KEY,
    salt       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE visitor_salt IS
    'One random salt per UTC day. Deleting a day''s salt makes its hashes unlinkable.';

CREATE TABLE page_hit (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at  timestamptz NOT NULL DEFAULT now(),
    day          date        NOT NULL,
    path         text        NOT NULL,
    -- hash(day salt || ip || user agent). Not reversible, and not comparable across days.
    visitor      text        NOT NULL
);

CREATE INDEX page_hit_day_idx ON page_hit (day);
CREATE INDEX page_hit_day_visitor_idx ON page_hit (day, visitor);

COMMENT ON COLUMN page_hit.visitor IS
    'Per-day pseudonym. Comparable within a day, never between days.';

-- The API is otherwise read-only, deliberately, so a bug in it cannot write whatever it
-- intends to. This is the one exception and it is granted narrowly: it may append its
-- own telemetry and read it back, and nothing else. It cannot UPDATE or DELETE even
-- here, so a hit once recorded cannot be rewritten by the process that recorded it.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grid_api') THEN
        GRANT SELECT, INSERT ON page_hit TO grid_api;
        GRANT SELECT, INSERT ON visitor_salt TO grid_api;
    END IF;
END
$$;
