/**
 * What /health is entitled to call a problem.
 *
 * The endpoint judged every row in `source_status` against one six-hour rule, which
 * made a healthy host report 503 permanently. Two independent causes, both visible in
 * what production actually returned:
 *
 *   backfill  last success 3 days ago   — a one-shot load that will never run again
 *   revise    last success 13 hours ago — a daily job, outside six hours most of the day
 *
 * An always-red check is worse than none: the runbook points an external monitor at
 * this endpoint, and the deploy script had already been taught to ignore its status.
 * So these tests are mostly about what must *not* count as degraded.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX } from '../src/app.js';
import { JOB_BUDGET_MINUTES } from '../src/routes/health.js';
import { createHarness, databaseUrl, type Harness } from './helpers.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const withDatabase = databaseUrl() === undefined ? describe.skip : describe;

describe('the budgets', () => {
  it('only cover jobs the scheduler actually runs', () => {
    // A budget for a job that never runs is the bug this file exists for: it can only
    // ever expire. Read from the scheduler, which owns timing, so the two cannot drift
    // apart without this failing.
    const schedule = readFileSync(resolve(repoRoot, 'packages/scheduler/src/schedule.ts'), 'utf8');
    const scheduled = [...schedule.matchAll(/name: '([^']+)'/g)].map((match) => match[1]);
    expect(scheduled.length).toBeGreaterThan(0);

    for (const job of Object.keys(JOB_BUDGET_MINUTES)) {
      expect(scheduled, `${job} has a budget but is not scheduled`).toContain(job);
    }
  });

  it('gives every job more than one run before it counts as failing', () => {
    // A single missed run is a blip. The point of a budget is to tell a blip from an
    // ingest that has stopped.
    expect(JOB_BUDGET_MINUTES.poll).toBeGreaterThan(30);
    expect(JOB_BUDGET_MINUTES.probe).toBeGreaterThan(60);
    // Daily, so anything under a day and a bit is guaranteed to expire every day.
    expect(JOB_BUDGET_MINUTES.revise).toBeGreaterThan(24 * 60);
  });
});

withDatabase('GET /health', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.sql`DELETE FROM source_status`;
  });

  const record = async (job: string, minutesAgo: number | null) => {
    const at = minutesAgo === null ? null : new Date(Date.now() - minutesAgo * 60_000);
    await harness.sql`
      INSERT INTO source_status (source, job, last_success_at) VALUES ('eia', ${job}, ${at})
    `;
  };

  const health = async () => {
    const response = await harness.app.inject({ method: 'GET', url: `${API_PREFIX}/health` });
    return { code: response.statusCode, body: response.json() };
  };

  it('is ok when the scheduled jobs are inside their budgets', async () => {
    await record('poll', 5);
    await record('probe', 55);
    await record('revise', 13 * 60);

    const { code, body } = await health();
    expect(code).toBe(200);
    expect(body.status).toBe('ok');
  });

  it('does not go degraded over a daily job that ran this morning', async () => {
    // Thirteen hours is normal for `revise` and used to be 503 for eighteen hours a day.
    await record('poll', 5);
    await record('revise', 13 * 60);

    expect((await health()).code).toBe(200);
  });

  it('does not go degraded over a one-shot load that finished days ago', async () => {
    // Exactly what production returned: a backfill from three days earlier.
    await record('poll', 5);
    await record('backfill', 4795);

    const { code, body } = await health();
    expect(code).toBe(200);
    expect(body.status).toBe('ok');

    // Still reported, and it says why it is not being counted.
    const backfill = body.sources.find((entry: { job: string }) => entry.job === 'backfill');
    expect(backfill.minutes_stale).toBeGreaterThan(4000);
    expect(backfill.expected_within_minutes).toBeNull();
  });

  it('goes degraded when the poll really has stopped', async () => {
    // The thing the check is for. If this ever passes as healthy the endpoint is
    // decoration.
    await record('poll', 6 * 60);

    const { code, body } = await health();
    expect(code).toBe(503);
    expect(body.status).toBe('degraded');
  });

  it('goes degraded when a scheduled job has never succeeded', async () => {
    await record('poll', null);
    expect((await health()).code).toBe(503);
  });

  it('reports starting on a host where nothing scheduled has run yet', async () => {
    // A restore from a dump arrives with a backfill row and nothing else. Judging only
    // scheduled jobs would otherwise have called that healthy.
    await record('backfill', 10);

    const { code, body } = await health();
    expect(code).toBe(200);
    expect(body.status).toBe('starting');
  });

  it('reports starting on an empty status table', async () => {
    const { code, body } = await health();
    expect(code).toBe(200);
    expect(body.status).toBe('starting');
  });
});
