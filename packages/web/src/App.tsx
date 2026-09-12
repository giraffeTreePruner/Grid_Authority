/**
 * The application shell.
 *
 * On load it fetches the registry and one week of map data in parallel. Everything the
 * slider and the metric switcher need is in that one window response; neither issues a
 * request afterwards.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { fetchWindow, fetchZones } from './api/client.ts';
import { MapView } from './components/MapView.tsx';
import { useGridStore } from './store/useGridStore.ts';

const WINDOW_HOURS = 168;
const GEOMETRY_VERSION = import.meta.env.VITE_GEOMETRY_VERSION ?? '1';

/** The 168-hour range ending at the most recent complete hour. */
export const defaultWindowRange = (now: Date = new Date()): { from: string; to: string } => {
  const end = new Date(now);
  end.setUTCMinutes(0, 0, 0);
  end.setUTCHours(end.getUTCHours() - 1);
  const start = new Date(end.getTime() - (WINDOW_HOURS - 1) * 3600_000);
  const iso = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;
  return { from: iso(start), to: iso(end) };
};

export const App = (): JSX.Element => {
  const setWindow = useGridStore((state) => state.setWindow);

  const zones = useQuery({
    queryKey: ['zones'],
    queryFn: ({ signal }) => fetchZones(signal),
    staleTime: 60 * 60 * 1000,
  });

  const range = defaultWindowRange();
  const window = useQuery({
    queryKey: ['window', range.from, range.to],
    queryFn: ({ signal }) => fetchWindow(range.from, range.to, signal),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (window.data !== undefined) setWindow(window.data);
  }, [window.data, setWindow]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-baseline gap-3 border-b border-zinc-800 px-4 py-2">
        <h1 className="text-sm font-semibold tracking-wide">Grid Authority</h1>
        <p className="text-xs text-zinc-400">
          United States balancing authorities, hourly, from EIA Form 930
        </p>
      </header>

      <main className="relative flex-1">
        <MapView geometryVersion={GEOMETRY_VERSION} />
        {(zones.isPending || window.isPending) && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <p className="rounded bg-zinc-900/80 px-3 py-2 text-xs text-zinc-300">
              Loading grid data…
            </p>
          </div>
        )}
      </main>
    </div>
  );
};
