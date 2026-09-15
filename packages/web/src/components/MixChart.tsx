/**
 * The stacked generation mix.
 *
 * Only modes the zone actually reported are drawn: a zone with no coal gets no coal
 * band rather than a flat zero one that suggests a measurement of nothing.
 *
 * The legend below is live. A stacked area with eight bands and a swatch key tells a
 * reader which colours exist, not what any of them is worth at the moment they are
 * pointing at — so pointing at the chart names each source and gives its own value,
 * unstacked. Without a cursor it reads the latest period, so the panel says something
 * useful before it is touched at all.
 */
import { useMemo, useState } from 'react';
import type { Options } from 'uplot';
import type { ZoneDetailResponse } from '../api/types.ts';
import { buildMixData, indexForPeriod } from '../lib/series.ts';
import { useGridStore } from '../store/useGridStore.ts';
import { formatPeriod, type Resolution } from '../lib/resolution.ts';
import { Chart } from './Chart.tsx';

export interface MixChartProps {
  detail: ZoneDetailResponse;
  unit: string;
  /**
   * What one point covers, so the readout can label it correctly.
   *
   * Passed rather than guessed from the timestamps: an hourly window contains
   * midnights too, so "ends at 00:00" does not distinguish an hour from a day.
   */
  resolution: Resolution;
}

const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

export const MixChart = ({ detail, unit, resolution }: MixChartProps): JSX.Element => {
  const { data, colours, labels, raw } = useMemo(
    () => buildMixData(detail.series),
    [detail.series],
  );

  // null means "not pointing at anything", which reads the newest period with data.
  const [hovered, setHovered] = useState<number | null>(null);

  /**
   * The period the readout falls back to.
   *
   * The newest period that reported anything, not simply the last one. Sources run
   * hours behind, so the final period of a window is routinely empty and defaulting to
   * it opens the panel showing a dash for every source — the same fault the map had
   * when it opened on the newest hour rather than the newest hour with data.
   */
  // The hour the map's slider is on, so scrubbing the map moves these numbers too.
  // Without it there is no readout at all on a touch screen, which has no hover.
  const mapWindow = useGridStore((state) => state.window);
  const mapCursor = useGridStore((state) => state.cursor);
  const setMapCursor = useGridStore((state) => state.setCursor);

  /**
   * Scrubbing the chart moves the map with it, where the two share a period.
   *
   * A panel bucketed by day cannot address an hourly map exactly, so the map is only
   * moved when the touched period exists in its window; the readout follows either way.
   */
  const scrubTo = (index: number): void => {
    setHovered(index);
    const period = detail.series.period[index];
    const at = period === undefined ? null : indexForPeriod(mapWindow?.periods ?? [], period);
    if (at !== null) setMapCursor(at);
  };
  const followed = useMemo(
    () => indexForPeriod(detail.series.period, mapWindow?.periods[mapCursor] ?? null),
    [detail.series.period, mapWindow, mapCursor],
  );

  const newest = useMemo(() => {
    for (let index = (raw[0]?.length ?? 0) - 1; index >= 0; index -= 1) {
      if (raw.some((values) => values[index] !== null && values[index] !== undefined)) {
        return index;
      }
    }
    return Math.max((raw[0]?.length ?? 0) - 1, 0);
  }, [raw]);

  const options = useMemo<Omit<Options, 'width' | 'height'>>(
    () => ({
      series: [
        {},
        // Drawn back to front: each band is a cumulative total, so later bands are
        // filled beneath earlier ones to give the stacked appearance.
        ...labels.map((label, index) => ({
          label,
          stroke: colours[index],
          fill: `${colours[index]}cc`,
          width: 0.75,
          spanGaps: false,
        })),
      ],
      axes: [
        { stroke: '#71717a', grid: { stroke: '#27272a' }, ticks: { stroke: '#3f3f46' } },
        {
          stroke: '#71717a',
          grid: { stroke: '#27272a' },
          ticks: { stroke: '#3f3f46' },
          // Power values reach six figures with separators. uPlot's default gutter
          // clips them, which turns 150,000 into ",0,000".
          size: 62,
        },
      ],
      legend: { show: false },
      cursor: { drag: { x: false, y: false } },
      // uPlot owns its DOM, so the readout is rendered by React from this index rather
      // than by styling uPlot's own legend into something that matches the panel.
      hooks: {
        setCursor: [
          (plot: { cursor: { idx?: number | null } }) => {
            setHovered(plot.cursor.idx ?? null);
          },
        ],
      },
    }),
    [colours, labels],
  );

  if (labels.length === 0) {
    return (
      <section data-testid="mix-chart">
        <h3 className="mb-1 text-xs font-medium text-zinc-200">Generation mix</h3>
        <p className="text-[11px] text-zinc-500" data-testid="no-mix">
          This zone published no generation mix for this window.
        </p>
      </section>
    );
  }

  return (
    <section data-testid="mix-chart">
      <h3 className="mb-1 text-xs font-medium text-zinc-200">
        Generation mix <span className="font-normal text-zinc-500">({unit})</span>
      </h3>
      <Chart
        options={options}
        data={data as never}
        height={150}
        ariaLabel="Generation by energy source, stacked"
        onScrub={scrubTo}
        onScrubEnd={() => setHovered(null)}
      />
      <p className="mt-2 text-[10px] text-zinc-500" data-testid="mix-readout-period">
        {(() => {
          const at = hovered ?? followed ?? newest;
          const period = detail.series.period[at];
          return period === undefined ? 'No data' : formatPeriod(period, resolution);
        })()}
      </p>

      <ul
        className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 sm:grid-cols-3"
        data-testid="mix-legend"
      >
        {labels.map((label, index) => {
          const values = raw[index] ?? [];
          const at = hovered ?? followed ?? newest;
          const value = values[at] ?? null;
          return (
            <li
              key={label}
              className="flex items-center gap-1.5 text-[11px] text-zinc-400"
              data-testid="mix-legend-item"
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: colours[index] }}
                aria-hidden="true"
              />
              <span className="truncate">{label}</span>
              <span className="ml-auto shrink-0 tabular-nums text-zinc-200">
                {value === null ? '—' : NUMBER.format(value)}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-[10px] text-zinc-600">
        Values in {unit}. A dash means the source published nothing for that period.
      </p>
    </section>
  );
};
