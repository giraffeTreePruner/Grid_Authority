/**
 * The application shell.
 *
 * On load it fetches the registry and one window of map data in parallel. Everything
 * the slider and the metric switcher need is in that one response; neither issues a
 * request afterwards, which is what §10 requires and what the control tests assert.
 *
 * Changing resolution is the one control that does refetch: a month of summaries is a
 * different document from an hour of measurements.
 *
 * One layout rule runs through the header and the footer: **a control for the map is
 * shown only when the map is.** On a phone the zone panel is a full sheet over the map,
 * so the metric switcher, the resolution control and the time slider would all be
 * driving something the reader cannot see — and the panel has its own window control,
 * which made two different time ranges visible at once and only one of them relevant.
 * They are hidden under `sm` while a zone is open, and unchanged beside a visible map.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApiError, fetchWindow, fetchZones } from './api/client.ts';
import { Legend } from './components/Legend.tsx';
import { MapView } from './components/MapView.tsx';
import { Mark } from './components/Mark.tsx';
import { MetricSwitcher } from './components/MetricSwitcher.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { ZoneList } from './components/ZoneList.tsx';
import { ZonePanel } from './components/ZonePanel.tsx';
import { TimeSlider } from './components/TimeSlider.tsx';
import { ResolutionSwitcher } from './components/ResolutionSwitcher.tsx';
import { rangeFor } from './lib/resolution.ts';
import { useGridStore } from './store/useGridStore.ts';

const GEOMETRY_VERSION = import.meta.env.VITE_GEOMETRY_VERSION ?? '2';

/** The default hourly range, kept as a named export because the tests pin it. */
export const defaultWindowRange = (now: Date = new Date()): { from: string; to: string } =>
  rangeFor('hour', now);

const messageFor = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'An unexpected error occurred.';

export const App = (): JSX.Element => {
  const setWindow = useGridStore((state) => state.setWindow);
  const windowPayload = useGridStore((state) => state.window);
  const selectedZone = useGridStore((state) => state.selectedZone);
  const zoneOpen = selectedZone !== null;

  // Hidden on a phone while the zone sheet covers the map; always shown beside it.
  const mapControls = zoneOpen ? 'hidden sm:block' : 'block';

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
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-2 short:gap-2 short:py-1">
        <div className="flex items-center gap-2 sm:gap-3">
          <Mark size={22} className="shrink-0" />
          <h1 className="text-sm font-semibold tracking-wide">Grid Authority</h1>
          <p className="hidden text-xs text-zinc-400 sm:block">Live US Grid View</p>
        </div>
        <div className={mapControls} data-testid="metric-controls">
          <MetricSwitcher />
        </div>
      </header>

      <div
        className={[
          'flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-1.5 short:py-0.5',
          zoneOpen ? 'hidden sm:flex' : 'flex',
        ].join(' ')}
        data-testid="resolution-controls"
      >
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

          {/* Hidden under the zone sheet on a phone: there is no room for both, and
              the legend describes a map the reader cannot currently see.

              Hidden on a short screen too, where it moves into the footer. Floating, it
              is 360x117 over about 175px of map on a landscape phone — a quarter of the
              thing it exists to explain. */}
          <div
            className={[
              'pointer-events-none absolute bottom-4 left-4 short:hidden',
              selectedZone === null ? '' : 'hidden sm:block',
            ].join(' ')}
          >
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

      <div className={mapControls} data-testid="slider-controls">
        <TimeSlider />
      </div>

      {/* On a short screen the zone-list row and the footer become one band: the two
          link rows keep the left, and the ramp takes the blank space beside both of
          them rather than forcing the footer taller on its own. Below `short` this
          wrapper is a plain block and the two rows stack exactly as they did. */}
      <div className="short:flex short:items-stretch">
        <div className="min-w-0 flex-1">
          <ZoneList zones={zones.data?.zones ?? []} />

          <footer className="flex flex-wrap items-center gap-3 border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-500 short:py-1">
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
              About the data — Why is some missing?
            </a>
          </footer>
        </div>

        {/* Only on a short screen, and only beside a map the reader can actually see —
            the same rule the floating one follows. */}
        <div
          className={[
            'hidden shrink-0 items-center border-l border-t border-zinc-800 px-2 short:flex',
            selectedZone === null ? '' : 'short:hidden',
          ].join(' ')}
          data-testid="footer-legend"
        >
          <Legend compact />
        </div>
      </div>
    </div>
  );
};
