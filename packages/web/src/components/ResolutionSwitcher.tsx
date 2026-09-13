/**
 * Choosing what one step of the slider covers, and how a period is summarised.
 *
 * Unlike the metric switcher, changing resolution does issue a request: a month of
 * summaries is a different document from an hour of measurements, and the client does
 * not hold both. The statistic control appears only above hourly, because an hour has
 * a measurement and there is nothing to summarise.
 */
import { RESOLUTION_LIST, STATISTICS, describeStatistic } from '../lib/resolution.ts';
import { useGridStore } from '../store/useGridStore.ts';

const buttonClass = (active: boolean): string =>
  [
    'rounded px-2.5 py-1 text-xs transition-colors',
    active
      ? 'bg-zinc-100 text-zinc-900 font-medium'
      : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700',
  ].join(' ');

export const ResolutionSwitcher = (): JSX.Element => {
  const resolution = useGridStore((state) => state.resolution);
  const setResolution = useGridStore((state) => state.setResolution);
  const statistic = useGridStore((state) => state.statistic);
  const setStatistic = useGridStore((state) => state.setStatistic);

  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="resolution-switcher">
      <fieldset className="flex flex-wrap items-center gap-1">
        <legend className="sr-only">How long one step covers</legend>
        {RESOLUTION_LIST.map((definition) => (
          <button
            key={definition.id}
            type="button"
            onClick={() => setResolution(definition.id)}
            aria-pressed={definition.id === resolution}
            className={buttonClass(definition.id === resolution)}
          >
            {definition.label}
          </button>
        ))}
      </fieldset>

      {resolution !== 'hour' && (
        <fieldset
          className="flex flex-wrap items-center gap-1 border-l border-zinc-800 pl-3"
          data-testid="statistic-switcher"
        >
          <legend className="sr-only">How each period is summarised</legend>
          {STATISTICS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setStatistic(id)}
              aria-pressed={id === statistic}
              // Said in words, not just chosen: a map coloured by its peak hour must
              // never leave the reader to infer that from which button looks pressed.
              title={describeStatistic(id, resolution)}
              className={buttonClass(id === statistic)}
            >
              {id === 'mean' ? 'Average' : 'Peak'}
            </button>
          ))}
        </fieldset>
      )}
    </div>
  );
};
