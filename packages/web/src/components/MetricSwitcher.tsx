/**
 * Choosing what the map colours by.
 *
 * Switching repaints from the window already in memory. It issues no request, which is
 * the point of loading a whole week up front.
 */
import { METRIC_LIST } from '../lib/metrics.ts';
import { useGridStore } from '../store/useGridStore.ts';

export const MetricSwitcher = (): JSX.Element => {
  const metric = useGridStore((state) => state.metric);
  const setMetric = useGridStore((state) => state.setMetric);

  return (
    <fieldset className="flex flex-wrap items-center gap-1" data-testid="metric-switcher">
      <legend className="sr-only">Metric shown on the map</legend>
      {METRIC_LIST.map((definition) => {
        const active = definition.id === metric;
        return (
          <button
            key={definition.id}
            type="button"
            onClick={() => setMetric(definition.id)}
            aria-pressed={active}
            className={[
              'rounded px-2.5 py-1 text-xs transition-colors',
              active
                ? 'bg-zinc-100 text-zinc-900 font-medium'
                : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700',
            ].join(' ')}
          >
            {definition.shortLabel}
          </button>
        );
      })}
    </fieldset>
  );
};
