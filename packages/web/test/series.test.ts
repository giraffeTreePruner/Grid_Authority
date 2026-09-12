/**
 * Chart series construction.
 *
 * uPlot treats null as a gap, which is exactly right here. What these tests guard is
 * that nulls survive the transformation instead of quietly becoming zeros somewhere
 * between the API and the canvas.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDemandData,
  buildMixData,
  missingHours,
  MIX_ORDER,
  toEpochSeconds,
} from '../src/lib/series.ts';
import type { ZoneSeries } from '../src/api/types.ts';

const emptyMix = (): Record<string, (number | null)[]> =>
  Object.fromEntries(MIX_ORDER.map((mode) => [mode, [null, null, null]]));

const series = (overrides: Partial<ZoneSeries> = {}): ZoneSeries => ({
  period: ['2026-09-11T10:00:00Z', '2026-09-11T11:00:00Z', '2026-09-11T12:00:00Z'],
  demand_mw: [1000, null, 1200],
  demand_forecast_mw: [950, null, null],
  demand_forecast_horizon_h: [24, null, null],
  net_generation_mw: [900, null, 1100],
  net_interchange_mw: [-100, null, -100],
  mix: emptyMix(),
  renewable_share: [0.4, null, 0.45],
  low_carbon_share: [0.5, null, 0.55],
  ...overrides,
});

describe('time axis', () => {
  it('converts to epoch seconds, which is what uPlot expects', () => {
    const [first] = toEpochSeconds(['2026-09-11T10:00:00Z']);
    expect(first).toBe(Date.UTC(2026, 8, 11, 10) / 1000);
  });
});

describe('demand series', () => {
  it('keeps missing hours as null so the line breaks', () => {
    const { data } = buildDemandData(series());
    expect(data[1]).toEqual([1000, null, 1200]);
    expect(data[1]).not.toContain(0);
  });

  it('reports whether any forecast vintage qualified', () => {
    expect(buildDemandData(series()).hasForecast).toBe(true);
    expect(buildDemandData(series({ demand_forecast_mw: [null, null, null] })).hasForecast).toBe(
      false,
    );
  });

  it('collects the horizons actually used, for labelling the comparison', () => {
    expect(buildDemandData(series()).horizons).toEqual([24]);
  });
});

describe('generation mix', () => {
  it('omits a mode the zone never reported rather than drawing a flat zero band', () => {
    const mix = emptyMix();
    mix.wind = [100, 120, 140];
    mix.gas = [400, 380, 360];

    const built = buildMixData(series({ mix }));
    expect(built.modes).toEqual(['gas', 'wind']);
    expect(built.modes).not.toContain('coal');
    expect(built.labels).toEqual(['Gas', 'Wind']);
  });

  it('stacks cumulatively in a fixed order', () => {
    const mix = emptyMix();
    mix.gas = [400, 400, 400];
    mix.wind = [100, 100, 100];

    const built = buildMixData(series({ mix }));
    // Gas is drawn before wind, so the wind band sits on top at 500.
    expect(built.data[1]).toEqual([400, 400, 400]);
    expect(built.data[2]).toEqual([500, 500, 500]);
  });

  it('leaves a gap where a mode did not report that hour', () => {
    const mix = emptyMix();
    mix.wind = [100, null, 140];

    const built = buildMixData(series({ mix }));
    // The middle hour carries the running total, not a zero that would collapse the band.
    expect(built.data[1]?.[1]).toBeNull();
  });

  it('gives every drawn mode a colour and a label', () => {
    const mix = emptyMix();
    for (const mode of MIX_ORDER) mix[mode] = [1, 1, 1];

    const built = buildMixData(series({ mix }));
    expect(built.modes).toHaveLength(MIX_ORDER.length);
    expect(built.colours.every((colour) => colour.startsWith('#'))).toBe(true);
    expect(built.labels.every((label) => label.length > 0)).toBe(true);
    expect(new Set(built.colours).size).toBe(built.colours.length);
  });

  it('returns nothing to draw when the zone reported no mix at all', () => {
    expect(buildMixData(series()).modes).toEqual([]);
  });
});

describe('missing hours', () => {
  it('counts hours with no measurement', () => {
    expect(missingHours([1, null, 3, null])).toBe(2);
    expect(missingHours([0, 0])).toBe(0);
  });
});
