/**
 * A keyboard-navigable list of zones.
 *
 * §10 requires this as the fallback for map interaction. A canvas cannot be tabbed
 * through, so without a list the map is unusable without a pointer — and the values
 * shown here are the same ones the map is painting, read from the same window.
 */
import { useMemo, useState } from 'react';
import { METRICS, metricIndex } from '../lib/metrics.ts';
import { useGridStore, valuesAtCursor } from '../store/useGridStore.ts';
import type { Zone } from '../api/types.ts';

export interface ZoneListProps {
  zones: Zone[];
}

export const ZoneList = ({ zones }: ZoneListProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const metric = useGridStore((state) => state.metric);
  const cursor = useGridStore((state) => state.cursor);
  const windowPayload = useGridStore((state) => state.window);
  const selectedZone = useGridStore((state) => state.selectedZone);
  const selectZone = useGridStore((state) => state.selectZone);

  const definition = METRICS[metric];
  const values = useMemo(
    () => valuesAtCursor(windowPayload, cursor, metricIndex(metric)),
    [windowPayload, cursor, metric],
  );

  const mapped = useMemo(
    () =>
      zones
        .filter((zone) => zone.in_map)
        .sort((left, right) => left.short_name.localeCompare(right.short_name)),
    [zones],
  );

  return (
    <div className="border-t border-zinc-800" data-testid="zone-list">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="w-full px-4 py-1.5 text-left text-[11px] text-zinc-400 hover:text-zinc-200 short:py-1"
      >
        {open ? 'Hide' : 'Show'} zone list ({mapped.length}) — keyboard accessible
      </button>

      {open && (
        <ul className="max-h-48 overflow-y-auto px-2 pb-2 short:max-h-28" aria-label="Zones">
          {mapped.map((zone) => {
            const value = values.get(zone.key) ?? null;
            return (
              <li key={zone.key}>
                <button
                  type="button"
                  onClick={() => selectZone(zone.key)}
                  aria-current={zone.key === selectedZone ? 'true' : undefined}
                  className={[
                    'flex w-full items-baseline justify-between gap-4 rounded px-2 py-1 text-left text-xs',
                    zone.key === selectedZone
                      ? 'bg-zinc-800 text-zinc-100'
                      : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
                  ].join(' ')}
                >
                  <span>
                    {zone.short_name}
                    <span className="ml-2 text-[10px] text-zinc-600">{zone.key}</span>
                  </span>
                  <span className="tabular-nums">
                    {/* The number is always given, never colour alone. */}
                    {value === null ? 'no data' : definition.format(value)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
