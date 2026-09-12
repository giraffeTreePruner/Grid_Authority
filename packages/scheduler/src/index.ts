/**
 * The scheduler.
 *
 * Runs under PM2 as a single fork process and spawns the Python worker CLIs on a cron.
 * It holds no state beyond which jobs are currently running: everything durable lives in
 * the database, and `source_status` is what actually records whether a job succeeded.
 *
 * A job already running when its next tick arrives is skipped rather than run twice.
 * Two polls writing the same window concurrently would be safe — the upserts are
 * idempotent — but it would double the request budget for nothing.
 */
import { resolve } from 'node:path';
import cron from 'node-cron';
import pino from 'pino';
import { runJob, WORKER_TIMEOUT_MS } from './runner.js';
import { JOBS } from './schedule.js';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'scheduler' },
});

/** The repository root, from which `uv run` finds the worker project. */
const repoRoot = resolve(process.env.GRID_ROOT ?? process.cwd());

/** How the workers are invoked. Overridable so a host can pin an absolute uv path. */
const WORKER_COMMAND = process.env.WORKER_COMMAND ?? 'uv';
const WORKER_ARGS = (process.env.WORKER_ARGS ?? 'run,eia').split(',');

const running = new Set<string>();

export const executeJob = async (name: string, args: string[]): Promise<void> => {
  if (running.has(name)) {
    logger.warn({ job: name }, 'previous run still in progress; skipping this tick');
    return;
  }

  running.add(name);
  const started = new Date().toISOString();
  logger.info({ job: name, started }, 'job starting');

  try {
    const result = await runJob(name, {
      command: WORKER_COMMAND,
      args: [...WORKER_ARGS, ...args],
      cwd: repoRoot,
      timeoutMs: WORKER_TIMEOUT_MS,
    });

    const fields = {
      job: name,
      exit_code: result.exitCode,
      signal: result.signal,
      timed_out: result.timedOut,
      duration_ms: result.durationMs,
      summary: result.summary,
    };

    if (result.succeeded) {
      logger.info(fields, 'job finished');
      for (const warning of result.summary?.warnings ?? []) {
        logger.warn({ job: name, warning }, 'job warning');
      }
    } else if (result.timedOut) {
      logger.error(
        { ...fields, stderr: result.stderr },
        `job killed after ${WORKER_TIMEOUT_MS / 60000} minutes`,
      );
    } else {
      logger.error({ ...fields, stderr: result.stderr }, 'job failed');
    }
  } finally {
    running.delete(name);
  }
};

const main = (): void => {
  if (process.env.TZ !== undefined && process.env.TZ !== 'UTC') {
    logger.warn({ tz: process.env.TZ }, 'TZ is not UTC; schedules are expressed in UTC');
  }

  for (const job of JOBS) {
    if (!cron.validate(job.cron)) {
      logger.fatal({ job: job.name, cron: job.cron }, 'invalid cron expression');
      process.exit(1);
    }
    cron.schedule(job.cron, () => void executeJob(job.name, job.args), { timezone: 'UTC' });
    logger.info({ job: job.name, cron: job.cron, why: job.why }, 'scheduled');
  }

  logger.info({ root: repoRoot, jobs: JOBS.length }, 'scheduler ready');

  const shutdown = (signal: string): void => {
    logger.info({ signal, running: [...running] }, 'shutting down');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

// Starts unconditionally: nothing imports this module, and the tests exercise runner.ts
// and schedule.ts directly. Guarding on process.argv[1] breaks under PM2, which loads
// the app through its own process container — the scheduler exited immediately and PM2
// restarted it in a loop.
main();
