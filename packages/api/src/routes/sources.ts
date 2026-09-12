/**
 * GET /sources — the registry joined with what the jobs observed.
 *
 * Inactive entries are included. The `emaps_method` entry exists so its label is fixed
 * from the start: any series computed with that methodology must carry it verbatim, and
 * the registry is where that label lives.
 *
 * Latency is reported from `probe_log`, so the figure is measured rather than assumed.
 */
import type { FastifyInstance } from 'fastify';
import { loadSources } from '../config/index.js';
import type { Sql } from '../lib/db.js';
import { buildMeta, isoInstant, latestDataPeriod } from '../lib/meta.js';

interface StatusRow {
  source: string;
  job: string;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  data_latest_period: Date | null;
}

interface LatencyRow {
  dataset: string;
  lag_minutes: number | null;
  latest_period: Date | null;
  checked_at: Date;
  readings: number;
}

export const sourceRoutes = (app: FastifyInstance, sql: Sql): void => {
  const registry = loadSources();

  app.get('/sources', async (_request, reply) => {
    const [statuses, latencies, latest] = await Promise.all([
      sql<StatusRow[]>`
        SELECT source, job, last_success_at, last_failure_at, data_latest_period
          FROM source_status ORDER BY source, job
      `,
      sql<LatencyRow[]>`
        SELECT DISTINCT ON (dataset)
               dataset, lag_minutes, latest_period, checked_at,
               count(*) OVER (PARTITION BY dataset) AS readings
          FROM probe_log
         ORDER BY dataset, checked_at DESC
      `,
      latestDataPeriod(sql),
    ]);

    const sources = registry.map((source) => ({
      id: source.id,
      label: source.label,
      attribution: source.attribution,
      url: source.url,
      license: source.license,
      independent: source.independent,
      notes: source.notes,
      active: source.active,
      jobs: statuses
        .filter((status) => status.source === source.id)
        .map((status) => ({
          job: status.job,
          last_success_at: isoInstant(status.last_success_at),
          last_failure_at: isoInstant(status.last_failure_at),
          data_latest_period: isoInstant(status.data_latest_period),
        })),
      // Observed, not assumed. Empty until the probe has run.
      observed_latency:
        source.id === 'eia'
          ? latencies.map((row) => ({
              dataset: row.dataset,
              lag_minutes: row.lag_minutes,
              latest_period: isoInstant(row.latest_period),
              measured_at: isoInstant(row.checked_at),
              readings: Number(row.readings),
            }))
          : [],
    }));

    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.send({ sources, meta: buildMeta(latest) });
  });
};
