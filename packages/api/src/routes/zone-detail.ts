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
import { loadModes } from '../config/index.js';

export const FORECAST_HORIZON_HOURS = 24;

/**
 * The ranges the panel can plot, and the period each one buckets into.
 *
 * Short windows are served hour by hour, as measured. Long ones are aggregated on the
 * way out — a year of hourly points is 8,760 of them, which is neither readable as a
 * chart nor honest as a comparison against a day-ahead forecast.
 *
 * Aggregated here rather than from `map_snapshot_agg`, which carries only the five map
 * metrics for in-map zones. The panel needs every generation mode, and for one zone the
 * aggregation is cheap: a year is 8,760 rows against `obs_mix_hourly_zone_period_idx`.
 *
 * `hours: null` means everything there is.
 */
const WINDOWS = {
  '24h': { hours: 24, bucket: 'hour' },
  '72h': { hours: 72, bucket: 'hour' },
  '168h': { hours: 168, bucket: 'hour' },
  '30d': { hours: 24 * 30, bucket: 'day' },
  '90d': { hours: 24 * 90, bucket: 'day' },
  '1y': { hours: 24 * 365, bucket: 'day' },
  all: { hours: null, bucket: 'month' },
} as const;
type WindowKey = keyof typeof WINDOWS;

/**
 * How old a cached document may be before it is rebuilt on request.
 *
 * The warming job runs hourly, so an entry should never approach this. It exists for
 * when warming has stopped: better to make one reader wait than to serve a document
 * from last week with nothing saying so.
 */
export const CACHE_MAX_AGE_HOURS = 24;

/**
 * Marks a request as a cache build rather than a page view.
 *
 * A build gets the longer statement timeout, because it exists to pay a cost once so
 * that no reader pays it. That has to be unforgeable from outside, and it is, by
 * position rather than by secret: the warming job talks straight to Fastify on
 * 127.0.0.1:3000, while nginx blanks this header on everything it proxies (see the
 * `/api/` location in deploy/nginx.conf). A request that arrives through the front door
 * therefore cannot be carrying it, whatever it claims.
 *
 * Deliberately not an IP allowlist. `trustProxy` is on, so the address the app sees
 * comes from a forwarded header, and trusting 127.0.0.1 would let anyone willing to
 * claim that address opt into the expensive path.
 */
export const BUILD_HEADER = 'x-grid-cache-build';

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

/** EIA-930 begins here, which is what `all` means. */
const EARLIEST_PERIOD = new Date(Date.UTC(2019, 0, 1));

/**
 * The mix columns behind each share, built from `modes.yaml` rather than written out.
 *
 * Adding a canonical mode must not leave these counting the old set, which is exactly
 * the kind of drift that produces a plausible wrong percentage rather than an error.
 *
 * Each column is clamped at zero before it is summed, matching `_sum_of` in
 * `workers/db/shares.py`. A negative value is consumption, not generation, whatever
 * mode it arrives under — EIA files some operators' storage as `OTH`/`UNK`, which reach
 * `unknown`, and letting that charging load shrink the denominator inflates the share.
 * The stored column was corrected for this in September; this expression re-derives the
 * share for the panel's bucketed windows and was not, so the map and the panel
 * disagreed by 4 to 8 points for CAISO in every month measured.
 */
const columnsFor = (modes: string[]): string => {
  // These names reach the database as a raw fragment, because a column list cannot be
  // a bind parameter. They come from modes.yaml, not from a request — but the check
  // costs nothing and means a typo in config fails here rather than as SQL.
  for (const mode of modes) {
    if (!/^[a-z_]+$/.test(mode)) {
      throw new Error(`mode "${mode}" is not a plain column name; refusing to build SQL`);
    }
  }
  return modes.length === 0
    ? '0'
    : [...modes]
        .sort()
        .map((mode) => `greatest(coalesce(${mode}_mw, 0), 0)`)
        .join(' + ');
};

const MODES_CONFIG = loadModes();
const RENEWABLE_SUM = columnsFor(MODES_CONFIG.renewable);
const LOW_CARBON_SUM = columnsFor(MODES_CONFIG.low_carbon);
const COUNTED_SUM = columnsFor(
  MODES_CONFIG.canonical_modes.filter(
    (mode) => !MODES_CONFIG.excluded_from_mix_percent.includes(mode),
  ),
);

