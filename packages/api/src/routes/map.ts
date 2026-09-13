/**
 * The map endpoints.
 *
 * `/map/snapshot` serves a precomputed hour verbatim from `map_snapshot`, so rendering
 * never touches an observation table.
 *
 * `/map/window` is the whole point of the slider: one request returns every period in
 * the range, and scrubbing indexes into what is already loaded rather than issuing a
 * request per step.
 *
 * A window may be read at `hour` resolution, which serves measurements, or at `day`,
 * `week` or `month`, which serve summaries from `map_snapshot_agg` and take a
 * `statistic` of `mean` or `peak`. The response shape is identical in both cases, so a
 * client switches resolution without switching code paths.
 */
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../lib/db.js';
import { ApiError } from '../lib/errors.js';
import { buildMeta, isoInstant, latestDataPeriod } from '../lib/meta.js';
import {
  hoursBetween,
  parseResolution,
  parseStatistic,
  parseWindow,
  type Resolution,
  type Statistic,
} from '../lib/period.js';

/** Fixed order, matching the builder. Consumers index by position. */
const METRICS = [
  'demand_mw',
  'net_generation_mw',
  'net_interchange_mw',
  'renewable_share',
  'low_carbon_share',
] as const;

interface AggregateRow {
  period_utc: Date;
  payload: {
    period: string;
    resolution: string;
    metrics: string[];
    statistics: string[];
    zones: Record<string, Record<Statistic, (number | null)[]>>;
    hours: number;
    built_at: string;
  };
}

interface SnapshotRow {
  period_utc: Date;
  payload: {
    period: string;
    metrics: string[];
    zones: Record<string, (number | null)[]>;
    built_at: string;
  };
}

/** One entry per period: zone key to its value array. */
type ByPeriod = Map<number, Record<string, (number | null)[]>>;

interface WindowRows {
  periods: Date[];
  byPeriod: ByPeriod;
}

/** Hourly measurements, served from `map_snapshot`. */
const hourlyWindow = async (sql: Sql, window: { from: Date; to: Date }): Promise<WindowRows> => {
  const rows = await sql<SnapshotRow[]>`
    SELECT period_utc, payload
      FROM map_snapshot
     WHERE period_utc BETWEEN ${window.from} AND ${window.to}
     ORDER BY period_utc
  `;

  const byPeriod: ByPeriod = new Map(
    rows.map((row) => [row.period_utc.getTime(), row.payload.zones]),
  );
  return { periods: hoursBetween(window.from, window.to), byPeriod };
};

/**
 * Day, week or month summaries, served from `map_snapshot_agg`.
 *
 * The stored document carries both statistics; one is chosen here so the response has
 * the same shape as an hourly one and a client needs no second code path.
 */
const coarseWindow = async (
  sql: Sql,
  window: { from: Date; to: Date },
  resolution: Resolution,
  statistic: Statistic,
): Promise<WindowRows> => {
  const rows = await sql<AggregateRow[]>`
    SELECT period_utc, payload
      FROM map_snapshot_agg
     WHERE resolution = ${resolution}
       AND period_utc BETWEEN date_trunc(${resolution}, ${window.from}::timestamptz)
                          AND ${window.to}
     ORDER BY period_utc
  `;

  const byPeriod: ByPeriod = new Map();
  for (const row of rows) {
    const zones: Record<string, (number | null)[]> = {};
    for (const [key, statistics] of Object.entries(row.payload.zones)) {
      zones[key] = statistics[statistic];
    }
    byPeriod.set(row.period_utc.getTime(), zones);
  }

  // The periods actually stored, in order. Unlike hours, coarse periods are not
  // generated: a month nobody reported has no row, and inventing one would put an
  // empty step on the slider where there is simply no data.
  return { periods: rows.map((row) => row.period_utc), byPeriod };
};

export const mapRoutes = (app: FastifyInstance, sql: Sql): void => {
  app.get<{ Querystring: { at?: string } }>('/map/snapshot', async (request, reply) => {
    const { at } = request.query;

    const rows = at
      ? await sql<SnapshotRow[]>`
          SELECT period_utc, payload FROM map_snapshot WHERE period_utc = ${at}
        `
      : await sql<SnapshotRow[]>`
          SELECT period_utc, payload FROM map_snapshot ORDER BY period_utc DESC LIMIT 1
        `;

    const row = rows[0];
    if (row === undefined) {
      throw ApiError.notFound(
        at === undefined
          ? 'No snapshot has been built yet.'
          : `No snapshot for ${at}. Snapshots exist only for hours that have been ingested.`,
      );
    }

    const latest = await latestDataPeriod(sql);
    reply.header('Cache-Control', 'public, max-age=60, s-maxage=300');
    return reply.send({ ...row.payload, meta: buildMeta(latest) });
  });

  app.get<{
    Querystring: { from?: string; to?: string; resolution?: string; statistic?: string };
  }>('/map/window', async (request, reply) => {
    const { from, to } = request.query;
    if (from === undefined || to === undefined) {
      throw ApiError.badRequest('both from and to are required, as ISO-8601 UTC hours');
    }

    const resolution = parseResolution(request.query.resolution);
    const statistic = parseStatistic(request.query.statistic, resolution);
    const window = parseWindow(from, to, resolution);

    const { periods, byPeriod } =
      resolution === 'hour'
        ? await hourlyWindow(sql, window)
        : await coarseWindow(sql, window, resolution, statistic);

    // Every zone that appears in any period appears in all of them, so a client can
    // index by position without checking whether a key exists for this step.
    const keys = new Set<string>();
    for (const payload of byPeriod.values()) {
      for (const key of Object.keys(payload)) keys.add(key);
    }
    const empty: (number | null)[] = METRICS.map(() => null);

    const zones: Record<string, (number | null)[][]> = {};
    for (const key of [...keys].sort()) {
      zones[key] = periods.map((period) => byPeriod.get(period.getTime())?.[key] ?? empty);
    }

    const latest = await latestDataPeriod(sql);
    reply.header('Cache-Control', 'public, max-age=60, s-maxage=300');
    return reply.send({
      periods: periods.map((period) => isoInstant(period)),
      metrics: [...METRICS],
      resolution,
      statistic: resolution === 'hour' ? null : statistic,
      zones,
      meta: buildMeta(latest),
    });
  });
};
