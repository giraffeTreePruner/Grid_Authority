/**
 * The colour ramp, with labelled stops.
 *
 * Every stop carries its value: colour alone is never the signal. The no-data swatch is
 * hatched as well as grey, so it is distinguishable without relying on hue.
 */
import { computeDomain, METRICS, rampStops } from '../lib/metrics.ts';
import { useGridStore, valuesAtCursor } from '../store/useGridStore.ts';
import { metricIndex } from '../lib/metrics.ts';

export const Legend = (): JSX.Element | null => {
  const metric = useGridStore((state) => state.metric);
  const cursor = useGridStore((state) => state.cursor);
  const windowPayload = useGridStore((state) => state.window);

  if (windowPayload === null) return null;

  const definition = METRICS[metric];
  const values = [...valuesAtCursor(windowPayload, cursor, metricIndex(metric)).values()];
  const domain = computeDomain(definition, values);
  const stops = rampStops(definition, domain);

  return (
    <div
      className="rounded bg-zinc-900/85 p-3 text-xs shadow-lg backdrop-blur"
      data-testid="legend"
    >
      <p className="mb-2 font-medium text-zinc-100">
        {definition.label}
        <span className="ml-1 font-normal text-zinc-500">({definition.unit})</span>
      </p>

      <div className="flex items-end gap-0">
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
          No data: this zone published nothing for this hour
        </span>
      </div>
    </div>
  );
};
