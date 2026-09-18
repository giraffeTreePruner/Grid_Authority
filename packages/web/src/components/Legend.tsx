/**
 * The colour ramp, with labelled stops.
 *
 * Every stop carries its value: colour alone is never the signal. The no-data swatch is
 * hatched as well as grey, so it is distinguishable without relying on hue.
 *
 * `compact` is the same ramp as one row, for the footer on a short screen. A phone in
 * landscape has about 175px of map, and the floating card covers a quarter of it, so
 * there it moves into the blank space beside the footer links instead of sitting on the
 * thing it describes. It stays a reduction in density and never in information: every
 * stop keeps its value, and the no-data swatch keeps its hatching.
 */
import { computeDomain, METRICS, rampStops } from '../lib/metrics.ts';
import { useGridStore, valuesAcrossWindow, valuesAtCursor } from '../store/useGridStore.ts';
import { RESOLUTIONS_BY_ID } from '../lib/resolution.ts';
import { metricIndex } from '../lib/metrics.ts';

export interface LegendProps {
  /** One row, no card, for the footer on a short screen. */
  compact?: boolean;
}

export const Legend = ({ compact = false }: LegendProps = {}): JSX.Element | null => {
  const metric = useGridStore((state) => state.metric);
  const cursor = useGridStore((state) => state.cursor);
  const windowPayload = useGridStore((state) => state.window);
  const resolution = useGridStore((state) => state.resolution);

  if (windowPayload === null) return null;

  const definition = METRICS[metric];
  const position = metricIndex(metric);
  // The unit on screen, so the no-data wording matches what a step actually covers.
  const step = RESOLUTIONS_BY_ID[resolution].step;

  // The domain spans the window, matching what the map is painted with. Reading it
  // from the cursor's hour instead would label the ramp with one hour's range while
  // the map was coloured by another's.
  const domain = computeDomain(definition, valuesAcrossWindow(windowPayload, position));
  const stops = rampStops(definition, domain);

  // Whether to dim the ramp is still a question about the hour on screen.
  const anyData = [...valuesAtCursor(windowPayload, cursor, position).values()].some(
    (value) => value !== null,
  );

  if (compact) {
    return (
      <div className="flex items-center gap-2" data-testid="legend-compact">
        {/*
          No metric name here, unlike the full legend.

          It would be the third place the same word is on screen: the switcher in the
          header already shows which metric is selected, and every stop below carries
          its own unit. Repeating it cost about 107px, which is the difference between
          the footer links sitting on one line and wrapping onto two — and a wrapped
          footer takes its extra height straight out of the map.
        */}
        {/*
          `items-start`, not `items-end` as the full legend uses.

          Aligned at the bottom, a stop whose label fits on one line sits lower than its
          neighbours, and the ramp reads as a broken bar rather than a scale — which is
          what happened: `0 MWh` fits in the box and `124.4 GWh` does not, so the first
          swatch hung 9px below the other five. Aligning at the top puts every swatch on
          the same line whatever its label does underneath, and `whitespace-nowrap` with
          a wider box stops the wrapping that caused it in the first place.
        */}
        <div className={anyData ? 'flex items-start gap-0' : 'flex items-start gap-0 opacity-40'}>
          {stops.map((stop, index) => (
            <div key={stop.colour} className="flex w-12 flex-col items-start">
              {/* A hairline around the bar. The floating legend sits on its own panel,
                  so its darkest stop reads against that; here there is no card, and the
                  low end is within a few percent of the footer's own background. The
                  ring is what makes the scale's start visible rather than looking like
                  it begins at the second stop. */}
              <span
                className={[
                  'h-2 w-full ring-1 ring-inset ring-zinc-700/70',
                  index === 0 ? 'rounded-l-sm' : '',
                  index === stops.length - 1 ? 'rounded-r-sm' : '',
                ].join(' ')}
                style={{ backgroundColor: stop.colour }}
              />
              <span className="mt-0.5 whitespace-nowrap text-[9px] leading-none tabular-nums text-zinc-400">
                {definition.format(stop.value)}
              </span>
            </div>
          ))}
        </div>

        <span className="flex shrink-0 items-center gap-1.5">
          <span className="nodata-swatch h-2 w-4 rounded-sm" aria-hidden="true" />
          <span className="text-[10px] text-zinc-500">no data</span>
        </span>

        {!anyData && (
          <span className="text-[10px] text-amber-300/80" data-testid="legend-no-data">
            Nothing published this {step}.
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded bg-zinc-900/85 p-3 text-xs shadow-lg backdrop-blur"
      data-testid="legend"
    >
      <p className="mb-2 font-medium text-zinc-100">
        {definition.label}
        <span className="ml-1 font-normal text-zinc-500">({definition.unit})</span>
      </p>

      {!anyData && (
        <p className="mb-2 text-[11px] text-amber-300/80" data-testid="legend-no-data">
          No zone published this metric for this {step}.
        </p>
      )}

      <div className={anyData ? 'flex items-end gap-0' : 'flex items-end gap-0 opacity-40'}>
        {stops.map((stop) => (
          <div key={stop.colour} className="flex w-14 flex-col items-start">
            <span className="h-3 w-full" style={{ backgroundColor: stop.colour }} />
            <span className="mt-1 text-[10px] tabular-nums text-zinc-400">
              {definition.format(stop.value)}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-zinc-800 pt-2">
        <span className="nodata-swatch h-3 w-6 rounded-sm" aria-hidden="true" />
        <span className="text-[11px] text-zinc-400">
          No data: this zone published nothing for this {step}
        </span>
      </div>
    </div>
  );
};
