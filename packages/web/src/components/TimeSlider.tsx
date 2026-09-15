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
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatHourUtc } from '../lib/format.ts';
import {
  RESOLUTIONS_BY_ID,
  describeStatistic,
  formatPeriod,
  formatPeriodsBehind,
} from '../lib/resolution.ts';
import { clampIndex, hoursBehind, indexForKey, nextPlaybackIndex } from '../lib/slider.ts';
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
  const track = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

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

  /**
   * Scrubbing, driven by pointer events rather than left to the input.
   *
   * iOS is the reason. A range input there does not jump to a tapped position and does
   * not follow a drag that began anywhere but on the thumb, so scrubbing meant hitting
   * an 18px target exactly and then dragging it — which is why it kept "picking a
   * point" instead. Chrome and Firefox jump on click but still will not start a drag
   * from the track.
   *
   * Reading the position off the element makes every platform behave the same: press
   * anywhere and drag, and the cursor follows the finger. Pointer capture keeps events
   * coming even when the finger leaves the control, which matters on a 44px target.
   *
   * onChange stays for the keyboard and for anything that drives the input directly.
   */
  const indexAt = useCallback(
    (clientX: number): number => {
      const node = track.current;
      if (node === null || length === 0) return 0;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0) return 0;
      const ratio = (clientX - rect.left) / rect.width;
      return clampIndex(Math.round(ratio * (length - 1)), length);
    },
    [length],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLInputElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
      setPlaying(false);
      setCursor(indexAt(event.clientX));
    },
    [indexAt, setCursor, setPlaying],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLInputElement>) => {
      if (!dragging) return;
      setCursor(indexAt(event.clientX));
    },
    [dragging, indexAt, setCursor],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLInputElement>) => {
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

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
      // Wraps on a narrow screen: the readout is a fixed 14rem, which on a 375px phone
      // left the slider about 130px for a week of hours. A scrub target narrower than
      // a thumbnail is unusable however well it handles the gesture.
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-800 bg-zinc-950/80 px-4 py-2"
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
        ref={track}
        onChange={(event) => setCursor(Number(event.target.value))}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        aria-label={`${step.charAt(0).toUpperCase()}${step.slice(1)} shown on the map`}
        aria-valuetext={`${label}, ${relative}`}
        className="scrub min-w-[8rem] flex-1"
        data-testid="slider-input"
      />

      <div className="order-last w-full text-right sm:order-none sm:w-56 sm:shrink-0">
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
