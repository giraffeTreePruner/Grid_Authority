/**
 * The application shell.
 *
 * On load it fetches the registry and one window of map data in parallel. Everything
 * the slider and the metric switcher need is in that one response; neither issues a
 * request afterwards, which is what §10 requires and what the control tests assert.
 *
 * Changing resolution is the one control that does refetch: a month of summaries is a
 * different document from an hour of measurements.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApiError, fetchWindow, fetchZones } from './api/client.ts';
import { Legend } from './components/Legend.tsx';
import { MapView } from './components/MapView.tsx';
import { MetricSwitcher } from './components/MetricSwitcher.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { ZoneList } from './components/ZoneList.tsx';
import { ZonePanel } from './components/ZonePanel.tsx';
import { TimeSlider } from './components/TimeSlider.tsx';
import { ResolutionSwitcher } from './components/ResolutionSwitcher.tsx';
import { rangeFor } from './lib/resolution.ts';
import { useGridStore } from './store/useGridStore.ts';

const GEOMETRY_VERSION = import.meta.env.VITE_GEOMETRY_VERSION ?? '1';

/** The default hourly range, kept as a named export because the tests pin it. */
export const defaultWindowRange = (now: Date = new Date()): { from: string; to: string } =>
  rangeFor('hour', now);

const messageFor = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'An unexpected error occurred.';

export const App = (): JSX.Element => {
  const setWindow = useGridStore((state) => state.setWindow);
  const windowPayload = useGridStore((state) => state.window);

  const zones = useQuery({
    queryKey: ['zones'],
    queryFn: ({ signal }) => fetchZones(signal),
    staleTime: 60 * 60 * 1000,
  });

  const resolution = useGridStore((state) => state.resolution);
  const statistic = useGridStore((state) => state.statistic);

  const range = rangeFor(resolution);
  const windowQuery = useQuery({
    queryKey: ['window', resolution, statistic, range.from, range.to],
    queryFn: ({ signal }) => fetchWindow(range.from, range.to, resolution, statistic, signal),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (windowQuery.data !== undefined) setWindow(windowQuery.data);
  }, [windowQuery.data, setWindow]);

  const failure = windowQuery.error ?? zones.error ?? null;
  const loading = zones.isPending || windowQuery.isPending;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm font-semibold tracking-wide">Grid Authority</h1>
          <p className="hidden text-xs text-zinc-400 sm:block">
            United States balancing authorities, by the hour since 2019, from EIA Form 930
          </p>
        </div>
        <MetricSwitcher />
      </header>

      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-1.5">
        <ResolutionSwitcher />
      </div>

      <StatusBar
        meta={windowPayload?.meta ?? null}
        error={failure === null ? null : messageFor(failure)}
        onRetry={() => void windowQuery.refetch()}
      />

      <main className="relative flex flex-1 overflow-hidden">
        <div className="relative flex-1">
          <MapView geometryVersion={GEOMETRY_VERSION} />

          <div className="pointer-events-none absolute bottom-4 left-4">
            <div className="pointer-events-auto">
              <Legend />
            </div>
          </div>

          {loading && failure === null && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <p className="rounded bg-zinc-900/80 px-3 py-2 text-xs text-zinc-300">
                Loading a week of grid data…
              </p>
            </div>
          )}
        </div>

        <ZonePanel />
      </main>

      <TimeSlider />

      <ZoneList zones={zones.data?.zones ?? []} />

      <footer className="flex flex-wrap items-center gap-3 border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">
        <a
          className="underline decoration-zinc-700 underline-offset-2 hover:text-zinc-300"
          href="https://github.com/giraffeTreePruner/Grid_Authority"
        >
          Source code (AGPL-3.0)
        </a>
        <a
          className="underline decoration-zinc-700 underline-offset-2 hover:text-zinc-300"
          href="/about/data"
        >
          About the data
        </a>
      </footer>
    </div>
  );
};
