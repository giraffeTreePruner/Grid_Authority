/**
 * What runs when.
 *
 * Every expression is UTC, which is also what the process runs in. The schedules come
 * from §12: poll twice an hour, probe hourly, revise once a day.
 */
export interface ScheduledJob {
  name: string;
  /** Cron expression, evaluated in UTC. */
  cron: string;
  /** Arguments passed to the worker CLI. */
  args: string[];
  why: string;
}

export const JOBS: ScheduledJob[] = [
  {
    name: 'poll',
    cron: '10,40 * * * *',
    args: ['poll'],
    why: 'Twice an hour, offset from the hour so EIA has published before we ask.',
  },
  {
    name: 'probe',
    cron: '50 * * * *',
    args: ['probe'],
    why: 'Hourly. Measures publication lag so /sources reports observed latency.',
  },
  {
    name: 'revise',
    cron: '15 4 * * *',
    args: ['revise'],
    why: 'Daily. Re-fetches the trailing week to date what EIA changed after publishing.',
  },
];
