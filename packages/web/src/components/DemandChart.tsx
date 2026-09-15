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
import { buildDemandData, indexForPeriod } from '../lib/series.ts';
import { formatHour } from '../lib/format.ts';
import { useGridStore } from '../store/useGridStore.ts';
import { Chart } from './Chart.tsx';

const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

export interface DemandChartProps {
  detail: ZoneDetailResponse;
  unit: string;
}

export const DemandChart = ({ detail, unit }: DemandChartProps): JSX.Element => {
  // The hour the map's slider is on, so the panel answers the same question the map is
  // showing. Falls back to the newest hour that reported, never simply the last one:
  // sources lag, so the final hour of a window is routinely empty.
  const mapWindow = useGridStore((state) => state.window);
  const mapCursor = useGridStore((state) => state.cursor);
  const setMapCursor = useGridStore((state) => state.setCursor);
  const newestWithDemand = useMemo(() => {
    for (let index = detail.series.demand_mw.length - 1; index >= 0; index -= 1) {
      if (detail.series.demand_mw[index] !== null) return index;
    }
    return Math.max(detail.series.demand_mw.length - 1, 0);
  }, [detail.series.demand_mw]);

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
        {
          stroke: '#71717a',
          grid: { stroke: '#27272a' },
          ticks: { stroke: '#3f3f46' },
          // Power values reach six figures with separators. uPlot's default gutter
          // clips them, which turns 150,000 into ",0,000".
          size: 62,
        },
      ],
      // uPlot's own legend reads "--" until something hovers, which on a touch screen
      // is for ever. The readout below is rendered from the slider instead.
      legend: { show: false },
      cursor: { drag: { x: false, y: false } },
    }),
    [unit],
  );

  const horizonNote =
    horizons.length === 0
      ? null
      : `Forecast issued ${Math.min(...horizons)}–${Math.max(...horizons)} hours ahead`;

  const at = indexForPeriod(detail.series.period, mapWindow?.periods[mapCursor] ?? null);
  const shown = at ?? newestWithDemand;
  const period = detail.series.period[shown];
  const demand = detail.series.demand_mw[shown] ?? null;
  const forecast = detail.series.demand_forecast_mw[shown] ?? null;

  // Touching the chart moves the map's hour, which moves this readout with it: the
  // panel and the map are answering the same question and should not disagree.
  const scrubTo = (index: number): void => {
    const period = detail.series.period[index];
    const at = period === undefined ? null : indexForPeriod(mapWindow?.periods ?? [], period);
    if (at !== null) setMapCursor(at);
  };

  return (
    <section data-testid="demand-chart">
      <h3 className="mb-1 text-xs font-medium text-zinc-200">Demand and day-ahead forecast</h3>
      <Chart
        options={options}
        data={data as never}
        height={140}
        ariaLabel="Demand against the day-ahead forecast, hourly"
        onScrub={scrubTo}
      />
      <dl
        className="mt-1 flex flex-wrap items-baseline gap-x-4 text-[11px]"
        data-testid="demand-readout"
      >
        <div className="flex items-baseline gap-1.5">
          <dt className="text-zinc-500">{period === undefined ? '—' : formatHour(period)}</dt>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-zinc-500">Demand</dt>
          <dd className="tabular-nums text-zinc-100">
            {demand === null ? '—' : NUMBER.format(demand)}
          </dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-zinc-500">Forecast</dt>
          <dd className="tabular-nums text-zinc-100">
            {forecast === null ? '—' : NUMBER.format(forecast)}
          </dd>
        </div>
      </dl>

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
