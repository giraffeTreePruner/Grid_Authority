/**
 * A thin uPlot wrapper.
 *
 * uPlot owns its DOM, so React only supplies a container and hands over data. The chart
 * is rebuilt when its series change shape and updated in place otherwise, which keeps
 * scrubbing cheap.
 */
import { useEffect, useRef } from 'react';
import uPlot, { type Options } from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface ChartProps {
  options: Omit<Options, 'width' | 'height'>;
  data: uPlot.AlignedData;
  height: number;
  ariaLabel: string;
}

export const Chart = ({ options, data, height, ariaLabel }: ChartProps): JSX.Element => {
  const container = useRef<HTMLDivElement | null>(null);
  const plot = useRef<uPlot | null>(null);
  const seriesCount = useRef(0);

  useEffect(() => {
    const node = container.current;
    if (node === null) return;

    const width = node.clientWidth || 320;
    const shapeChanged = seriesCount.current !== data.length;

    if (plot.current !== null && !shapeChanged) {
      plot.current.setData(data);
      return;
    }

    plot.current?.destroy();
    plot.current = new uPlot({ ...options, width, height } as Options, data, node);
    seriesCount.current = data.length;
  }, [options, data, height]);

  // Redraw on resize so the panel can be narrow without clipping the axes.
  useEffect(() => {
    const node = container.current;
    if (node === null || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (plot.current !== null && node.clientWidth > 0) {
        plot.current.setSize({ width: node.clientWidth, height });
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [height]);

  useEffect(
    () => () => {
      plot.current?.destroy();
      plot.current = null;
    },
    [],
  );

  return <div ref={container} role="img" aria-label={ariaLabel} data-testid="chart" />;
};
