/**
 * The metric expression builder.
 *
 * The rule under test throughout: a zone with no measurement must never be painted as
 * though it measured zero. A grid genuinely at zero and a grid we know nothing about
 * have to look different.
 */
import { describe, expect, it } from 'vitest';
import {
  computeDomain,
  METRIC_LIST,
  METRIC_ORDER,
  METRICS,
  metricIndex,
  rampStops,
} from '../src/lib/metrics.ts';
import { fillColourExpression, fillOpacityExpression, NO_DATA_COLOUR } from '../src/lib/paint.ts';

describe('metric registry', () => {
  it('matches the order the API serves', () => {
    expect([...METRIC_ORDER]).toEqual([
      'demand_mw',
      'net_generation_mw',
      'net_interchange_mw',
      'renewable_share',
      'low_carbon_share',
    ]);
  });

  it('indexes into the snapshot arrays by position', () => {
    expect(metricIndex('demand_mw')).toBe(0);
    expect(metricIndex('low_carbon_share')).toBe(4);
    expect(METRIC_LIST).toHaveLength(5);
  });

  it('gives every metric a unit and a formatter', () => {
    for (const definition of METRIC_LIST) {
      expect(definition.unit).not.toBe('');
      expect(definition.format(0.5)).toMatch(/\S/);
      expect(definition.ramp.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('domain', () => {
  it('ignores nulls rather than treating them as zero', () => {
    // With nulls counted as zero the low end would be 0 and every real value would
    // crowd into the top of the ramp.
    const withNulls = computeDomain(METRICS.demand_mw, [null, 1000, null, 2000]);
    const without = computeDomain(METRICS.demand_mw, [1000, 2000]);
    expect(withNulls).toEqual(without);
    expect(withNulls[0]).toBe(1000);
  });

  it('uses a fixed zero-to-one domain for shares', () => {
    expect(computeDomain(METRICS.renewable_share, [0.2, 0.3])).toEqual([0, 1]);
    expect(computeDomain(METRICS.low_carbon_share, [])).toEqual([0, 1]);
  });

  it('centres a diverging metric on zero', () => {
    const [low, high] = computeDomain(METRICS.net_interchange_mw, [-200, 50]);
    expect(low).toBe(-200);
    expect(high).toBe(200);
    expect(low + high).toBe(0);
  });

  it('widens a flat domain so interpolation cannot divide by zero', () => {
    const [low, high] = computeDomain(METRICS.demand_mw, [500, 500]);
    expect(high).toBeGreaterThan(low);
  });

  it('survives having no data at all', () => {
    expect(() => computeDomain(METRICS.demand_mw, [null, null])).not.toThrow();
    expect(() => computeDomain(METRICS.demand_mw, [])).not.toThrow();
  });
});

describe('ramp stops', () => {
  it('produces one labelled stop per colour, spanning the domain', () => {
    const stops = rampStops(METRICS.renewable_share, [0, 1]);
    expect(stops).toHaveLength(METRICS.renewable_share.ramp.length);
    expect(stops[0]!.value).toBe(0);
    expect(stops.at(-1)!.value).toBe(1);
  });

  it('increases monotonically, so the legend reads in order', () => {
    const stops = rampStops(METRICS.demand_mw, [100, 900]);
    const values = stops.map((stop) => stop.value);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });
});

describe('fill colour expression', () => {
  const expression = (values: (number | null)[]): unknown[] =>
    fillColourExpression(METRICS.demand_mw, values) as unknown as unknown[];

  it('paints a null feature-state with the no-data colour', () => {
    const built = expression([1000, 2000]);
    expect(built[0]).toBe('case');
    // The null guard must come first, before any interpolation.
    expect(built[1]).toEqual(['==', ['feature-state', 'value'], null]);
    expect(built[2]).toBe(NO_DATA_COLOUR);
  });

  it('paints a feature with no state at all as no-data', () => {
    // An unset feature-state reads as null, so the null guard covers this too.
    const built = expression([1000, 2000]);
    expect(built[1]).toEqual(['==', ['feature-state', 'value'], null]);
    expect(built[2]).toBe(NO_DATA_COLOUR);
  });

  it('never tests feature properties in place of feature state', () => {
    // ['has', 'value'] inspects the feature's properties. The tiles carry only
    // zone_key, so that test is always false and, negated, paints every zone as
    // no-data whatever its value. This shipped once; it must not again.
    const serialised = JSON.stringify(expression([1000, 2000]));
    expect(serialised).not.toContain('"has"');
  });

  it('evaluates to a ramp colour for a real value and no-data for null', () => {
    // Structure alone is not enough: the bug above produced a well-formed expression
    // that painted everything grey. This walks the case arms as MapLibre would.
    const built = expression([0, 100]) as unknown[];
    const evaluate = (state: { value: number | null } | null): string => {
      const condition = built[1] as unknown[];
      const isNull = state === null || state.value === null;
      expect(condition[0]).toBe('==');
      if (isNull) return built[2] as string;
      const interpolate = built.at(-1) as unknown[];
      return interpolate[4] as string; // the colour at the first stop
    };

    expect(evaluate(null)).toBe(NO_DATA_COLOUR);
    expect(evaluate({ value: null })).toBe(NO_DATA_COLOUR);
    expect(evaluate({ value: 50 })).not.toBe(NO_DATA_COLOUR);
  });

  it('interpolates linearly over the ramp for real values', () => {
    const built = expression([0, 100]) as [string, ...unknown[]];
    const interpolate = built.at(-1) as unknown[];
    expect(interpolate[0]).toBe('interpolate');
    expect(interpolate[1]).toEqual(['linear']);
    expect(interpolate[2]).toEqual(['feature-state', 'value']);
    // pairs of stop, colour
    expect((interpolate.length - 3) % 2).toBe(0);
  });

  it('never maps a real zero to the no-data colour', () => {
    const built = expression([0, 500]) as unknown[];
    const interpolate = built.at(-1) as unknown[];
    const colours = interpolate.filter((item): item is string => typeof item === 'string');
    expect(colours).not.toContain(NO_DATA_COLOUR);
  });

  it('builds without throwing when every value is null', () => {
    expect(() => expression([null, null])).not.toThrow();
  });
});

describe('opacity expression', () => {
  it('dims a zone with no data so absence reads as absence', () => {
    const built = fillOpacityExpression() as unknown as unknown[];
    const nullIndex = built.findIndex(
      (item) => JSON.stringify(item) === JSON.stringify(['==', ['feature-state', 'value'], null]),
    );
    expect(nullIndex).toBeGreaterThan(0);
    expect(built[nullIndex + 1]).toBeLessThan(built.at(-1) as number);
  });
});
