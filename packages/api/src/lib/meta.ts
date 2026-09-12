/**
 * The `meta` object carried by every successful response.
 *
 * `stale` is the honest signal: when the newest data is more than three hours old, a
 * client should say so rather than presenting old numbers as current.
 */
import type { Sql } from './db.js';

export const STALE_AFTER_HOURS = 3;

export interface Meta {
  generated_at: string;
  sources: string[];
  data_latest_period: string | null;
  stale: boolean;
}

export const isoInstant = (value: Date | string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : `${date.toISOString().slice(0, 19)}Z`;
};

/**
 * The newest hour any source holds data for.
 *
 * Read from `source_status`, which the jobs maintain, rather than from a scan of the
 * observation tables.
 */
export const latestDataPeriod = async (sql: Sql): Promise<Date | null> => {
  const rows = await sql<{ latest: Date | null }[]>`
    SELECT max(data_latest_period) AS latest FROM source_status
  `;
  return rows[0]?.latest ?? null;
};

export const buildMeta = (latest: Date | null, now: Date = new Date()): Meta => {
  const staleAfterMs = STALE_AFTER_HOURS * 3600 * 1000;
  return {
    generated_at: isoInstant(now) as string,
    sources: ['eia'],
    data_latest_period: isoInstant(latest),
    stale: latest === null || now.getTime() - latest.getTime() > staleAfterMs,
  };
};
