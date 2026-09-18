/**
 * GET /health
 *
 * 503 when the database is unreachable, or when a job that is supposed to run on a
 * schedule has not succeeded within the budget for its cadence. A health check that
 * stays green while ingest is dead is worse than none.
 *
 * It used to hold every row in `source_status` to one six-hour rule, which made it
 * permanently red for two separate reasons. `backfill` is a one-shot historical load —
 * it is not in the scheduler's job list and is never going to run again — so its row
 * ages forever and took the host down with it. And `revise` runs once a day at 04:15,
 * so it sat outside a six-hour budget for eighteen hours out of every twenty-four.
 *
 * A check that is always red costs more than no check at all: the runbook points an
 * external monitor at this endpoint, and the deploy script had already been taught to
 * stop trusting it. So a job is judged only against the cadence it actually has, and a
 * job with no cadence is reported without being judged.
 */
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../lib/db.js';
import { isoInstant } from '../lib/meta.js';

/**
 * How long each scheduled job may go without succeeding before the host is degraded.
 *
 * One number cannot serve a job that runs twice an hour and a job that runs once a
 * day. Each budget is several missed runs rather than one, so a single failure is not
 * an outage, and the timing it is derived from lives in the scheduler —
 * `health.test.ts` reads that file and fails if a job here is not one that runs.
 *
 * `warm-zone-detail` is scheduled but records no status, so it has no row to judge. If
 * it ever starts recording one it belongs here too.
 */
export const JOB_BUDGET_MINUTES: Readonly<Record<string, number>> = {
  // Twice an hour. Three hours is six missed cycles, and matches the three-hour
  // freshness the API already reports through `meta.stale`.
  poll: 3 * 60,
  // Hourly, and it only measures lag, so it can miss a few without anyone suffering.
  probe: 6 * 60,
  // Daily at 04:15. Thirty hours leaves room for a missed run before it is a problem.
  revise: 30 * 60,
};

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
    const sources = rows.map((row) => {
      const budget = JOB_BUDGET_MINUTES[row.job];
      return {
        source: row.source,
        job: row.job,
        last_success_at: isoInstant(row.last_success_at),
        minutes_stale:
          row.last_success_at === null
            ? null
            : Math.floor((now - row.last_success_at.getTime()) / 60000),
        // Null for a job that is not on a schedule. Reported either way, so a reader
        // can still see when the backfill last ran and why it is not being counted.
        expected_within_minutes: budget ?? null,
      };
    });

    // A job that is supposed to run and never has is worse than a stale one, not
    // better, so a null last_success_at counts against it rather than as no news. A
    // job with no cadence is not held to one: it has already done its work, or it is
    // run by hand, and either way an ageing row says nothing about this host.
    const tooStale = sources.some(
      (entry) =>
        entry.expected_within_minutes !== null &&
        (entry.minutes_stale === null || entry.minutes_stale > entry.expected_within_minutes),
    );

    // A freshly deployed host between sync-zones and its first poll. Reporting that as
    // degraded would make every deploy look broken for half an hour, so it is 200 under
    // a distinct status rather than a green light that hides an ingest which has never
    // run.
    //
    // "No rows at all" is not the test, because it is not the only way to be new: a host
    // restored from a dump arrives with a backfill row and nothing else, and judging
    // only scheduled jobs would otherwise have called that healthy. It is starting until
    // a job that is actually on a schedule has reported.
    const scheduledReported = sources.some((entry) => entry.expected_within_minutes !== null);
    const starting = dbUp && !scheduledReported;
    const healthy = dbUp && !tooStale;

    const status = !dbUp || tooStale ? 'degraded' : starting ? 'starting' : 'ok';
    return reply.code(healthy ? 200 : 503).send({
      status,
      db: dbUp ? 'up' : 'down',
      sources,
    });
  });
};
