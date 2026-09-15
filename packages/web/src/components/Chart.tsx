/**
 * A thin uPlot wrapper.
 *
 * uPlot owns its DOM, so React only supplies a container and hands over data. The chart
 * is rebuilt when its series change shape and updated in place otherwise, which keeps
 * scrubbing cheap.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import uPlot, { type Options } from 'uplot';
import 'uplot/dist/uPlot.min.css';

/**
 * Pointer capture, which must never be load-bearing.
 *
 * It keeps events coming when a finger slides off a small control, which is worth
 * having — but it throws if the pointer is already gone, and an exception here would
 * take the whole gesture with it. So it is attempted, and the scrub proceeds either
 * way.
 */
const capturePointer = (element: Element, pointerId: number): void => {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // No active pointer: the gesture still works, it just stops tracking off-element.
  }
};

export interface ChartProps {
  options: Omit<Options, 'width' | 'height'>;
  data: uPlot.AlignedData;
  height: number;
  ariaLabel: string;
  /**
   * Called with the index under the finger while the chart is being touched.
   *
   * uPlot's cursor follows a mouse. A touch screen has no mouse and no hover, so
   * without this a reader on a phone can see the shape of a chart and never a number
   * from it. Pressing anywhere on the plot and dragging reads along it.
   */
  onScrub?: (index: number) => void;
  /** Called when the finger lifts, so a caller can return to its own default. */
  onScrubEnd?: () => void;
}

export const Chart = ({
  options,
  data,
  height,
  ariaLabel,
  onScrub,
  onScrubEnd,
}: ChartProps): JSX.Element => {
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

  const [scrubbing, setScrubbing] = useState(false);
  // Where a touch began, and whether it has committed to being a scrub. A touch that
  // has not moved sideways yet might still turn out to be a scroll.
  const origin = useRef<{ x: number; y: number } | null>(null);

  /** How far sideways a finger must travel before this is a scrub and not a scroll. */
  const SCRUB_THRESHOLD_PX = 6;

  /**
   * The data index under a client x position.
   *
   * Measured against uPlot's own plotting area rather than the container, because the
   * axis gutter is part of the container and would shift every reading by its width.
   */
  const indexAt = useCallback((clientX: number, clientY?: number): number | null => {
    const instance = plot.current;
    if (instance === null) return null;
    const rect = instance.over.getBoundingClientRect();
    if (rect.width === 0) return null;
    const offset = Math.min(Math.max(clientX - rect.left, 0), rect.width);

    // Drive uPlot's own cursor as well as our state, so the crosshair follows the
    // finger. Setting React state alone moves the numbers and leaves the lines behind.
    const top =
      clientY === undefined
        ? rect.height / 2
        : Math.min(Math.max(clientY - rect.top, 0), rect.height);
    instance.setCursor({ left: offset, top });

    return instance.posToIdx(offset);
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (onScrub === undefined) return;
      origin.current = { x: event.clientX, y: event.clientY };

      // A mouse has nothing to scroll with, so it scrubs from the press. A finger has
      // to earn it: the same chart is in a scrolling panel, and jumping on contact
      // would mean a reader trying to scroll past the chart moves the cursor instead.
      if (event.pointerType === 'mouse') {
        const index = indexAt(event.clientX, event.clientY);
        if (index === null) return;
        setScrubbing(true);
        onScrub(index);
        capturePointer(event.currentTarget, event.pointerId);
      }
    },
    [indexAt, onScrub],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (onScrub === undefined) return;

      if (!scrubbing) {
        const start = origin.current;
        if (start === null) return;
        const dx = Math.abs(event.clientX - start.x);
        const dy = Math.abs(event.clientY - start.y);
        // Sideways, and more sideways than up: anything else belongs to the scroller,
        // which `touch-action: pan-y` has already let it keep.
        if (dx < SCRUB_THRESHOLD_PX || dx <= dy) return;
        setScrubbing(true);
        capturePointer(event.currentTarget, event.pointerId);
      }

      const index = indexAt(event.clientX, event.clientY);
      if (index !== null) onScrub(index);
    },
    [indexAt, onScrub, scrubbing],
  );

  const endScrub = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      origin.current = null;
      if (!scrubbing) return;
      setScrubbing(false);
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch {
        // Already released; nothing to undo.
      }
      onScrubEnd?.();
    },
    [onScrubEnd, scrubbing],
  );

  return (
    <div
      ref={container}
      role="img"
      aria-label={ariaLabel}
      data-testid="chart"
      // pan-y, not none. `none` claimed every gesture on the chart, so a reader could
      // not scroll the panel past it to reach what was below. This leaves vertical
      // panning to the browser and takes only the horizontal drag.
      style={onScrub === undefined ? undefined : { touchAction: 'pan-y' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endScrub}
      onPointerCancel={endScrub}
    />
  );
};
