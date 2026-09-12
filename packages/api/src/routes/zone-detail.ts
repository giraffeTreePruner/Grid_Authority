/**
 * GET /zones/:key — everything the detail panel plots for one zone.
 *
 * The forecast series is the interesting part. For each target hour it takes the most
 * recent vintage issued at or before `target - FORECAST_HORIZON_HOURS`, so the chart
 * compares actual demand against a genuine day-ahead prediction rather than against a
 * revision published once the hour was nearly over.
 *
 * Each point carries the horizon of the vintage actually chosen. EIA's published
 * horizon has been observed as short as six hours, which would leave this series empty;
 * reporting the horizon makes that visible instead of looking like missing data.
 */
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../lib/db.js';
import { ApiError } from '../lib/errors.js';
import { buildMeta, isoInstant, latestDataPeriod } from '../lib/meta.js';

export const FORECAST_HORIZON_HOURS = 24;

const WINDOWS = { '24h': 24, '72h': 72, '168h': 168 } as const;
type WindowKey = keyof typeof WINDOWS;

const MODES = [
  'coal',
  'gas',
  'oil',
  'nuclear',
  'hydro',
  'pumped_storage',
  'wind',
  'solar',
  'geothermal',
  'biomass',
  'battery_storage',
  'other_storage',
  'imports',
  'unknown',
] as const;

interface ZoneRow {
  key: string;
  name: string;
  short_name: string;
  interconnection: string | null;
  timezone: string;
  type: string;
  in_map: boolean;
  capabilities: Record<string, boolean>;
}

interface RegionRow {
  period_utc: Date;
  demand_mw: string | null;
  net_generation_mw: string | null;
  total_interchange_mw: string | null;
}

interface MixRow extends Record<string, unknown> {
  period_utc: Date;
  renewable_share: string | null;
  low_carbon_share: string | null;
}

interface ForecastRow {
  target_time_utc: Date;
  value: string | null;
  horizon_h: number | null;
}

