/**
 * The map endpoints.
 *
 * `/map/snapshot` serves a precomputed hour verbatim from `map_snapshot`, so rendering
 * never touches an observation table.
 *
 * `/map/window` is the whole point of the slider: one request returns every hour in the
 * range, and scrubbing indexes into what is already loaded rather than issuing a request
 * per step.
 */
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../lib/db.js';
import { ApiError } from '../lib/errors.js';
import { buildMeta, isoInstant, latestDataPeriod } from '../lib/meta.js';
import { hoursBetween, parseWindow } from '../lib/period.js';

/** Fixed order, matching the builder. Consumers index by position. */
const METRICS = [
  'demand_mw',
  'net_generation_mw',
  'net_interchange_mw',
  'renewable_share',
  'low_carbon_share',
] as const;

interface SnapshotRow {
  period_utc: Date;
  payload: {
    period: string;
    metrics: string[];
    zones: Record<string, (number | null)[]>;
    built_at: string;
  };
}

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

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/map/window',
    async (request, reply) => {
      const { from, to } = request.query;
      if (from === undefined || to === undefined) {
        throw ApiError.badRequest('both from and to are required, as ISO-8601 UTC hours');
      }

      const window = parseWindow(from, to);
      const rows = await sql<SnapshotRow[]>`
        SELECT period_utc, payload
          FROM map_snapshot
         WHERE period_utc BETWEEN ${window.from} AND ${window.to}
         ORDER BY period_utc
      `;

      const byPeriod = new Map(rows.map((row) => [row.period_utc.getTime(), row.payload]));
      const periods = hoursBetween(window.from, window.to);

      // Every zone that appears in any hour appears in all of them, so a client can
      // index by position without checking whether a key exists for this step.
      const keys = new Set<string>();
      for (const payload of byPeriod.values()) {
        for (const key of Object.keys(payload.zones)) keys.add(key);
      }
      const empty: (number | null)[] = METRICS.map(() => null);

      const zones: Record<string, (number | null)[][]> = {};
      for (const key of [...keys].sort()) {
        zones[key] = periods.map((period) => {
          const payload = byPeriod.get(period.getTime());
          return payload?.zones[key] ?? empty;
        });
      }

      const latest = await latestDataPeriod(sql);
      reply.header('Cache-Control', 'public, max-age=60, s-maxage=300');
      return reply.send({
        periods: periods.map((period) => isoInstant(period)),
        metrics: [...METRICS],
        zones,
        meta: buildMeta(latest),
      });
    },
  );
};
