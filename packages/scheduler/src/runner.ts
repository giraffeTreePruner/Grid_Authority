/**
 * Running one worker job.
 *
 * The workers are Python CLIs that exit non-zero on failure and print a single-line JSON
 * summary as their last line of stdout. This captures both, so a failure is visible in
 * the log with its reason rather than as a silent gap in the data.
 *
 * A job still running after the timeout is killed and recorded as a failure. A hung poll
 * that never returns would otherwise block every later cycle behind it.
 */
import { spawn } from 'node:child_process';

export const WORKER_TIMEOUT_MS = 10 * 60 * 1000;

export interface JobSummary {
  job?: string;
  rows_written?: number;
  requests?: number;
  duration_s?: number;
  warnings?: string[];
  [key: string]: unknown;
}

export interface JobResult {
  name: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  summary: JobSummary | null;
  stderr: string;
  succeeded: boolean;
}

/**
 * The last line of stdout, parsed as the job's JSON summary.
 *
 * A job that fails early may print nothing parseable; that is not itself an error, the
 * exit code is what decides success.
 */
export const parseSummary = (stdout: string): JobSummary | null => {
  const lines = stdout.trimEnd().split('\n');
  const last = lines.at(-1)?.trim();
  if (last === undefined || last === '' || !last.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(last);
    return typeof parsed === 'object' && parsed !== null ? (parsed as JobSummary) : null;
  } catch {
    return null;
  }
};

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Spawn a worker and wait for it, killing it if it outstays the timeout. */
export const runJob = (name: string, options: RunOptions): Promise<JobResult> => {
  const timeoutMs = options.timeoutMs ?? WORKER_TIMEOUT_MS;
  const started = Date.now();

  return new Promise<JobResult>((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first so the worker can record its own failure; SIGKILL if it ignores it.
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      resolve({
        name,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        summary: parseSummary(stdout),
        stderr: stderr.trim().slice(-4000),
        succeeded: !timedOut && exitCode === 0,
      });
    };

    child.on('error', (error) => {
      stderr += `\nfailed to spawn: ${error.message}`;
      finish(null, null);
    });
    child.on('close', finish);
  });
};
