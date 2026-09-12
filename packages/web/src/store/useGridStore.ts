/**
 * Client state: what the user is looking at.
 *
 * The window payload lives here too. It is fetched once and then indexed into, which is
 * what makes slider scrubbing and metric switching free — §10 requires zero network
 * requests after the initial load for both.
 */
import { create } from 'zustand';
import type { MetricId } from '../lib/metrics.ts';
import type { WindowResponse } from '../api/types.ts';

export type WindowLength = '24h' | '72h' | '168h';

interface GridState {
  metric: MetricId;
  selectedZone: string | null;
  hoveredZone: string | null;
  /** Index into `window.periods`. The slider's position. */
  cursor: number;
  playing: boolean;
  window: WindowResponse | null;
  detailWindow: WindowLength;

  setMetric: (metric: MetricId) => void;
  selectZone: (key: string | null) => void;
  hoverZone: (key: string | null) => void;
  setCursor: (index: number) => void;
  stepCursor: (delta: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  setWindow: (payload: WindowResponse) => void;
  setDetailWindow: (window: WindowLength) => void;
}

const clampCursor = (index: number, length: number): number => {
  if (length === 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
};

export const useGridStore = create<GridState>((set) => ({
  metric: 'demand_mw',
  selectedZone: null,
  hoveredZone: null,
  cursor: 0,
  playing: false,
  window: null,
  detailWindow: '168h',

  setMetric: (metric) => set({ metric }),
  selectZone: (selectedZone) => set({ selectedZone }),
  hoverZone: (hoveredZone) => set({ hoveredZone }),

  setCursor: (index) =>
    set((state) => ({ cursor: clampCursor(index, state.window?.periods.length ?? 0) })),

  stepCursor: (delta) =>
    set((state) => ({
      cursor: clampCursor(state.cursor + delta, state.window?.periods.length ?? 0),
    })),

  setPlaying: (playing) => set({ playing }),
  togglePlaying: () => set((state) => ({ playing: !state.playing })),

  // Landing on the newest hour is the useful default: the map should open on now.
  // Open on the newest hour that actually has data, not simply the newest hour.
  // Sources run hours behind, so the last period in the window is routinely empty
  // and opening there shows an entirely grey map for no reason.
  setWindow: (payload) => set({ window: payload, cursor: newestHourWithData(payload) }),

  setDetailWindow: (detailWindow) => set({ detailWindow }),
}));

/**
 * The index of the newest hour any zone reported anything for.
 *
 * Falls back to the last hour when the whole window is empty, so the slider still has a
 * sensible position and the map says "no data" rather than behaving oddly.
 */
export const newestHourWithData = (payload: WindowResponse): number => {
  const series = Object.values(payload.zones);
  for (let hour = payload.periods.length - 1; hour >= 0; hour -= 1) {
    for (const zone of series) {
      if (zone[hour]?.some((value) => value !== null) === true) return hour;
    }
  }
  return Math.max(payload.periods.length - 1, 0);
};

/** The values for one metric across every zone at the cursor's hour. */
export const valuesAtCursor = (
  payload: WindowResponse | null,
  cursor: number,
  metricPosition: number,
): Map<string, number | null> => {
  const values = new Map<string, number | null>();
  if (payload === null) return values;

  for (const [key, series] of Object.entries(payload.zones)) {
    const atHour = series[cursor];
    values.set(key, atHour?.[metricPosition] ?? null);
  }
  return values;
};
