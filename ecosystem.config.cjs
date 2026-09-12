/**
 * PM2 process definitions.
 *
 * Two long-running processes: the API, and the scheduler that spawns the Python
 * workers. The workers themselves are not PM2 apps — they are short-lived jobs, and
 * supervising them as services would make a job that exits normally look like a crash.
 *
 * Both run with TZ=UTC. The database, the container and these processes must agree, or
 * an interval-start hour stops meaning what it says.
 *
 * Memory ceilings are sized for a 2 GB host. Rough budget at rest: Postgres 300-400 MB,
 * the OS around 250 MB, nginx 30 MB. That leaves about 1.3 GB, and these ceilings claim
 * 750 MB of it. The Python workers the scheduler spawns are separate processes and are
 * NOT covered by the scheduler's ceiling; a poll cycle wants another 150-250 MB on top.
 * The swapfile in the runbook is what absorbs the overlap.
 */
module.exports = {
  apps: [
    {
      name: 'api',
      cwd: '/srv/grid-authority',
      script: 'packages/api/dist/index.js',
      // Node 22 reads the env file itself, so no secret is written into this committed
      // file. The API gets .env.api, which holds the read-only database role: a bug in
      // the API then cannot write, whatever it intends.
      node_args: ['--env-file=/srv/grid-authority/.env.api'],
      exec_mode: 'cluster',
      // Two workers on 2 vCPU: enough to survive one being busy, few enough to leave
      // room for the scheduler's Python jobs.
      instances: 2,
      // Serving precomputed JSON does not need much. This is a ceiling that trips a
      // restart before the kernel's OOM killer starts choosing a victim itself, and
      // the victim it chooses is often Postgres.
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        TZ: 'UTC',
      },
      // Read-only and stateless, so a restart costs nothing.
      autorestart: true,
      // A process that keeps dying should stop and be noticed rather than loop.
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 2000,
      kill_timeout: 10000,
      merge_logs: true,
      time: true,
    },
    {
      name: 'scheduler',
      cwd: '/srv/grid-authority',
      script: 'packages/scheduler/dist/index.js',
      // The scheduler gets .env, holding the owner role and the EIA key. The Python
      // workers it spawns inherit that environment, so they need no env file of their own.
      node_args: ['--env-file=/srv/grid-authority/.env'],
      exec_mode: 'fork',
      // Exactly one. A second would double every request to EIA.
      instances: 1,
      max_memory_restart: '150M',
      env: {
        NODE_ENV: 'production',
        TZ: 'UTC',
        GRID_ROOT: '/srv/grid-authority',
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '60s',
      restart_delay: 5000,
      // Give a running worker time to finish and record its own failure.
      kill_timeout: 15000,
      merge_logs: true,
      time: true,
    },
  ],
};
