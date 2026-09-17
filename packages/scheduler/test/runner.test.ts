/**
 * The job runner.
 *
 * What matters is that a failure is never mistaken for a success: a non-zero exit, a
 * hang, and an unparseable summary must each be reported as what they are.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSummary, runJob } from '../src/runner.js';
import { JOBS } from '../src/schedule.js';

const cwd = resolve(import.meta.dirname, '..');

describe('summary parsing', () => {
  it('reads the last line of stdout as JSON', () => {
    const stdout = 'some chatter\nmore chatter\n{"job":"poll","rows_written":42}\n';
    expect(parseSummary(stdout)).toEqual({ job: 'poll', rows_written: 42 });
  });

  it('returns null when the last line is not JSON', () => {
    expect(parseSummary('traceback...\nValueError: boom\n')).toBeNull();
  });

  it('returns null for empty output', () => {
    expect(parseSummary('')).toBeNull();
    expect(parseSummary('\n\n')).toBeNull();
  });

  it('does not mistake a JSON-looking fragment for a summary', () => {
    expect(parseSummary('{"partial": ')).toBeNull();
  });
});

describe('running a job', () => {
  it('captures a successful run and its summary', async () => {
    const result = await runJob('demo', {
      command: 'node',
      args: [
        '-e',
        'console.log("working"); console.log(JSON.stringify({job:"demo",rows_written:3}))',
      ],
      cwd,
    });

    expect(result.succeeded).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual({ job: 'demo', rows_written: 3 });
  });

  it('reports a non-zero exit as a failure and keeps stderr', async () => {
    const result = await runJob('demo', {
      command: 'node',
      args: ['-e', 'console.error("it broke"); process.exit(2)'],
      cwd,
    });

    expect(result.succeeded).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('it broke');
  });

  it('kills a job that outstays its timeout, and says so', async () => {
    const result = await runJob('demo', {
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd,
      timeoutMs: 150,
    });

    expect(result.timedOut).toBe(true);
    expect(result.succeeded).toBe(false);
  }, 10_000);

  it('reports a command that cannot be spawned rather than hanging', async () => {
    const result = await runJob('demo', {
      command: 'definitely-not-a-real-command',
      args: [],
      cwd,
    });

    expect(result.succeeded).toBe(false);
    expect(result.stderr).toContain('failed to spawn');
  });

  it('succeeds even when a job prints no summary', async () => {
    const result = await runJob('demo', { command: 'node', args: ['-e', ''], cwd });
    expect(result.succeeded).toBe(true);
    expect(result.summary).toBeNull();
  });
});

describe('the schedule', () => {
  it('covers the jobs the spec requires, at the stated times', () => {
    expect(JOBS.map((job) => job.name).sort()).toEqual([
      'poll',
      'probe',
      'revise',
      'warm-zone-detail',
    ]);
    expect(JOBS.find((job) => job.name === 'poll')?.cron).toBe('10,40 * * * *');
    expect(JOBS.find((job) => job.name === 'probe')?.cron).toBe('50 * * * *');
    expect(JOBS.find((job) => job.name === 'revise')?.cron).toBe('15 4 * * *');
  });

  it('keeps the jobs off each other minutes', () => {
    // One fork process on two vCPUs. Two jobs on the same minute means the second waits
    // behind the first, and warming walks every zone, so it is the one that would hold
    // a poll up.
    const minutes = JOBS.map((job) => job.cron.split(' ')[0]);
    expect(new Set(minutes).size).toBe(minutes.length);
  });

  it('explains why each job runs when it does', () => {
    for (const job of JOBS) expect(job.why.length).toBeGreaterThan(20);
  });
});
