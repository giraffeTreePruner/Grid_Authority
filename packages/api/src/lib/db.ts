/**
 * Database access.
 *
 * The API is read-only. A statement timeout is set on every connection so a slow query
 * fails fast rather than holding a worker while the map waits.
 *
 * Two pools, because two callers want opposite things from a slow query. A reader wants
 * it abandoned quickly: five seconds, then a 503 saying so. The job that fills the
 * zone-detail cache wants it to *finish*, because the whole point of that job is to pay
 * the cost once so no reader has to.
 */
import postgres from 'postgres';

export type Sql = postgres.Sql;

export const STATEMENT_TIMEOUT_MS = 5000;

/**
 * The ceiling for a cache build, which is a different job from answering a reader.
 *
 * Under nginx's `proxy_read_timeout 30s`, so a build that runs long is cut off by
 * Postgres with a 57014 the API can explain, rather than by the proxy with a bare 504.
 *
 * This existing gap is why the warming job never worked: it fills the cache by asking
 * the API, so its compute ran under the reader's five seconds and died exactly where a
 * reader's did. The cache could therefore only ever hold entries fast enough not to
 * need caching, which is every zone except the ones that needed it.
 */
export const BUILD_STATEMENT_TIMEOUT_MS = 20_000;

export const connect = (url: string): Sql =>
  postgres(url, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    // UTC everywhere: a timestamp must not change meaning on its way out.
    connection: { timezone: 'UTC', statement_timeout: STATEMENT_TIMEOUT_MS },
    transform: { undefined: null },
    onnotice: () => {},
  });

/**
 * A pool for building cache entries, with a longer ceiling and almost no width.
 *
 * Two connections, not ten. These queries read one zone's entire history and are the
 * most expensive thing the host runs; the limit is what stops a burst of them from
 * becoming the reason the map is slow. The warming job is paced at one request every
 * 1.2s and is the only intended caller, so it never needs the second connection — that
 * one is headroom, so a build already running cannot block the next one outright.
 */
export const connectBuilder = (url: string): Sql =>
  postgres(url, {
    max: 2,
    idle_timeout: 30,
    connect_timeout: 10,
    connection: { timezone: 'UTC', statement_timeout: BUILD_STATEMENT_TIMEOUT_MS },
    transform: { undefined: null },
    onnotice: () => {},
  });
