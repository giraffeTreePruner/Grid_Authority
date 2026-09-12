/**
 * Database access.
 *
 * The API is read-only. A statement timeout is set on every connection so a slow query
 * fails fast rather than holding a worker while the map waits.
 */
import postgres from 'postgres';

export type Sql = postgres.Sql;

export const STATEMENT_TIMEOUT_MS = 5000;

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
