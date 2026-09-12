/**
 * Slider index arithmetic.
 *
 * The failure modes here are quiet: stepping past the end, a day jump that lands
 * somewhere arbitrary, playback that stops without saying so.
 */
import { describe, expect, it } from 'vitest';
import {
  clampIndex,
  hoursBehind,
  HOURS_PER_DAY,
  indexForKey,
  nextPlaybackIndex,
} from '../src/lib/slider.ts';

const WEEK = 168;

describe('clamping', () => {
  it('keeps an index inside the array', () => {
    expect(clampIndex(-5, WEEK)).toBe(0);
    expect(clampIndex(999, WEEK)).toBe(WEEK - 1);
    expect(clampIndex(42, WEEK)).toBe(42);
  });

  it('survives an empty window', () => {
    expect(clampIndex(3, 0)).toBe(0);
  });

  it('rejects a non-finite index rather than propagating NaN into the map', () => {
    expect(clampIndex(Number.NaN, WEEK)).toBe(0);
    expect(clampIndex(Number.POSITIVE_INFINITY, WEEK)).toBe(0);
  });
});

describe('keyboard', () => {
  it('steps an hour with the arrows', () => {
    expect(indexForKey('ArrowRight', 10, WEEK)).toBe(11);
    expect(indexForKey('ArrowLeft', 10, WEEK)).toBe(9);
  });

  it('steps a day with page up and down', () => {
    expect(indexForKey('PageUp', 100, WEEK)).toBe(100 + HOURS_PER_DAY);
    expect(indexForKey('PageDown', 100, WEEK)).toBe(100 - HOURS_PER_DAY);
  });

  it('jumps to the ends with home and end', () => {
    expect(indexForKey('Home', 100, WEEK)).toBe(0);
    expect(indexForKey('End', 100, WEEK)).toBe(WEEK - 1);
  });

  it('does not step past either end', () => {
    expect(indexForKey('ArrowLeft', 0, WEEK)).toBe(0);
    expect(indexForKey('ArrowRight', WEEK - 1, WEEK)).toBe(WEEK - 1);
    expect(indexForKey('PageDown', 3, WEEK)).toBe(0);
    expect(indexForKey('PageUp', WEEK - 3, WEEK)).toBe(WEEK - 1);
  });

  it('returns null for a key it does not handle, so the event is left alone', () => {
    expect(indexForKey('Tab', 10, WEEK)).toBeNull();
    expect(indexForKey('a', 10, WEEK)).toBeNull();
  });
});

describe('playback', () => {
  it('advances one hour at a time', () => {
    expect(nextPlaybackIndex(0, WEEK)).toBe(1);
    expect(nextPlaybackIndex(50, WEEK)).toBe(51);
  });

  it('wraps at the end rather than stopping silently', () => {
    expect(nextPlaybackIndex(WEEK - 1, WEEK)).toBe(0);
  });

  it('survives an empty window', () => {
    expect(nextPlaybackIndex(0, 0)).toBe(0);
  });
});

describe('relative position', () => {
  it('reports how far behind the newest hour the cursor sits', () => {
    expect(hoursBehind(WEEK - 1, WEEK)).toBe(0);
    expect(hoursBehind(WEEK - 2, WEEK)).toBe(1);
    expect(hoursBehind(0, WEEK)).toBe(WEEK - 1);
  });
});
