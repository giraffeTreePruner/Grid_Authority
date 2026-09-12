/**
 * The stacked generation mix.
 *
 * Only modes the zone actually reported are drawn: a zone with no coal gets no coal
 * band rather than a flat zero one that suggests a measurement of nothing.
 */
import { useMemo } from 'react';
import type { Options } from 'uplot';
import type { ZoneDetailResponse } from '../api/types.ts';
import { buildMixData } from '../lib/series.ts';
import { Chart } from './Chart.tsx';

export interface MixChartProps {
  detail: ZoneDetailResponse;
  unit: string;
}

export const MixChart = ({ detail, unit }: MixChartProps): JSX.Element => {
  const { data, colours, labels } = useMemo(() => buildMixData(detail.series), [detail.series]);

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
        ariaLabel="Generation by energy source, stacked, hourly"
      />
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1" data-testid="mix-legend">
        {labels.map((label, index) => (
          <li key={label} className="flex items-center gap-1 text-[10px] text-zinc-400">
            <span
              className="h-2 w-2 rounded-sm"
              style={{ backgroundColor: colours[index] }}
              aria-hidden="true"
            />
            {label}
          </li>
        ))}
      </ul>
    </section>
  );
};
