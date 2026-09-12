/**
 * The metrics the map can paint, and how each one turns a value into a colour.
 *
 * Two rules run through this file:
 *
 * - **Null is not zero.** A zone with no measurement is painted a neutral grey with a
 *   pattern, never the bottom of the ramp. A grid at zero demand and a grid we know
 *   nothing about must not look the same.
 * - **Colour is never the only signal.** Every ramp has labelled stops, and the panel
 *   and tooltip always give the number.
 */

export const METRIC_ORDER = [
  'demand_mw',
  'net_generation_mw',
  'net_interchange_mw',
  'renewable_share',
  'low_carbon_share',
] as const;

export type MetricId = (typeof METRIC_ORDER)[number];

export interface MetricDefinition {
  id: MetricId;
  label: string;
  shortLabel: string;
  /** Units come from what EIA published; see `value-units` in the recorded responses. */
  unit: string;
  /** Colours from low to high. */
  ramp: string[];
  /** Fixed domain for shares; null means derive from the data in view. */
  domain: [number, number] | null;
  /** A diverging metric is centred on zero rather than spanning min to max. */
  diverging: boolean;
  format: (value: number) => string;
}

const formatPower = (value: number): string => {
  const absolute = Math.abs(value);
  if (absolute >= 1000) return `${(value / 1000).toFixed(1)} GWh`;
  return `${Math.round(value)} MWh`;
};

const formatShare = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** Sequential ramp, dark to bright, legible in both directions on a dark ground. */
const SEQUENTIAL = ['#0b2b4a', '#14507e', '#1c7ab0', '#3aa6d0', '#7fcdea', '#c9ecf8'];

/** Diverging ramp for interchange: importing versus exporting. */
const DIVERGING = ['#b3452c', '#d98a6a', '#e8d5c4', '#a9c7b5', '#4f9e77', '#1f6f4a'];

/** Renewable and low-carbon share, low to high. */
const GREENS = ['#3b2f2f', '#5c5233', '#6f7a35', '#69a244', '#4fc06a', '#8ae8a0'];

export const METRICS: Record<MetricId, MetricDefinition> = {
  demand_mw: {
    id: 'demand_mw',
    label: 'Demand',
    shortLabel: 'Demand',
    unit: 'MWh',
    ramp: SEQUENTIAL,
    domain: null,
    diverging: false,
    format: formatPower,
  },
  net_generation_mw: {
    id: 'net_generation_mw',
    label: 'Net generation',
    shortLabel: 'Generation',
    unit: 'MWh',
    ramp: SEQUENTIAL,
    domain: null,
    diverging: false,
    format: formatPower,
  },
  net_interchange_mw: {
    id: 'net_interchange_mw',
    label: 'Net interchange',
    shortLabel: 'Interchange',
    unit: 'MWh',
    ramp: DIVERGING,
    domain: null,
    diverging: true,
    format: formatPower,
  },
  renewable_share: {
    id: 'renewable_share',
    label: 'Renewable share',
    shortLabel: 'Renewable',
    unit: '%',
    ramp: GREENS,
    domain: [0, 1],
    diverging: false,
    format: formatShare,
  },
  low_carbon_share: {
    id: 'low_carbon_share',
    label: 'Low-carbon share',
    shortLabel: 'Low carbon',
    unit: '%',
    ramp: GREENS,
    domain: [0, 1],
    diverging: false,
    format: formatShare,
  },
};

export const METRIC_LIST: MetricDefinition[] = METRIC_ORDER.map((id) => METRICS[id]);

/** Where a metric sits in the snapshot and window arrays. */
export const metricIndex = (id: MetricId): number => METRIC_ORDER.indexOf(id);

/**
 * The value range to colour across.
 *
 * Nulls are excluded rather than treated as zero: including them would drag the low end
 * of every ramp down to nothing and make real low values indistinguishable from absent
 * ones.
 */
export const computeDomain = (
  definition: MetricDefinition,
  values: readonly (number | null)[],
): [number, number] => {
  if (definition.domain !== null) return definition.domain;

  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return [0, 1];

  let low = Math.min(...present);
  let high = Math.max(...present);

  if (definition.diverging) {
    // Centre on zero so that importing and exporting read symmetrically.
    const extent = Math.max(Math.abs(low), Math.abs(high)) || 1;
    return [-extent, extent];
  }

  if (low === high) {
    // A flat domain would divide by zero in the interpolation.
    low = low - 1;
    high = high + 1;
  }
  return [low, high];
};

/** Evenly spaced stops across a domain, one per ramp colour. */
export const rampStops = (
  definition: MetricDefinition,
  domain: [number, number],
): { value: number; colour: string }[] => {
  const [low, high] = domain;
  const last = definition.ramp.length - 1;
  return definition.ramp.map((colour, index) => ({
    value: low + ((high - low) * index) / last,
    colour,
  }));
};
