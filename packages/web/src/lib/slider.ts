/**
 * Index arithmetic for the time slider.
 *
 * Kept separate from the component because it is the part that can be wrong in ways a
 * render test would not catch: stepping off the end, wrapping during playback, and
 * mapping a period to its position.
 */

export const HOURS_PER_DAY = 24;

/** Keep an index inside the array, whatever is asked for. */
export const clampIndex = (index: number, length: number): number => {
  if (length <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), length - 1);
};

/**
 * The next index during playback.
 *
 * Wraps to the start rather than stopping at the end: the loop is what makes a day's
 * cycle legible, and a player that halts silently looks broken.
 */
export const nextPlaybackIndex = (index: number, length: number): number => {
  if (length <= 0) return 0;
  return (clampIndex(index, length) + 1) % length;
};

export type SliderKey =
  'ArrowLeft' | 'ArrowRight' | 'PageUp' | 'PageDown' | 'Home' | 'End' | 'Space';

/**
 * Where a key press moves the cursor.
 *
 * Arrows step one period; PageUp and PageDown step `page` of them, which is a day's
 * worth at hourly resolution and a sensible jump at each of the others. Home and End go
 * to the ends. Returns null for a key the slider does not handle, so the caller knows
 * not to preventDefault.
 */
export const indexForKey = (
  key: string,
  current: number,
  length: number,
  page: number = HOURS_PER_DAY,
): number | null => {
  switch (key) {
    case 'ArrowLeft':
      return clampIndex(current - 1, length);
    case 'ArrowRight':
      return clampIndex(current + 1, length);
    case 'PageDown':
      return clampIndex(current - page, length);
    case 'PageUp':
      return clampIndex(current + page, length);
    case 'Home':
      return 0;
    case 'End':
      return clampIndex(length - 1, length);
    default:
      return null;
  }
};

/** How many periods before the newest an index sits, for a relative label. */
export const hoursBehind = (index: number, length: number): number =>
  Math.max(length - 1 - clampIndex(index, length), 0);
