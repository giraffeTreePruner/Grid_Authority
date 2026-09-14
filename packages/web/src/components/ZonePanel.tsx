/**
 * The detail panel for one zone.
 *
 * Fetched on selection and cached for five minutes. Every figure carries its source and
 * its age; a chart with nothing in it says so in words rather than rendering blank.
 */
import { useQuery } from '@tanstack/react-query';
import { ApiError, fetchZoneDetail } from '../api/client.ts';
import { formatAge } from '../lib/format.ts';
import { missingHours } from '../lib/series.ts';
import { useGridStore, type WindowLength } from '../store/useGridStore.ts';
import { DemandChart } from './DemandChart.tsx';
import { MixChart } from './MixChart.tsx';
import { SourceBadge } from './SourceBadge.tsx';

const WINDOWS: WindowLength[] = ['24h', '72h', '168h', '30d', '90d', '1y', 'all'];

/**
 * How long one point covers, for the windows that are not plotted hour by hour.
 *
 * A point on a year-long chart is a day's average, not a reading. Saying so is the
 * same obligation as labelling the map's coarse views: a chart that looks hourly and
 * is not invites every conclusion an hourly chart would support.
 */
const BUCKETED: Partial<Record<WindowLength, string>> = {
  '30d': 'Each point is one day, averaged over the hours that reported.',
  '90d': 'Each point is one day, averaged over the hours that reported.',
  '1y': 'Each point is one day, averaged over the hours that reported.',
  all: 'Each point is one month, averaged over the hours that reported.',
};

/**
 * EIA reports every series in megawatthours, including demand. The unit is taken from
 * what was recorded rather than assumed from the column name, which says MW.
 */
const UNIT = 'MWh';

export const ZonePanel = (): JSX.Element | null => {
  const selectedZone = useGridStore((state) => state.selectedZone);
  const selectZone = useGridStore((state) => state.selectZone);
  const detailWindow = useGridStore((state) => state.detailWindow);
  const setDetailWindow = useGridStore((state) => state.setDetailWindow);

  const detail = useQuery({
    queryKey: ['zone', selectedZone, detailWindow],
    queryFn: ({ signal }) => fetchZoneDetail(selectedZone as string, detailWindow, signal),
    enabled: selectedZone !== null,
    staleTime: 5 * 60 * 1000,
  });

  if (selectedZone === null) return null;

  return (
    <aside
      className="flex h-full w-[26rem] max-w-full flex-col gap-3 overflow-y-auto border-l border-zinc-800 bg-zinc-950/95 p-4"
      aria-label="Zone detail"
      data-testid="zone-panel"
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">
            {detail.data?.zone.short_name ?? selectedZone}
          </h2>
          <p className="text-[11px] text-zinc-500">{detail.data?.zone.name ?? ''}</p>
        </div>
        <button
          type="button"
          onClick={() => selectZone(null)}
          aria-label="Close zone detail"
          className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-700"
        >
          Close
        </button>
      </header>

      <div className="flex items-center gap-1" role="group" aria-label="Window length">
        {WINDOWS.map((window) => (
          <button
            key={window}
            type="button"
            onClick={() => setDetailWindow(window)}
            aria-pressed={window === detailWindow}
            className={[
              'rounded px-2 py-0.5 text-[11px]',
              window === detailWindow
                ? 'bg-zinc-100 text-zinc-900'
                : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700',
            ].join(' ')}
          >
            {window}
          </button>
        ))}
      </div>

      {BUCKETED[detailWindow] !== undefined && (
        <p className="text-[11px] text-zinc-500" data-testid="panel-bucket-note">
          {BUCKETED[detailWindow]}
        </p>
      )}

      {detail.isPending && (
        <p className="text-xs text-zinc-500" data-testid="panel-loading">
          Loading zone data…
        </p>
      )}

      {detail.isError && (
        <p role="alert" className="text-xs text-red-300" data-testid="panel-error">
          {detail.error instanceof ApiError
            ? detail.error.message
            : 'This zone could not be loaded.'}
        </p>
      )}

      {detail.data !== undefined && (
        <>
          <SourceBadge label="EIA Form 930" latestPeriod={detail.data.latest_period} unit={UNIT} />

          {detail.data.latest_period === null ? (
            <p className="text-xs text-zinc-500" data-testid="panel-empty">
              This zone has published no data yet.
            </p>
          ) : (
            <>
              <DemandChart detail={detail.data} unit={UNIT} />
              <MixChart detail={detail.data} unit={UNIT} />

              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-zinc-800 pt-2 text-[11px]">
                <dt className="text-zinc-500">Newest hour</dt>
                <dd className="text-right text-zinc-300">{formatAge(detail.data.latest_period)}</dd>
                <dt className="text-zinc-500">Hours with no demand</dt>
                <dd className="text-right text-zinc-300">
                  {missingHours(detail.data.series.demand_mw)} of {detail.data.series.period.length}
                </dd>
                <dt className="text-zinc-500">Interconnection</dt>
                <dd className="text-right text-zinc-300">
                  {detail.data.zone.interconnection ?? '—'}
                </dd>
              </dl>
            </>
          )}
        </>
      )}
    </aside>
  );
};
