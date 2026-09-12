/**
 * Turning a metric into a MapLibre paint expression.
 *
 * Values are pushed through `setFeatureState`, so switching metric or scrubbing the
 * slider repaints from memory with no network request and no restyle of the layer's
 * source data.
 */
import type { ExpressionSpecification } from 'maplibre-gl';
import { computeDomain, rampStops, type MetricDefinition } from './metrics.ts';

/** The colour for a zone with no value for the active metric. */
export const NO_DATA_COLOUR = '#3f3f46';

/**
 * A fill-colour expression reading `feature-state.value`.
 *
 * The `case` guard comes first: a zone whose state is missing or null is painted the
 * no-data colour rather than falling through to the bottom of the ramp.
 */
export const fillColourExpression = (
  definition: MetricDefinition,
  values: readonly (number | null)[],
): ExpressionSpecification => {
  const domain = computeDomain(definition, values);
  const stops = rampStops(definition, domain);

  const interpolate: unknown[] = ['interpolate', ['linear'], ['feature-state', 'value']];
  for (const stop of stops) interpolate.push(stop.value, stop.colour);

  return [
    'case',
    ['==', ['feature-state', 'value'], null],
    NO_DATA_COLOUR,
    ['!', ['has', 'value']],
    NO_DATA_COLOUR,
    interpolate,
  ] as unknown as ExpressionSpecification;
};

/** Opacity that dims a zone with no data, so absence reads as absence. */
export const fillOpacityExpression = (): ExpressionSpecification =>
  [
    'case',
    ['boolean', ['feature-state', 'selected'], false],
    0.95,
    ['==', ['feature-state', 'value'], null],
    0.35,
    0.85,
  ] as unknown as ExpressionSpecification;

/** Outline that thickens for the selected zone and on hover. */
export const lineWidthExpression = (): ExpressionSpecification =>
  [
    'case',
    ['boolean', ['feature-state', 'selected'], false],
    2.5,
    ['boolean', ['feature-state', 'hovered'], false],
    1.5,
    0.4,
  ] as unknown as ExpressionSpecification;
