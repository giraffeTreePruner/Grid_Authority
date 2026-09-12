/**
 * GET /zones/:key
 *
 * The forecast selection rule is the part worth testing hardest: it must choose a
 * genuine day-ahead vintage, not the freshest revision published once the hour was
 * nearly over.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX } from '../src/app.js';
import { FORECAST_HORIZON_HOURS } from '../src/routes/zone-detail.js';
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
    const response = await get(`/zones/${zoneKey}?window=30d`);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/window must be one of/);
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
});
