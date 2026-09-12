/**
 * Actual demand against the day-ahead forecast.
 *
 * The forecast is whichever vintage was issued at least a day before the hour it
 * predicts, which is what makes the comparison meaningful: a revision published once
 * the hour had nearly passed would flatter the forecast enormously.
 *
 * EIA's published horizon has been observed shorter than that, in which case there is
 * no qualifying vintage and the line is empty. That is stated rather than left looking
 * like a rendering fault.
 */
import { useMemo } from 'react';
import type { Options } from 'uplot';
import type { ZoneDetailResponse } from '../api/types.ts';
import { buildDemandData } from '../lib/series.ts';
import { Chart } from './Chart.tsx';

export interface DemandChartProps {
  detail: ZoneDetailResponse;
  unit: string;
}

export const DemandChart = ({ detail, unit }: DemandChartProps): JSX.Element => {
  const { data, hasForecast, horizons } = useMemo(
    () => buildDemandData(detail.series),
    [detail.series],
  );

  const options = useMemo<Omit<Options, 'width' | 'height'>>(
    () => ({
      // null is a gap, never a bridged line: a missing hour must stay missing.
      series: [
        {},
        { label: `Demand (${unit})`, stroke: '#7fcdea', width: 1.5, spanGaps: false },
        {
          label: `Day-ahead forecast (${unit})`,
          stroke: '#f59e0b',
          width: 1.25,
          dash: [4, 3],
          spanGaps: false,
        },
      ],
      axes: [
        { stroke: '#71717a', grid: { stroke: '#27272a' }, ticks: { stroke: '#3f3f46' } },
        { stroke: '#71717a', grid: { stroke: '#27272a' }, ticks: { stroke: '#3f3f46' } },
      ],
      legend: { show: true },
      cursor: { drag: { x: false, y: false } },
    }),
    [unit],
  );

  const horizonNote =
    horizons.length === 0
      ? null
      : `Forecast issued ${Math.min(...horizons)}–${Math.max(...horizons)} hours ahead`;

  return (
    <section data-testid="demand-chart">
      <h3 className="mb-1 text-xs font-medium text-zinc-200">Demand and day-ahead forecast</h3>
      <Chart
        options={options}
        data={data as never}
        height={140}
        ariaLabel="Demand against the day-ahead forecast, hourly"
      />
      {hasForecast ? (
        <p className="mt-1 text-[10px] text-zinc-500">{horizonNote}</p>
      ) : (
        <p className="mt-1 text-[10px] text-amber-300/80" data-testid="no-forecast">
          No forecast issued at least {detail.forecast_horizon_h} hours before these hours. EIA
          publishes a shorter horizon than that at present, so there is nothing to compare against
          yet.
        </p>
      )}
    </section>
  );
};
