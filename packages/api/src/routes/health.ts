/**
 * GET /health
 *
 * 503 when the database is unreachable or any source has not succeeded in six hours.
 * A health check that stays green while ingest is dead is worse than none.
 */
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../lib/db.js';
import { isoInstant } from '../lib/meta.js';

export const UNHEALTHY_AFTER_HOURS = 6;

interface SourceRow {
  source: string;
  job: string;
  last_success_at: Date | null;
}

export const healthRoutes = (app: FastifyInstance, sql: Sql): void => {
  app.get('/health', async (_request, reply) => {
    let rows: SourceRow[] = [];
    let dbUp = true;
    try {
      rows = await sql<SourceRow[]>`
        SELECT source, job, last_success_at FROM source_status ORDER BY source, job
      `;
    } catch {
      dbUp = false;
    }

    const now = Date.now();
    const sources = rows.map((row) => ({
      source: row.source,
      job: row.job,
      last_success_at: isoInstant(row.last_success_at),
      minutes_stale:
        row.last_success_at === null
          ? null
          : Math.floor((now - row.last_success_at.getTime()) / 60000),
    }));

    // A registered source that has never succeeded is worse than a stale one, not
    // better, so a null last_success_at counts as stale rather than as no news.
    const tooStale = sources.some(
      (entry) => entry.minutes_stale === null || entry.minutes_stale > UNHEALTHY_AFTER_HOURS * 60,
    );

    // No rows at all is a different thing: a freshly deployed host between
    // sync-zones and its first poll. Reporting that as degraded would make every
    // deploy look broken for half an hour, so it is 200 under a distinct status
    // rather than a green light that hides an ingest which has never run.
    const starting = dbUp && sources.length === 0;
    const healthy = dbUp && !tooStale;

    const status = !dbUp || tooStale ? 'degraded' : starting ? 'starting' : 'ok';
    return reply.code(healthy ? 200 : 503).send({
      status,
      db: dbUp ? 'up' : 'down',
      sources,
    });
  });
};