const toNumber = (value: string | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

export const zoneDetailRoutes = (app: FastifyInstance, sql: Sql, builder: Sql = sql): void => {
  app.get<{ Params: { key: string }; Querystring: { window?: string } }>(
    '/zones/:key',
    async (request, reply) => {
      const requested = request.query.window ?? '168h';
      if (!(requested in WINDOWS)) {
        throw ApiError.badRequest(
          `window must be one of ${Object.keys(WINDOWS).join(', ')}, got "${requested}"`,
        );
      }
      const { hours, bucket } = WINDOWS[requested as WindowKey];
      const cacheable = bucket !== 'hour';

      // A build of a cacheable window runs on the builder pool, which is allowed to
      // take as long as the work actually needs. Everything else — every reader, and
      // any hourly window — stays on the reader's pool and its five seconds.
      // A non-empty value, not merely presence. `proxy_set_header X-Grid-Cache-Build ""`
      // drops the field rather than forwarding an empty one, but that is nginx's
      // convention rather than a guarantee this code gets to make — and an empty string
      // is not undefined, so presence alone would hand the expensive path to anyone if
      // any proxy in front ever forwarded a blank instead of removing it.
      const marker = request.headers[BUILD_HEADER];
      const isBuild = cacheable && typeof marker === 'string' && marker.length > 0;
      const db = isBuild ? builder : sql;

      // Served from the cache when there is a recent one. `all` for a large zone reads
      // seven years of rows and runs past the statement timeout every time, so for most
      // of the map this is the difference between a panel and an error.
      if (cacheable) {
        try {
          const [cached] = await sql<{ payload: unknown }[]>`
            SELECT payload
              FROM zone_detail_cache
             WHERE zone_key = ${request.params.key}
               AND window_key = ${requested}
               AND built_at > now() - make_interval(hours => ${CACHE_MAX_AGE_HOURS})
          `;
          if (cached !== undefined) {
            reply.header('Cache-Control', 'public, max-age=60, s-maxage=300');
            reply.header('X-Cache', 'stored');
            return reply.send(cached.payload);
          }
        } catch (error) {
          // Reading the cache is an optimisation, and an optimisation must not be able
          // to fail the request. Without this, a cache table that is missing or being
          // migrated takes the whole endpoint down rather than making it slow.
          request.log.warn(
            { err: error, zone: request.params.key },
            'could not read zone detail cache',
          );
        }
      }

      const zones = await db<ZoneRow[]>`
        SELECT key, name, short_name, interconnection, timezone, type, in_map, capabilities
          FROM zones WHERE key = ${request.params.key}
      `;
      const zone = zones[0];
      if (zone === undefined) {
        throw ApiError.notFound(`No zone with key "${request.params.key}"`);
      }

      const [bounds] = await db<{ latest: Date | null }[]>`
        SELECT max(period_utc) AS latest FROM obs_region_hourly WHERE zone_key = ${zone.key}
      `;
      const latestPeriod = bounds?.latest ?? null;

      if (latestPeriod === null) {
        const latest = await latestDataPeriod(db);
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

      const from =
        hours === null
          ? EARLIEST_PERIOD
          : new Date(latestPeriod.getTime() - (hours - 1) * 3600_000);

      // Every query below groups by date_trunc, including the hourly windows, where
      // each bucket holds exactly one row and the aggregates return it unchanged. One
      // shape for all resolutions beats a branch that can drift apart.
      const [axisRows, regionRows, mixRows, forecastRows, latest] = await Promise.all([
        // The axis comes from the database so that months, which vary in length, are
        // stepped by the calendar rather than by an assumed number of milliseconds.
        // Generated rather than taken from the rows that exist: a period nobody
        // reported has to appear as a gap, not close up silently.
        db<{ period: Date }[]>`
          SELECT generate_series(
                   date_trunc(${bucket}, ${from}::timestamptz),
                   date_trunc(${bucket}, ${latestPeriod}::timestamptz),
                   ('1 ' || ${bucket})::interval
                 ) AS period
        `,
        db<RegionRow[]>`
          SELECT date_trunc(${bucket}, period_utc) AS period_utc,
                 avg(demand_mw) AS demand_mw,
                 avg(net_generation_mw) AS net_generation_mw,
                 avg(total_interchange_mw) AS total_interchange_mw
            FROM obs_region_hourly
           WHERE zone_key = ${zone.key} AND period_utc BETWEEN ${from} AND ${latestPeriod}
           GROUP BY 1
           ORDER BY 1
        `,
        // Modes are averaged so the stacked chart stays in MW and remains comparable
        // with demand. The two shares are re-derived from summed generation instead:
        // averaging hourly percentages weights a quiet hour the same as a working one.
        db<MixRow[]>`
          SELECT date_trunc(${bucket}, period_utc) AS period_utc,
                 sum(${db.unsafe(RENEWABLE_SUM)}) / nullif(sum(${db.unsafe(COUNTED_SUM)}), 0)
                   AS renewable_share,
                 sum(${db.unsafe(LOW_CARBON_SUM)}) / nullif(sum(${db.unsafe(COUNTED_SUM)}), 0)
                   AS low_carbon_share,
                 avg(coal_mw) AS coal_mw, avg(gas_mw) AS gas_mw, avg(oil_mw) AS oil_mw,
                 avg(nuclear_mw) AS nuclear_mw, avg(hydro_mw) AS hydro_mw,
                 avg(pumped_storage_mw) AS pumped_storage_mw, avg(wind_mw) AS wind_mw,
                 avg(solar_mw) AS solar_mw, avg(geothermal_mw) AS geothermal_mw,
                 avg(biomass_mw) AS biomass_mw, avg(battery_storage_mw) AS battery_storage_mw,
                 avg(other_storage_mw) AS other_storage_mw, avg(imports_mw) AS imports_mw,
                 avg(unknown_mw) AS unknown_mw
            FROM obs_mix_hourly
           WHERE zone_key = ${zone.key} AND period_utc BETWEEN ${from} AND ${latestPeriod}
           GROUP BY 1
           ORDER BY 1
        `,
        // One vintage per target hour first — the freshest issued early enough to count
        // as day-ahead — and only then averaged into the bucket. Averaging every
        // vintage instead would blend a day-ahead prediction with a same-hour revision
        // and quietly flatter the forecast.
        db<ForecastRow[]>`
          WITH chosen AS (
            SELECT DISTINCT ON (target_time_utc)
                   target_time_utc, value, horizon_h
              FROM forecast_issues
             WHERE zone_key = ${zone.key}
               AND metric = 'demand'
               AND target_time_utc BETWEEN ${from} AND ${latestPeriod}
               AND issue_time_utc <= target_time_utc
                   - make_interval(hours => ${FORECAST_HORIZON_HOURS})
             ORDER BY target_time_utc, issue_time_utc DESC
          )
          SELECT date_trunc(${bucket}, target_time_utc) AS target_time_utc,
                 avg(value) AS value,
                 min(horizon_h) AS horizon_h
            FROM chosen
           GROUP BY 1
           ORDER BY 1
        `,
        latestDataPeriod(db),
      ]);

      const periods = axisRows.map((row) => row.period);

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

      const document = {
        zone,
        series,
        sources: ['eia'],
        latest_period: isoInstant(latestPeriod),
        forecast_horizon_h: FORECAST_HORIZON_HOURS,
        meta: buildMeta(latest),
      };

      // Write-through, so the expensive windows are computed once by whoever asks
      // first — usually the warming job — and read from storage after that. Stored
      // exactly as sent, so a cache hit and a miss cannot answer differently.
      //
      // A failure here is logged and swallowed: the reader already has their answer,
      // and a cache that cannot be written is a slow site, not a broken one.
      if (cacheable) {
        try {
          await sql`
            INSERT INTO zone_detail_cache (zone_key, window_key, payload, built_at)
            VALUES (${request.params.key}, ${requested}, ${sql.json(document as unknown as Record<string, never>)}, now())
            ON CONFLICT (zone_key, window_key)
            DO UPDATE SET payload = EXCLUDED.payload, built_at = now()
          `;
        } catch (error) {
          request.log.warn({ err: error, zone: request.params.key }, 'could not store zone detail');
        }
      }

      reply.header('Cache-Control', 'public, max-age=60, s-maxage=300');
      reply.header('X-Cache', 'computed');
      return reply.send(document);
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
