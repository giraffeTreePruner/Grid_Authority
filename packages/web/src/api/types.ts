/**
 * The shapes the API returns.
 *
 * Hand-written to mirror the zod schemas in packages/api. The contract tests there are
 * what hold the two together; these types exist so the UI cannot misread a payload.
 */

export interface Meta {
  generated_at: string;
  sources: string[];
  data_latest_period: string | null;
  stale: boolean;
}

export interface Capabilities {
  demand: boolean;
  demand_forecast: boolean;
  net_generation: boolean;
  fuel_mix: boolean;
  interchange: boolean;
}

export interface Zone {
  key: string;
  name: string;
  short_name: string;
  interconnection: string | null;
  type: string;
  in_map: boolean;
  capabilities: Capabilities;
}

export interface ZonesResponse {
  zones: Zone[];
  meta: Meta;
}

/** One value per metric, in the order given by `metrics`. Null means no data. */
export type MetricValues = (number | null)[];

export interface WindowResponse {
  periods: string[];
  metrics: string[];
  /** What the server actually served, which is the authority, not what was asked. */
  resolution: string;
  /** Null for hourly, which carries measurements rather than a summary. */
  statistic: string | null;
  zones: Record<string, MetricValues[]>;
  meta: Meta;
}

export interface SnapshotResponse {
  period: string;
  metrics: string[];
  zones: Record<string, MetricValues>;
  built_at: string;
  meta: Meta;
}

export interface ZoneSeries {
  period: string[];
  demand_mw: (number | null)[];
  demand_forecast_mw: (number | null)[];
  demand_forecast_horizon_h: (number | null)[];
  net_generation_mw: (number | null)[];
  net_interchange_mw: (number | null)[];
  mix: Record<string, (number | null)[]>;
  renewable_share: (number | null)[];
  low_carbon_share: (number | null)[];
}

export interface ZoneDetailResponse {
  zone: Zone;
  series: ZoneSeries;
  sources: string[];
  latest_period: string | null;
  forecast_horizon_h: number;
  meta: Meta;
}

export interface SourceJob {
  job: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  data_latest_period: string | null;
}

export interface ObservedLatency {
  dataset: string;
  lag_minutes: number | null;
  latest_period: string | null;
  measured_at: string | null;
  readings: number;
}

export interface Source {
  id: string;
  label: string;
  attribution: string;
  url: string;
  license: string;
  independent: boolean;
  notes: string;
  active: boolean;
  jobs: SourceJob[];
  observed_latency: ObservedLatency[];
}

export interface SourcesResponse {
  sources: Source[];
  meta: Meta;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** A span of counts, as `/stats` reports them. */
export interface StatsSpan {
  today: number;
  week: number;
  all: number;
}

export interface StatsResponse {
  views: StatsSpan;
  visitors: StatsSpan;
  /** Why the wider visitor figures are not what they might look like. */
  visitors_note: string;
  daily: { day: string; views: number; visitors: number }[];
  /** Null until a Cloudflare token is configured; never merged with the counts above. */
  cloudflare: { views: StatsSpan; visitors: StatsSpan } | null;
  meta: Meta;
}
