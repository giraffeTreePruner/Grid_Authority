/**
 * The time slider.
 *
 * One step is one period of whatever resolution is active — an hour, a day, a week or
 * a month — and every label says which, so a reader never has to infer the unit from
 * the controls.
 *
 * Scrubbing indexes into the window already loaded; nothing here fetches. Playback runs
 * on requestAnimationFrame at roughly eight steps a second and pauses when the tab is
 * hidden, so a backgrounded page is not animating a map nobody is looking at.
 */
import { useCallback, useEffect, useRef } from 'react';
import { formatHourUtc } from '../lib/format.ts';
import {
  RESOLUTIONS_BY_ID,
  describeStatistic,
  formatPeriod,
  formatPeriodsBehind,
} from '../lib/resolution.ts';
import { hoursBehind, indexForKey, nextPlaybackIndex } from '../lib/slider.ts';
import { useGridStore } from '../store/useGridStore.ts';

/** Roughly eight steps a second, as the spec asks. */
export const PLAYBACK_INTERVAL_MS = 125;

export const TimeSlider = (): JSX.Element | null => {
  const windowPayload = useGridStore((state) => state.window);
  const cursor = useGridStore((state) => state.cursor);
  const setCursor = useGridStore((state) => state.setCursor);
  const playing = useGridStore((state) => state.playing);
  const setPlaying = useGridStore((state) => state.setPlaying);
  const togglePlaying = useGridStore((state) => state.togglePlaying);
  const resolution = useGridStore((state) => state.resolution);
  const statistic = useGridStore((state) => state.statistic);

  const frame = useRef<number | null>(null);
  const lastStep = useRef(0);

  const periods = windowPayload?.periods ?? [];
  const length = periods.length;

  // --- playback ----------------------------------------------------------------------
  useEffect(() => {
    if (!playing || length === 0) return;

    const tick = (now: number): void => {
      if (now - lastStep.current >= PLAYBACK_INTERVAL_MS) {
        lastStep.current = now;
        setCursor(nextPlaybackIndex(useGridStore.getState().cursor, length));
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);

    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [playing, length, setCursor]);

  // A hidden tab should not animate; browsers throttle rAF anyway, but stopping is
  // honest about it and avoids a burst of catch-up frames on return.
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [setPlaying]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        togglePlaying();
        return;
      }
      const next = indexForKey(event.key, cursor, length, RESOLUTIONS_BY_ID[resolution].page);
      if (next === null) return;
      event.preventDefault();
      setCursor(next);
    },
    [cursor, length, resolution, setCursor, togglePlaying],
  );

  if (windowPayload === null || length === 0) return null;

  const current = periods[cursor] ?? periods[length - 1]!;
  const behind = hoursBehind(cursor, length);
  const step = RESOLUTIONS_BY_ID[resolution].step;
  const label = formatPeriod(current, resolution);
  const relative = formatPeriodsBehind(behind, resolution);

  return (
    <div
      className="flex items-center gap-3 border-t border-zinc-800 bg-zinc-950/80 px-4 py-2"
      data-testid="time-slider"
    >
      <button
        type="button"
        onClick={togglePlaying}
        aria-label={playing ? 'Pause playback' : `Play through the ${step}s`}
        className="rounded bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
      >
        {playing ? 'Pause' : 'Play'}
      </button>

      <input
        type="range"
        min={0}
        max={length - 1}
        step={1}
        value={cursor}
        onChange={(event) => setCursor(Number(event.target.value))}
        onKeyDown={onKeyDown}
        aria-label={`${step.charAt(0).toUpperCase()}${step.slice(1)} shown on the map`}
        aria-valuetext={`${label}, ${relative}`}
        className="h-1 flex-1 cursor-pointer appearance-none rounded bg-zinc-700 accent-zinc-100"
        data-testid="slider-input"
      />

      <div className="w-56 shrink-0 text-right">
        <p className="text-xs font-medium text-zinc-100" data-testid="cursor-label">
          {label}
        </p>
        <p className="text-[11px] text-zinc-500" title="The period label the data carries">
          {resolution === 'hour' ? `${formatHourUtc(current)} · ${relative}` : relative}
        </p>
        {resolution !== 'hour' && (
          <p className="text-[11px] text-zinc-500" data-testid="statistic-note">
            {describeStatistic(statistic, resolution)}
          </p>
        )}
      </div>
    </div>
  );
};
