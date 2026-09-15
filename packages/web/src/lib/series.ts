/**
 * Turning an API series into what uPlot wants, without inventing anything.
 *
 * uPlot takes parallel arrays and treats null as a gap. That suits this project
 * exactly: a missing hour stays a hole in the line rather than being bridged, so the
 * chart cannot imply a measurement that was never published.
 */
import type { ZoneSeries } from '../api/types.ts';

/** uPlot expects seconds since the epoch, not milliseconds. */
export const toEpochSeconds = (periods: readonly string[]): number[] =>
  periods.map((iso) => Math.floor(new Date(iso).getTime() / 1000));

export interface DemandChartData {
  /** x, demand, forecast */
  data: [number[], (number | null)[], (number | null)[]];
  /** Whether any forecast point exists; an empty line should say why. */
  hasForecast: boolean;
  /** The horizons actually used, for labelling what the comparison is. */
  horizons: number[];
}

export const buildDemandData = (series: ZoneSeries): DemandChartData => {
  const horizons = series.demand_forecast_horizon_h.filter(
    (value): value is number => value !== null,
  );
  return {
    data: [toEpochSeconds(series.period), series.demand_mw, series.demand_forecast_mw],
    hasForecast: series.demand_forecast_mw.some((value) => value !== null),
    horizons,
  };
};

/** Modes in a fixed draw order, so the stack does not reshuffle between renders. */
export const MIX_ORDER = [
  'nuclear',
  'coal',
  'gas',
  'oil',
  'hydro',
  'wind',
  'solar',
  'geothermal',
  'biomass',
  'pumped_storage',
  'battery_storage',
  'other_storage',
  'imports',
  'unknown',
] as const;

export const MIX_COLOURS: Record<string, string> = {
  nuclear: '#a78bfa',
  coal: '#57534e',
  gas: '#f59e0b',
  oil: '#7c2d12',
  hydro: '#38bdf8',
  wind: '#4ade80',
  solar: '#fde047',
  geothermal: '#fb7185',
  biomass: '#84cc16',
  pumped_storage: '#0ea5e9',
  battery_storage: '#c084fc',
  other_storage: '#94a3b8',
  imports: '#64748b',
  unknown: '#3f3f46',
};

export const MIX_LABELS: Record<string, string> = {
  nuclear: 'Nuclear',
  coal: 'Coal',
  gas: 'Gas',
  oil: 'Oil',
  hydro: 'Hydro',
  wind: 'Wind',
  solar: 'Solar',
  geothermal: 'Geothermal',
  biomass: 'Biomass',
  pumped_storage: 'Pumped storage',
  battery_storage: 'Battery',
  other_storage: 'Other storage',
  imports: 'Imports',
  unknown: 'Unknown',
};

export interface MixChartData {
  data: (number[] | (number | null)[])[];
  modes: string[];
  colours: string[];
  labels: string[];
  /**
   * Each mode's own value per period, unstacked.
   *
   * `data` carries cumulative bands, because that is what draws a stacked area. A
   * reader asking "how much wind" wants the wind, not the running total it happens to
   * sit on top of, so the readout needs these and the chart needs those.
   */
  raw: (number | null)[][];
  /**
   * Colours and labels in the order the bands appear in `data`.
   *
   * Which is the reverse of reading order. A cumulative band is drawn as an area from
   * the axis up to its running total, so every band covers the ones below it — and
   * uPlot paints series in array order, meaning the last drawn is the grand total and
   * hides everything. Ordering the largest first lets each smaller band paint on top,
   * which is what makes the stack legible.
   *
   * `labels` and `colours` stay in reading order for the legend.
   */
  seriesColours: string[];
  seriesLabels: string[];
}

/**
 * Cumulative bands for a stacked area.
 *
 * Only modes that actually reported are included, so a zone with no coal has no coal
 * band rather than a flat zero one. An hour where a mode is null contributes nothing
 * to the running total and the band carries null there, leaving a gap.
 */
export const buildMixData = (series: ZoneSeries): MixChartData => {
  const present = MIX_ORDER.filter((mode) =>
    (series.mix[mode] ?? []).some((value) => value !== null),
  );

  const x = toEpochSeconds(series.period);
  const running = new Array<number | null>(x.length).fill(null);
  const bands: (number | null)[][] = [];

  for (const mode of present) {
    const values = series.mix[mode] ?? [];
    const band: (number | null)[] = [];
    for (let index = 0; index < x.length; index += 1) {
      const value = values[index] ?? null;
      if (value === null) {
        band.push(running[index] ?? null);
        continue;
      }
      const base = running[index] ?? 0;
      const top = base + value;
      running[index] = top;
      band.push(top);
    }
    bands.push(band);
  }

  const colours = present.map((mode) => MIX_COLOURS[mode] ?? '#3f3f46');
  const labels = present.map((mode) => MIX_LABELS[mode] ?? mode);

  return {
    // Largest cumulative first, so each smaller band paints over it.
    data: [x, ...[...bands].reverse()],
    seriesColours: [...colours].reverse(),
    seriesLabels: [...labels].reverse(),
    modes: [...present],
    colours,
    labels,
    raw: present.map((mode) => {
      const values = series.mix[mode] ?? [];
      return x.map((_period, index) => values[index] ?? null);
    }),
  };
};

/** Count of hours with no measurement, so the panel can say so plainly. */
export const missingHours = (values: readonly (number | null)[]): number =>
  values.filter((value) => value === null).length;

/**
 * Where a period sits in a series, for a cursor that came from somewhere else.
 *
 * The map's slider and the panel's charts do not share an axis: the panel may be
 * bucketed by day or month while the map is hourly, and the two windows differ in
 * length. Matching by timestamp rather than by index is what lets the panel follow the
 * slider at all — the last period at or before the target, which is the bucket the
 * target falls inside.
 *
 * Returns null when the target is outside the series, so a caller can fall back rather
 * than point at an edge and imply a reading that is not there.
 */
export const indexForPeriod = (
  periods: readonly string[],
  target: string | null,
): number | null => {
  if (target === null || periods.length === 0) return null;
  if (target < periods[0]!) return null;

  for (let index = periods.length - 1; index >= 0; index -= 1) {
    if (periods[index]! <= target) return index;
  }
  return null;
};
