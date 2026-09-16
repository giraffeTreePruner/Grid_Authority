/**
 * The map endpoints: shape, the seven-day cap, and ETag revalidation.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { API_PREFIX } from '../src/app.js';
import {
  hoursBetween,
  MAX_WINDOW_HOURS,
  parseHour,
  parseResolution,
  parseStatistic,
  parseWindow,
} from '../src/lib/period.js';
import { createHarness, databaseUrl, type Harness } from './helpers.js';

const withDatabase = databaseUrl() === undefined ? describe.skip : describe;

describe('period parsing', () => {
  it('accepts an ISO hour', () => {
    expect(parseHour('2026-09-11T14:00:00Z', 'at').toISOString()).toBe('2026-09-11T14:00:00.000Z');
    expect(parseHour('2026-09-11T14', 'at').toISOString()).toBe('2026-09-11T14:00:00.000Z');
  });

  it('lets a coarser resolution cover a longer range', () => {
    // The same range that is refused by the hour is two months by the day, which is
    // the point of having resolutions at all.
    const range = ['2026-07-01T00:00:00Z', '2026-09-08T00:00:00Z'] as const;
    expect(() => parseWindow(...range)).toThrow(/at most 168 periods/);
    expect(() => parseWindow(...range, 'day')).not.toThrow();
  });

  it('caps each resolution at its own count, and says what to do instead', () => {
    expect(() => parseWindow('2019-01-01T00:00:00Z', '2026-09-08T00:00:00Z', 'day')).toThrow(
      /coarser resolution/,
    );
    // Ten years of months outlives the dataset, so nothing real is refused there.
    expect(() =>
      parseWindow('2019-01-01T00:00:00Z', '2026-09-08T00:00:00Z', 'month'),
    ).not.toThrow();
  });

  it('names the resolutions it accepts rather than only refusing', () => {
    expect(() => parseResolution('fortnight')).toThrow(/hour, day, week, month/);
    expect(parseResolution(undefined)).toBe('hour');
    expect(parseResolution('month')).toBe('month');
  });

  it('refuses a statistic on hourly data, which has no summary', () => {
    expect(() => parseStatistic('peak', 'hour')).toThrow(/applies only to day, week/);
    expect(parseStatistic('peak', 'month')).toBe('peak');
    expect(parseStatistic(undefined, 'month')).toBe('mean');
  });

  it('rejects anything not exactly on the hour', () => {
    expect(() => parseHour('2026-09-11T14:30:00Z', 'at')).toThrow(/exactly on the hour/);
  });

  it('rejects a value that is not a date at all', () => {
    expect(() => parseHour('yesterday', 'at')).toThrow(/ISO-8601/);
  });

  it('caps an hourly window at seven days', () => {
    expect(() => parseWindow('2026-09-01T00:00:00Z', '2026-09-08T01:00:00Z')).toThrow(
      /at most 168 periods/,
    );
    expect(parseWindow('2026-09-01T00:00:00Z', '2026-09-07T23:00:00Z')).toBeTruthy();
  });

  it('rejects a reversed range', () => {
    expect(() => parseWindow('2026-09-08T00:00:00Z', '2026-09-01T00:00:00Z')).toThrow(
      /must not be later/,
    );
  });

  it('enumerates every hour inclusively', () => {
    const hours = hoursBetween(new Date('2026-09-11T10:00:00Z'), new Date('2026-09-11T13:00:00Z'));
    expect(hours).toHaveLength(4);
    expect(MAX_WINDOW_HOURS).toBe(168);
  });
});

withDatabase('map endpoints', () => {
  let harness: Harness;
  const hours = ['2026-09-11T10', '2026-09-11T11', '2026-09-11T12'];

  beforeAll(async () => {
    harness = await createHarness();
    const [zone] = await harness.sql<{ key: string }[]>`
      SELECT key FROM zones WHERE in_map ORDER BY key LIMIT 1
    `;
    for (const [index, hour] of hours.entries()) {
      await harness.sql`
        INSERT INTO map_snapshot (period_utc, payload)
        VALUES (
          ${`${hour}:00:00Z`},
          ${harness.sql.json({
            period: `${hour}:00:00Z`,
            metrics: [
              'demand_mw',
              'net_generation_mw',
              'net_interchange_mw',
              'renewable_share',
              'low_carbon_share',
            ],
            zones: { [zone!.key]: [1000 + index, 900 + index, -100, 0.41, 0.52] },
            built_at: '2026-09-11T13:00:00Z',
          })}
        )
      `;
    }

    for (const [index, day] of ['2026-09-10', '2026-09-11'].entries()) {
      await harness.sql`
        INSERT INTO map_snapshot_agg (resolution, period_utc, payload)
        VALUES (
          'day',
          ${`${day}T00:00:00Z`},
          ${harness.sql.json({
            period: `${day}T00:00:00Z`,
            resolution: 'day',
            metrics: [
              'demand_mw',
              'net_generation_mw',
              'net_interchange_mw',
              'renewable_share',
              'low_carbon_share',
            ],
            statistics: ['mean', 'peak'],
            zones: {
              [zone!.key]: {
                mean: [2000 + index, 1900 + index, -100, 0.41, 0.52],
                peak: [5000 + index, 4900 + index, -900, 0.77, 0.88],
              },
            },
            hours: 24,
            built_at: '2026-09-12T00:00:00Z',
          })}
        )
      `;
    }
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    harness.app.inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers });

  describe('GET /map/snapshot', () => {
    it('serves the stored document with meta attached', async () => {
      const response = await get('/map/snapshot?at=2026-09-11T11:00:00Z');
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.period).toBe('2026-09-11T11:00:00Z');
      expect(body.metrics).toHaveLength(5);
      expect(body.meta.sources).toEqual(['eia']);
      expect(Object.values(body.zones)[0]).toHaveLength(5);
    });

    it('defaults to the latest hour', async () => {
      expect((await get('/map/snapshot')).json().period).toBe('2026-09-11T12:00:00Z');
    });

    it('is 404 for an hour with no snapshot', async () => {
      const response = await get('/map/snapshot?at=2020-01-01T00:00:00Z');
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('not_found');
    });

    it('is cacheable at the edge for five minutes', async () => {
      expect((await get('/map/snapshot')).headers['cache-control']).toBe(
        'public, max-age=60, s-maxage=300',
      );
    });

    it('revalidates with a strong ETag', async () => {
      const first = await get('/map/snapshot?at=2026-09-11T11:00:00Z');
      const tag = first.headers.etag as string;
      expect(tag).toBeDefined();
      expect(tag.startsWith('W/')).toBe(false);

      const second = await get('/map/snapshot?at=2026-09-11T11:00:00Z', { 'if-none-match': tag });
      expect(second.statusCode).toBe(304);
      expect(second.body).toBe('');
    });
  });

  describe('GET /map/window', () => {
    it('returns one row per hour per zone', async () => {
      const response = await get('/map/window?from=2026-09-11T10:00:00Z&to=2026-09-11T12:00:00Z');
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.periods).toEqual([
        '2026-09-11T10:00:00Z',
        '2026-09-11T11:00:00Z',
        '2026-09-11T12:00:00Z',
      ]);

      const series = Object.values(body.zones)[0] as (number | null)[][];
      expect(series).toHaveLength(3);
      expect(series.map((values) => values[0])).toEqual([1000, 1001, 1002]);
    });

    it('pads hours with no snapshot with nulls, never zeros', async () => {
      const body = (
        await get('/map/window?from=2026-09-11T08:00:00Z&to=2026-09-11T12:00:00Z')
      ).json();
      const series = Object.values(body.zones)[0] as (number | null)[][];
      expect(series).toHaveLength(5);
      expect(series[0]).toEqual([null, null, null, null, null]);
      expect(series[2]![0]).toBe(1000);
    });

    it('serves day summaries at day resolution', async () => {
      const body = (
        await get('/map/window?from=2026-09-10T00:00:00Z&to=2026-09-11T23:00:00Z&resolution=day')
      ).json();

      expect(body.resolution).toBe('day');
      expect(body.statistic).toBe('mean');
      expect(body.periods).toEqual(['2026-09-10T00:00:00Z', '2026-09-11T00:00:00Z']);

      const series = Object.values(body.zones)[0] as (number | null)[][];
      expect(series[0]![0]).toBe(2000);
      expect(series[1]![0]).toBe(2001);
    });

    it('serves the peak when asked for it, in the same shape', async () => {
      const body = (
        await get(
          '/map/window?from=2026-09-10T00:00:00Z&to=2026-09-11T23:00:00Z' +
            '&resolution=day&statistic=peak',
        )
      ).json();

      expect(body.statistic).toBe('peak');
      const series = Object.values(body.zones)[0] as (number | null)[][];
      // The same position in the same array: a client switches statistic without
      // switching code path.
      expect(series[0]![0]).toBe(5000);
      expect(series[0]![2]).toBe(-900);
    });

    it('includes a day that starts before the requested hour', async () => {
      // Asking from midday on the 10th still means the 10th: a day is the unit.
      const body = (
        await get('/map/window?from=2026-09-10T12:00:00Z&to=2026-09-11T23:00:00Z&resolution=day')
      ).json();
      expect(body.periods[0]).toBe('2026-09-10T00:00:00Z');
    });

    it('is 400 for an unknown resolution, naming the ones that work', async () => {
      const response = await get(
        '/map/window?from=2026-09-10T00:00:00Z&to=2026-09-11T00:00:00Z&resolution=fortnight',
      );
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toMatch(/hour, day, week, month/);
    });

    it('is 400 for a statistic on hourly data', async () => {
      const response = await get(
        '/map/window?from=2026-09-11T10:00:00Z&to=2026-09-11T12:00:00Z&statistic=peak',
      );
      expect(response.statusCode).toBe(400);
    });

    it('reports no statistic for an hourly window', async () => {
      const body = (
        await get('/map/window?from=2026-09-11T10:00:00Z&to=2026-09-11T12:00:00Z')
      ).json();
      expect(body.resolution).toBe('hour');
      expect(body.statistic).toBeNull();
    });

    it('is 400 on a range longer than seven days', async () => {
      const response = await get('/map/window?from=2026-09-01T00:00:00Z&to=2026-09-08T01:00:00Z');
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({ code: 'bad_request' });
      expect(response.json().error.message).toMatch(/at most 168 periods/);
    });

    it('accepts exactly seven days', async () => {
      const response = await get('/map/window?from=2026-09-01T00:00:00Z&to=2026-09-07T23:00:00Z');
      expect(response.statusCode).toBe(200);
      expect(response.json().periods).toHaveLength(168);
    });

    it('requires both bounds', async () => {
      const response = await get('/map/window?from=2026-09-11T10:00:00Z');
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toMatch(/both from and to/);
    });

    it('revalidates with an ETag', async () => {
      // The clock is frozen for the pair, because `meta.generated_at` is in the body at
      // second precision: two requests either side of a tick are genuinely different
      // representations, so the ETag correctly differs and no 304 is possible. Left to
      // the real clock this test passes on most runs and fails on the unlucky ones.
      //
      // Only Date is faked. Faking every timer stalls anything waiting on a real one,
      // which is how the playback test deadlocked.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-09-11T12:30:00Z'));
        const path = '/map/window?from=2026-09-11T10:00:00Z&to=2026-09-11T12:00:00Z';
        const tag = (await get(path)).headers.etag as string;
        expect((await get(path, { 'if-none-match': tag })).statusCode).toBe(304);
      } finally {
        vi.useRealTimers();
      }
    });

    it('carries one week of hours in a payload the slider can hold', async () => {
      const response = await get('/map/window?from=2026-09-01T00:00:00Z&to=2026-09-07T23:00:00Z');
      const bytes = Buffer.byteLength(response.body, 'utf8');
      expect(bytes).toBeLessThan(2 * 1024 * 1024);
    });
  });
});