const toNumber = (value: string | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

export const zoneDetailRoutes = (app: FastifyInstance, sql: Sql): void => {
  app.get<{ Params: { key: string }; Querystring: { window?: string } }>(
    '/zones/:key',
    async (request, reply) => {
      const requested = request.query.window ?? '168h';
      if (!(requested in WINDOWS)) {
        throw ApiError.badRequest(
          `window must be one of ${Object.keys(WINDOWS).join(', ')}, got "${requested}"`,
        );
      }
      const hours = WINDOWS[requested as WindowKey];

      const zones = await sql<ZoneRow[]>`
        SELECT key, name, short_name, interconnection, timezone, type, in_map, capabilities
          FROM zones WHERE key = ${request.params.key}
      `;
      const zone = zones[0];
      if (zone === undefined) {
        throw ApiError.notFound(`No zone with key "${request.params.key}"`);
      }

      const [bounds] = await sql<{ latest: Date | null }[]>`
        SELECT max(period_utc) AS latest FROM obs_region_hourly WHERE zone_key = ${zone.key}
      `;
      const latestPeriod = bounds?.latest ?? null;

      if (latestPeriod === null) {
        const latest = await latestDataPeriod(sql);
        reply.header('Cache-Control', 'public, max-age=60, s-maxage=300');
        return reply.send({
          zone,
          series: emptySeries(),
          sources: ['eia'],
          latest_period: null,
          forecast_horizon_h: FORECAST_HORIZON_HOURS,
          meta: buildMeta(latest),
        });
      }

      const from = new Date(latestPeriod.getTime() - (hours - 1) * 3600_000);

      const [regionRows, mixRows, forecastRows, latest] = await Promise.all([
        sql<RegionRow[]>`
          SELECT period_utc, demand_mw, net_generation_mw, total_interchange_mw
            FROM obs_region_hourly
           WHERE zone_key = ${zone.key} AND period_utc BETWEEN ${from} AND ${latestPeriod}
           ORDER BY period_utc
        `,
        sql<MixRow[]>`
          SELECT period_utc, renewable_share, low_carbon_share,
                 coal_mw, gas_mw, oil_mw, nuclear_mw, hydro_mw, pumped_storage_mw,
                 wind_mw, solar_mw, geothermal_mw, biomass_mw, battery_storage_mw,
                 other_storage_mw, imports_mw, unknown_mw
            FROM obs_mix_hourly
           WHERE zone_key = ${zone.key} AND period_utc BETWEEN ${from} AND ${latestPeriod}
           ORDER BY period_utc
        `,
        // One vintage per target: the freshest issued early enough to count as
        // day-ahead. DISTINCT ON picks it in a single pass.
        sql<ForecastRow[]>`
          SELECT DISTINCT ON (target_time_utc)
                 target_time_utc, value, horizon_h
            FROM forecast_issues
           WHERE zone_key = ${zone.key}
             AND metric = 'demand'
             AND target_time_utc BETWEEN ${from} AND ${latestPeriod}
             AND issue_time_utc <= target_time_utc
                 - make_interval(hours => ${FORECAST_HORIZON_HOURS})
           ORDER BY target_time_utc, issue_time_utc DESC
        `,
        latestDataPeriod(sql),
      ]);

      const periods: Date[] = [];
      for (let t = from.getTime(); t <= latestPeriod.getTime(); t += 3600_000) {
        periods.push(new Date(t));
      }

      const region = new Map(regionRows.map((row) => [row.period_utc.getTime(), row]));
      const mix = new Map(mixRows.map((row) => [row.period_utc.getTime(), row]));
      const forecast = new Map(forecastRows.map((row) => [row.target_time_utc.getTime(), row]));

      const series = emptySeries();
      series.period = periods.map((period) => isoInstant(period) as string);
      for (const period of periods) {
        const key = period.getTime();
        const r = region.get(key);
        const m = mix.get(key);
        const f = forecast.get(key);

        series.demand_mw.push(toNumber(r?.demand_mw));
        series.net_generation_mw.push(toNumber(r?.net_generation_mw));
        series.net_interchange_mw.push(toNumber(r?.total_interchange_mw));
        series.demand_forecast_mw.push(toNumber(f?.value));
        series.demand_forecast_horizon_h.push(f?.horizon_h ?? null);
        series.renewable_share.push(toNumber(m?.renewable_share));
        series.low_carbon_share.push(toNumber(m?.low_carbon_share));
        for (const mode of MODES) {
          series.mix[mode].push(toNumber(m?.[`${mode}_mw`] as string | null | undefined));
        }
      }

      reply.header('Cache-Control', 'public, max-age=60, s-maxage=300');
      return reply.send({
        zone,
        series,
        sources: ['eia'],
        latest_period: isoInstant(latestPeriod),
        forecast_horizon_h: FORECAST_HORIZON_HOURS,
        meta: buildMeta(latest),
      });
    },
  );
};

interface Series {
  period: string[];
  demand_mw: (number | null)[];
  demand_forecast_mw: (number | null)[];
  demand_forecast_horizon_h: (number | null)[];
  net_generation_mw: (number | null)[];
  net_interchange_mw: (number | null)[];
  mix: Record<(typeof MODES)[number], (number | null)[]>;
  renewable_share: (number | null)[];
  low_carbon_share: (number | null)[];
}

const emptySeries = (): Series => ({
  period: [],
  demand_mw: [],
  demand_forecast_mw: [],
  demand_forecast_horizon_h: [],
  net_generation_mw: [],
  net_interchange_mw: [],
  mix: MODES.reduce<Series['mix']>(
    (accumulator, mode) => {
      accumulator[mode] = [];
      return accumulator;
    },
    {} as Series['mix'],
  ),
  renewable_share: [],
  low_carbon_share: [],
});
