/**
 * A window payload shaped exactly like the API's, for tests that must not hit it.
 */
import type { WindowResponse } from '../src/api/types.ts';

export const METRICS = [
  'demand_mw',
  'net_generation_mw',
  'net_interchange_mw',
  'renewable_share',
  'low_carbon_share',
];

/** Hours ending at the given instant, one per step. */
export const makeWindow = (hours = 4): WindowResponse => {
  const periods: string[] = [];
  for (let index = 0; index < hours; index += 1) {
    const at = new Date(Date.UTC(2026, 8, 11, 8 + index));
    periods.push(`${at.toISOString().slice(0, 19)}Z`);
  }

  return {
    periods,
    metrics: METRICS,
    zones: {
      // A zone with data in every hour.
      'US-TEX-ERCO': periods.map((_period, index) => [
        58000 + index * 100,
        57500 + index * 100,
        -250,
        0.41,
        0.52,
      ]),
      // A zone that reports nothing: every metric null in every hour.
      'US-NW-BPAT': periods.map(() => [null, null, null, null, null]),
      // A zone that genuinely reads zero, which must not look like the one above.
      'US-CAL-CISO': periods.map(() => [0, 0, 0, 0, 0]),
    },
    meta: {
      generated_at: '2026-09-11T12:00:00Z',
      sources: ['eia'],
      data_latest_period: periods.at(-1) ?? null,
      stale: false,
    },
  };
};
