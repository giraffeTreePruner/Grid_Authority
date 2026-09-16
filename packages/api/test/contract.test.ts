/**
 * Contract tests for the read-only API.
 *
 * Shape, status codes, caching headers and the meta envelope. These are what a client
 * is allowed to depend on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../src/app.js';
import { buildMeta, isoInstant, STALE_AFTER_HOURS } from '../src/lib/meta.js';
import type { Sql } from '../src/lib/db.js';
import { createHarness, databaseUrl, testEnv, type Harness } from './helpers.js';

const withDatabase = databaseUrl() === undefined ? describe.skip : describe;

describe('meta envelope', () => {
  it('marks data older than three hours as stale', () => {
    const now = new Date('2026-09-11T14:00:00Z');
    const fresh = new Date(now.getTime() - 1 * 3600 * 1000);
    const old = new Date(now.getTime() - (STALE_AFTER_HOURS + 1) * 3600 * 1000);

    expect(buildMeta(fresh, now).stale).toBe(false);
    expect(buildMeta(old, now).stale).toBe(true);
  });

  it('treats no data at all as stale', () => {
    const meta = buildMeta(null, new Date());
    expect(meta.stale).toBe(true);
    expect(meta.data_latest_period).toBeNull();
  });

  it('formats instants with a Z suffix and no sub-second noise', () => {
    expect(isoInstant(new Date('2026-09-11T14:30:05.123Z'))).toBe('2026-09-11T14:30:05Z');
    expect(isoInstant(null)).toBeNull();
  });

  it('always names its sources', () => {
    expect(buildMeta(new Date()).sources).toEqual(['eia']);
  });
});

withDatabase('endpoints', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  const get = (path: string) => harness.app.inject({ method: 'GET', url: `${API_PREFIX}${path}` });

  describe('GET /zones', () => {
    it('returns the registry with meta', async () => {
      const response = await get('/zones');
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(Array.isArray(body.zones)).toBe(true);
      expect(body.zones.length).toBeGreaterThan(0);
      expect(body.meta).toMatchObject({ sources: ['eia'] });
      expect(body.meta.generated_at).toMatch(/Z$/);
    });

    it('carries every documented field', async () => {
      const [zone] = (await get('/zones')).json().zones;
      expect(Object.keys(zone).sort()).toEqual(
        ['capabilities', 'in_map', 'interconnection', 'key', 'name', 'short_name', 'type'].sort(),
      );
      expect(Object.keys(zone.capabilities).sort()).toEqual(
        ['demand', 'demand_forecast', 'fuel_mix', 'interchange', 'net_generation'].sort(),
      );
    });

    it('includes aggregates, marked off the map', async () => {
      const { zones } = (await get('/zones')).json();
      const aggregates = zones.filter(
        (zone: { type: string }) => zone.type !== 'balancing_authority',
      );
      expect(aggregates.length).toBeGreaterThan(0);
      expect(aggregates.every((zone: { in_map: boolean }) => zone.in_map === false)).toBe(true);
    });

    it('is cacheable for an hour', async () => {
      expect((await get('/zones')).headers['cache-control']).toBe('public, max-age=3600');
    });
  });

  describe('GET /sources', () => {
    it('includes inactive entries', async () => {
      const { sources } = (await get('/sources')).json();
      const ids = sources.map((source: { id: string }) => source.id);
      expect(ids).toContain('eia');
      expect(ids).toContain('emaps_method');
    });

    it('carries the Electricity Maps label verbatim', async () => {
      const { sources } = (await get('/sources')).json();
      const emaps = sources.find((source: { id: string }) => source.id === 'emaps_method');
      expect(emaps.label).toBe('Electricity Maps methodology (our implementation)');
      expect(emaps.active).toBe(false);
      expect(emaps.attribution).toContain('electricitymaps-contrib');
    });

    it('reports observed latency, empty until the probe has run', async () => {
      const { sources } = (await get('/sources')).json();
      const eia = sources.find((source: { id: string }) => source.id === 'eia');
      expect(Array.isArray(eia.observed_latency)).toBe(true);
      expect(eia.observed_latency).toHaveLength(0);
    });

    it('reports measured lag once the probe has run', async () => {
      await harness.sql`
        INSERT INTO probe_log (dataset, checked_at, latest_period, lag_minutes)
        VALUES ('interchange-data', now(), '2026-09-10T07:00:00Z', 2520)
      `;
      const { sources } = (await get('/sources')).json();
      const eia = sources.find((source: { id: string }) => source.id === 'eia');
      expect(eia.observed_latency[0]).toMatchObject({
        dataset: 'interchange-data',
        lag_minutes: 2520,
      });
      await harness.sql`DELETE FROM probe_log`;
    });
  });

  describe('GET /health', () => {
    it('reports starting, not degraded, before the first ingest', async () => {
      const response = await get('/health');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'starting', db: 'up', sources: [] });
    });

    it('is 503 for a registered source that has never succeeded', async () => {
      await harness.sql`
        INSERT INTO source_status (source, job, last_run_at, last_failure_at, last_error)
        VALUES ('eia', 'poll', now(), now(), 'boom')
      `;
      const response = await get('/health');
      expect(response.statusCode).toBe(503);
      expect(response.json().status).toBe('degraded');
      expect(response.json().sources[0].minutes_stale).toBeNull();
      await harness.sql`DELETE FROM source_status`;
    });

    it('is 200 when every source is recent', async () => {
      await harness.sql`
        INSERT INTO source_status (source, job, last_run_at, last_success_at)
        VALUES ('eia', 'poll', now(), now())
      `;
      const response = await get('/health');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok', db: 'up' });
      expect(response.json().sources[0]).toMatchObject({ source: 'eia', job: 'poll' });
    });

    it('is 503 when a source has not succeeded in six hours', async () => {
      await harness.sql`
        UPDATE source_status SET last_success_at = now() - interval '7 hours'
      `;
      const response = await get('/health');
      expect(response.statusCode).toBe(503);
      expect(response.json().status).toBe('degraded');
      expect(response.json().sources[0].minutes_stale).toBeGreaterThan(360);
      await harness.sql`DELETE FROM source_status`;
    });
  });

  describe('errors', () => {
    it('uses one shape for an unknown route', async () => {
      const response = await get('/nope');
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: { code: 'not_found', message: expect.stringContaining('/nope') },
      });
    });
  });

  describe('headers', () => {
    it('asks robots not to index the API', async () => {
      expect((await get('/zones')).headers['x-robots-tag']).toBe('noindex');
    });
  });
});

describe('a statement timeout', () => {
  it('is reported as temporary, not as an unexplained failure', async () => {
    // Postgres cancels a statement past STATEMENT_TIMEOUT_MS and the driver raises
    // 57014. Left alone it becomes a bare 500, and the panel says "an unexpected error
    // occurred" -- which reads as "this site is broken" rather than "that range was too
    // much to ask for just now". The zone panel's `all` window is the closest of any
    // request to the ceiling, so it is the one that hits this under load.
    const cancelled = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    // The routes only await a tagged template, so one that throws is a faithful stand-in
    // for a query the database killed.
    const sql = (() => {
      throw cancelled;
    }) as unknown as Sql;

    const { app } = await buildApp({ env: testEnv(), sql });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: `${API_PREFIX}/zones` });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('timed_out');
    expect(response.json().error.message).toMatch(/shorter window/);
    await app.close();
  });
});
