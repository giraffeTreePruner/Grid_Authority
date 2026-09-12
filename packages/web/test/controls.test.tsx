/**
 * The slider and metric switcher as the user drives them.
 *
 * The property that matters most: neither issues a network request. A week is loaded
 * once and everything afterwards indexes into it.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricSwitcher } from '../src/components/MetricSwitcher.tsx';
import { PLAYBACK_INTERVAL_MS, TimeSlider } from '../src/components/TimeSlider.tsx';
import { useGridStore } from '../src/store/useGridStore.ts';
import { makeWindow } from './fixtures.ts';

describe('MetricSwitcher', () => {
  beforeEach(() => {
    useGridStore.setState({ metric: 'demand_mw', window: makeWindow(), cursor: 0 });
  });

  it('offers every metric', () => {
    render(<MetricSwitcher />);
    for (const label of ['Demand', 'Generation', 'Interchange', 'Renewable', 'Low carbon']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('marks the active metric for assistive technology, not by colour alone', () => {
    render(<MetricSwitcher />);
    expect(screen.getByRole('button', { name: 'Demand' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Renewable' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('switches metric without fetching', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<MetricSwitcher />);

    fireEvent.click(screen.getByRole('button', { name: 'Renewable' }));

    expect(useGridStore.getState().metric).toBe('renewable_share');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('TimeSlider', () => {
  beforeEach(() => {
    const payload = makeWindow(8);
    useGridStore.setState({ window: payload, cursor: payload.periods.length - 1, playing: false });
  });

  it('renders nothing until a window has loaded', () => {
    useGridStore.setState({ window: null });
    const { container } = render(<TimeSlider />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens on the newest hour', () => {
    render(<TimeSlider />);
    const slider = screen.getByTestId('slider-input') as HTMLInputElement;
    expect(slider.value).toBe('7');
    expect(screen.getByTestId('cursor-label')).toBeInTheDocument();
  });

  it('scrubs without fetching', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<TimeSlider />);

    fireEvent.change(screen.getByTestId('slider-input'), { target: { value: '2' } });

    expect(useGridStore.getState().cursor).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('steps an hour with the arrow keys', () => {
    render(<TimeSlider />);
    const slider = screen.getByTestId('slider-input');

    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(useGridStore.getState().cursor).toBe(6);

    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(useGridStore.getState().cursor).toBe(7);
  });

  it('jumps to the ends with home and end', () => {
    render(<TimeSlider />);
    const slider = screen.getByTestId('slider-input');

    fireEvent.keyDown(slider, { key: 'Home' });
    expect(useGridStore.getState().cursor).toBe(0);

    fireEvent.keyDown(slider, { key: 'End' });
    expect(useGridStore.getState().cursor).toBe(7);
  });

  it('toggles playback with the space bar', () => {
    render(<TimeSlider />);
    fireEvent.keyDown(screen.getByTestId('slider-input'), { key: ' ' });
    expect(useGridStore.getState().playing).toBe(true);
  });

  it('describes the current hour for a screen reader', () => {
    render(<TimeSlider />);
    const slider = screen.getByTestId('slider-input');
    expect(slider).toHaveAttribute('aria-label', 'Hour shown on the map');
    expect(slider.getAttribute('aria-valuetext')).toContain('latest hour');
  });

  it('advances about eight steps a second while playing', () => {
    // requestAnimationFrame is driven by hand rather than by timers: waitFor uses real
    // timers internally, so faking them deadlocks. Driving the frames directly also
    // tests the pacing, which a timer would hide.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    try {
      useGridStore.setState({ cursor: 0, playing: true });
      render(<TimeSlider />);

      expect(frames).toHaveLength(1);

      // A frame sooner than the interval must not advance the cursor.
      frames.pop()!(0);
      expect(useGridStore.getState().cursor).toBe(0);

      // One past the interval advances exactly one hour.
      frames.pop()!(PLAYBACK_INTERVAL_MS + 1);
      expect(useGridStore.getState().cursor).toBe(1);

      frames.pop()!(PLAYBACK_INTERVAL_MS * 2 + 2);
      expect(useGridStore.getState().cursor).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('wraps to the start at the end of the week rather than stopping', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    try {
      useGridStore.setState({ cursor: 7, playing: true });
      render(<TimeSlider />);

      frames.pop()!(0);
      frames.pop()!(PLAYBACK_INTERVAL_MS + 1);
      expect(useGridStore.getState().cursor).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('pauses when the tab is hidden', () => {
    useGridStore.setState({ playing: true });
    render(<TimeSlider />);

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    fireEvent(document, new Event('visibilitychange'));

    expect(useGridStore.getState().playing).toBe(false);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });
});
