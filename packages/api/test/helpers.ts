/**
 * Test harness for the API.
 *
 * Each suite runs against its own schema inside the development database, so a test
 * never touches real observations and two runs cannot collide.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { buildApp } from '../src/app.js';
import { connect, type Sql } from '../src/lib/db.js';
import type { Env } from '../src/env.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

export const databaseUrl = (): string | undefined => {
  const url = process.env.DATABASE_URL?.trim();
  return url === '' ? undefined : url;
};

export const testEnv = (overrides: Partial<Env> = {}): Env => ({
  DATABASE_URL: databaseUrl() ?? 'postgres://unused',
  PORT: 0,
  HOST: '127.0.0.1',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  PUBLIC_BASE_URL: 'http://localhost:5173',
  GEOMETRY_VERSION: '1',
  ...overrides,
});

/** Every `.up.sql` migration, in version order. */
const migrations = (): string[] => {
  const dir = join(repoRoot, 'db', 'migrations');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.up.sql'))
    .sort()
    .map((name) => readFileSync(join(dir, name), 'utf8'));
};

export interface Harness {
  app: FastifyInstance;
  sql: Sql;
  schema: string;
  close: () => Promise<void>;
}

/** A migrated schema with the zone registry synced, and an app bound to it. */
export const createHarness = async (): Promise<Harness> => {
  const url = databaseUrl();
  if (url === undefined) throw new Error('DATABASE_URL is not set');

  const schema = `apitest_${randomBytes(6).toString('hex')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  await admin.unsafe(`SET search_path TO "${schema}"`);
  for (const statement of migrations()) {
    await admin.unsafe(`SET search_path TO "${schema}"; ${statement}`);
  }
  await admin.end();

  // sync-zones is the worker's job; calling it keeps one definition of the registry.
  execFileSync('uv', ['run', 'eia', 'sync-zones'], {
    cwd: repoRoot,
    env: { ...process.env, PGOPTIONS: `-c search_path=${schema}` },
    stdio: 'pipe',
  });

  const sql = postgres(url, {
    max: 5,
    connection: { timezone: 'UTC', search_path: schema },
    transform: { undefined: null },
    onnotice: () => {},
  });

  const { app } = await buildApp({ env: testEnv(), sql });
  await app.ready();

  return {
    app,
    sql,
    schema,
    close: async () => {
      await app.close();
      await sql.end();
      const cleanup = postgres(url, { max: 1, onnotice: () => {} });
      await cleanup.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await cleanup.end();
    },
  };
};

export { connect };
