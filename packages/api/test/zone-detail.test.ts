/**
 * GET /zones/:key
 *
 * The forecast selection rule is the part worth testing hardest: it must choose a
 * genuine day-ahead vintage, not the freshest revision published once the hour was
 * nearly over.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX } from '../src/app.js';
import { CACHE_MAX_AGE_HOURS, FORECAST_HORIZON_HOURS } from '../src/routes/zone-detail.js';
import { createHarness, databaseUrl, type Harness } from './helpers.js';

const withDatabase = databaseUrl() === undefined ? describe.skip : describe;

withDatabase('zone detail', () => {
  let harness: Harness;
  let zoneKey: string;

  const TARGET = '2026-09-11T12:00:00Z';

  beforeAll(async () => {
    harness = await createHarness();
    const [zone] = await harness.sql<{ key: string }[]>`
      SELECT key FROM zones WHERE in_map ORDER BY key LIMIT 1
    `;
    zoneKey = zone!.key;

    for (let hour = 0; hour < 6; hour += 1) {
      const period = new Date(Date.parse(TARGET) - (5 - hour) * 3600_000).toISOString();
      await harness.sql`
        INSERT INTO obs_region_hourly
          (zone_key, period_utc, source, demand_mw, net_generation_mw, total_interchange_mw)
        VALUES (${zoneKey}, ${period}, 'eia', ${1000 + hour}, ${900 + hour}, -50)
      `;
      await harness.sql`
        INSERT INTO obs_mix_hourly
          (zone_key, period_utc, source, wind_mw, gas_mw, total_generation_mw,
           renewable_share, low_carbon_share)
        VALUES (${zoneKey}, ${period}, 'eia', 400, 600, 1000, 0.4, 0.4)
      `;
    }

    // Three vintages for one target hour: two genuinely day-ahead, one published
    // barely before the hour began.
    const vintages: [string, number][] = [
      ['2026-09-09T12:00:00Z', 900], // 48h ahead
      ['2026-09-10T12:00:00Z', 950], // 24h ahead, the freshest that still qualifies
      ['2026-09-11T11:00:00Z', 999], // 1h ahead, a late revision that must not win
    ];
    for (const [issued, value] of vintages) {
      await harness.sql`
        INSERT INTO forecast_issues
          (source, model, zone_key, issue_time_utc, target_time_utc, metric, value)
        VALUES ('eia', 'eia_df', ${zoneKey}, ${issued}, ${TARGET}, 'demand', ${value})
      `;
    }
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  const get = (path: string) => harness.app.inject({ method: 'GET', url: `${API_PREFIX}${path}` });

  it('returns the zone and every documented series', async () => {
    const response = await get(`/zones/${zoneKey}`);
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.zone.key).toBe(zoneKey);
    expect(body.sources).toEqual(['eia']);
    expect(Object.keys(body.series).sort()).toEqual(
      [
        'demand_forecast_horizon_h',
        'demand_forecast_mw',
        'demand_mw',
        'low_carbon_share',
        'mix',
        'net_generation_mw',
        'net_interchange_mw',
        'period',
        'renewable_share',
      ].sort(),
    );
    expect(Object.keys(body.series.mix)).toHaveLength(14);
  });

  it('gives every series the same length as the period axis', async () => {
    const { series } = (await get(`/zones/${zoneKey}?window=24h`)).json();
    const length = series.period.length;
    expect(length).toBe(24);
    for (const key of ['demand_mw', 'net_generation_mw', 'renewable_share']) {
      expect(series[key]).toHaveLength(length);
    }
    for (const values of Object.values(series.mix)) {
      expect(values).toHaveLength(length);
    }
  });

  it('picks the freshest vintage that is still a day ahead', async () => {
    const { series } = (await get(`/zones/${zoneKey}?window=24h`)).json();
    const index = series.period.indexOf(TARGET);
    expect(index).toBeGreaterThanOrEqual(0);

    // 950 was issued exactly 24h ahead; 999 an hour before the target must not win.
    expect(series.demand_forecast_mw[index]).toBe(950);
    expect(series.demand_forecast_horizon_h[index]).toBe(24);
  });

  it('reports the horizon it used, so a short one is visible', async () => {
    const body = (await get(`/zones/${zoneKey}`)).json();
    expect(body.forecast_horizon_h).toBe(FORECAST_HORIZON_HOURS);
  });

  it('leaves the forecast null where no vintage is old enough', async () => {
    const { series } = (await get(`/zones/${zoneKey}?window=24h`)).json();
    const withForecast = series.demand_forecast_mw.filter((v: number | null) => v !== null);
    expect(withForecast).toHaveLength(1);
    expect(series.demand_forecast_mw.filter((v: number | null) => v === 0)).toHaveLength(0);
  });

  it('honours each window length', async () => {
    for (const [window, hours] of [
      ['24h', 24],
      ['72h', 72],
      ['168h', 168],
    ] as const) {
      const { series } = (await get(`/zones/${zoneKey}?window=${window}`)).json();
      expect(series.period).toHaveLength(hours);
    }
  });

  it('defaults to a week', async () => {
    expect((await get(`/zones/${zoneKey}`)).json().series.period).toHaveLength(168);
  });

  it('rejects an unknown window', async () => {
    const response = await get(`/zones/${zoneKey}?window=fortnight`);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/window must be one of/);
  });

  it('offers the long windows the map can reach', async () => {
    // The map spans 2019 to now. A panel capped at a week makes the two halves of the
    // same page disagree about what the reader is looking at.
    for (const window of ['30d', '90d', '1y', 'all']) {
      const response = await get(`/zones/${zoneKey}?window=${window}`);
      expect(response.statusCode, window).toBe(200);
    }
  });

  it('buckets a long window by day, not by hour', async () => {
    const body = (await get(`/zones/${zoneKey}?window=1y`)).json();
    const periods: string[] = body.series.period;

    expect(periods.length).toBeGreaterThan(300);
    expect(periods.length).toBeLessThanOrEqual(367);
    // Every step is a midnight, and consecutive steps are a day apart.
    expect(periods.every((period) => period.endsWith('T00:00:00Z'))).toBe(true);
    const first = new Date(periods[0]!).getTime();
    const second = new Date(periods[1]!).getTime();
    expect(second - first).toBe(86_400_000);
  });

  it('steps a month window by the calendar, not by thirty days', async () => {
    // Months differ in length; stepping by a fixed interval drifts off the 1st.
    const periods: string[] = (await get(`/zones/${zoneKey}?window=all`)).json().series.period;
    expect(periods.every((period) => period.slice(8) === '01T00:00:00Z')).toBe(true);
  });

  it('keeps every series the same length as the axis at every window', async () => {
    for (const window of ['24h', '30d', 'all']) {
      const body = (await get(`/zones/${zoneKey}?window=${window}`)).json();
      const length = body.series.period.length;
      expect(body.series.demand_mw, window).toHaveLength(length);
      expect(body.series.demand_forecast_mw, window).toHaveLength(length);
      expect(body.series.mix.wind, window).toHaveLength(length);
    }
  });

  it('leaves an unreported period as a gap rather than closing it up', async () => {
    // Generated from the calendar, not from the rows that happen to exist: a day
    // nobody reported has to stay visible as a day nobody reported.
    const body = (await get(`/zones/${zoneKey}?window=1y`)).json();
    expect(body.series.demand_mw.some((value: number | null) => value === null)).toBe(true);
  });

  it('is 404 for an unknown zone', async () => {
    const response = await get('/zones/US-NOWHERE');
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('not_found');
  });

  it('returns empty series for a zone that has never reported', async () => {
    const [quiet] = await harness.sql<{ key: string }[]>`
      SELECT key FROM zones WHERE key <> ${zoneKey} ORDER BY key LIMIT 1
    `;
    const body = (await get(`/zones/${quiet!.key}`)).json();
    expect(body.latest_period).toBeNull();
    expect(body.series.period).toHaveLength(0);
  });

  it('carries the mix values that were stored', async () => {
    const { series } = (await get(`/zones/${zoneKey}?window=24h`)).json();
    const index = series.period.indexOf(TARGET);
    expect(series.mix.wind[index]).toBe(400);
    expect(series.mix.gas[index]).toBe(600);
    expect(series.mix.coal[index]).toBeNull();
  });

  it('revalidates with an ETag', async () => {
    const first = await get(`/zones/${zoneKey}`);
    const tag = first.headers.etag as string;
    const second = await harness.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/zones/${zoneKey}`,
      headers: { 'if-none-match': tag },
    });
    expect(second.statusCode).toBe(304);
  });

  describe('the cache behind the bucketed windows', () => {
    it('stores what it computed, and serves the same thing back', async () => {
      // A cache that answers differently from a computation is worse than no cache:
      // the bug only appears for readers whose request happened to miss.
      await harness.sql`DELETE FROM zone_detail_cache WHERE zone_key = ${zoneKey}`;

      const miss = await get(`/zones/${zoneKey}?window=1y`);
      expect(miss.headers['x-cache']).toBe('computed');

      const hit = await get(`/zones/${zoneKey}?window=1y`);
      expect(hit.headers['x-cache']).toBe('stored');
      expect(hit.json()).toEqual(miss.json());
    });

    it('does not cache the hourly windows', async () => {
      // They are cheap, and they change on every poll. Caching them would trade a
      // performance problem nobody has for a staleness one everybody would.
      await get(`/zones/${zoneKey}?window=24h`);
      const [row] = await harness.sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM zone_detail_cache
         WHERE zone_key = ${zoneKey} AND window_key = '24h'
      `;
      expect(row?.n).toBe('0');
    });

    it('recomputes rather than serving a document older than the limit', async () => {
      // If warming stops, a reader waits once. They do not silently read last week.
      await get(`/zones/${zoneKey}?window=90d`);
      await harness.sql`
        UPDATE zone_detail_cache
           SET built_at = now() - make_interval(hours => ${CACHE_MAX_AGE_HOURS + 1})
         WHERE zone_key = ${zoneKey} AND window_key = '90d'
      `;

      const response = await get(`/zones/${zoneKey}?window=90d`);
      expect(response.headers['x-cache']).toBe('computed');
    });

    it('still answers when the cache cannot be written', async () => {
      // A cache that cannot be written is a slow site, not a broken one.
      await harness.sql`DROP TABLE IF EXISTS zone_detail_cache_backup`;
      await harness.sql`ALTER TABLE zone_detail_cache RENAME TO zone_detail_cache_backup`;
      try {
        const response = await get(`/zones/${zoneKey}?window=30d`);
        expect(response.statusCode).toBe(200);
        expect(response.json().series.period.length).toBeGreaterThan(0);
      } finally {
        await harness.sql`ALTER TABLE zone_detail_cache_backup RENAME TO zone_detail_cache`;
      }
    });
  });

  describe('the shares it re-derives', () => {
    // The panel re-derives its shares from summed generation rather than averaging the
    // stored percentages, so it needs the same clamp the write path applies. It did not
    // have it: a negative value shrank the denominator and inflated the result, exactly
    // the defect corrected in the stored column in September. EIA files some operators'
    // storage as OTH/UNK, which reach `unknown`, so charging load landed in a counted
    // mode and the map and the panel disagreed.
    // Two shapes of the same fault, because they fail differently. Charging equal to
    // generation zeroes the denominator and the share comes back null; charging at half
    // of it leaves the denominator positive but too small, and the share comes back
    // above 1 — which is the one a reader would actually have seen, since it stays
    // plausible while being wrong.
    const ZEROED_HOUR = '2026-08-01T00:00:00Z';
    const INFLATED_HOUR = '2026-08-02T00:00:00Z';

    beforeAll(async () => {
      for (const [period, unknown] of [
        [ZEROED_HOUR, -100],
        [INFLATED_HOUR, -50],
      ] as const) {
        await harness.sql`
          INSERT INTO obs_mix_hourly
            (zone_key, period_utc, source, wind_mw, unknown_mw, total_generation_mw)
          VALUES (${zoneKey}, ${period}, 'eia', 100, ${unknown}, 0)
        `;
        await harness.sql`
          INSERT INTO obs_region_hourly (zone_key, period_utc, source, demand_mw)
          VALUES (${zoneKey}, ${period}, 'eia', 500)
        `;
      }
      await harness.sql`DELETE FROM zone_detail_cache WHERE zone_key = ${zoneKey}`;
    });

    it('clamps a negative mode out of the denominator', async () => {
      // 100 wind against 100 wind + (-100) unknown. Unclamped the denominator is zero
      // and the share is undefined or absurd; clamped it is 100 / 100 = 1.
      const response = await get(`/zones/${zoneKey}?window=90d`);
      expect(response.statusCode).toBe(200);

      const body = response.json();
      const index = body.series.period.findIndex((period: string) =>
        period.startsWith('2026-08-01'),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      expect(body.series.renewable_share[index]).toBe(1);
    });

    it('never reports a share above one', async () => {
      // Unclamped this hour reads 100 / (100 - 50) = 2.0. A share over 1 is the symptom
      // a reader would have met, and the one worth asserting on directly.
      const response = await get(`/zones/${zoneKey}?window=90d`);
      const body = response.json();
      const index = body.series.period.findIndex((period: string) =>
        period.startsWith('2026-08-02'),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      expect(body.series.renewable_share[index]).toBe(1);

      for (const share of body.series.renewable_share as (number | null)[]) {
        if (share !== null) expect(share).toBeLessThanOrEqual(1);
      }
    });
  });
});
