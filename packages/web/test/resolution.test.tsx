/**
 * Reading the map at day, week and month resolution.
 *
 * Two properties carry the feature. A step must say what it covers, because a slider
 * whose unit is inferred from context cannot be described in words or in a screenshot.
 * And a summary must say how it was summarised, because a map coloured by its peak hour
 * looks exactly like one coloured by its average.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResolutionSwitcher } from '../src/components/ResolutionSwitcher.tsx';
import { TimeSlider } from '../src/components/TimeSlider.tsx';
import {
  EARLIEST_PERIOD,
  RESOLUTIONS_BY_ID,
  formatPeriod,
  formatPeriodsBehind,
  rangeFor,
} from '../src/lib/resolution.ts';
import { indexForKey } from '../src/lib/slider.ts';
import { useGridStore } from '../src/store/useGridStore.ts';
import { makeWindow } from './fixtures.ts';

const NOW = new Date('2026-09-12T13:30:00Z');

afterEach(cleanup);

describe('ranges', () => {
  it('ends at the last complete hour, never the current one', () => {
    // The current hour is still being written; opening on it shows an empty map.
    expect(rangeFor('hour', NOW).to).toBe('2026-09-12T12:00:00Z');
  });

  it('reaches back a week by the hour and two years by the day', () => {
    expect(rangeFor('hour', NOW).from).toBe('2026-09-05T13:00:00Z');
    expect(rangeFor('day', NOW).from.slice(0, 4)).toBe('2024');
  });

  it('never asks for data from before the dataset exists', () => {
    // Ten years of months from 2026 would otherwise reach back to 2016, and EIA-930
    // begins in 2019: six years of requests for nothing.
    const from = new Date(rangeFor('month', NOW).from).getTime();
    expect(from).toBeGreaterThanOrEqual(EARLIEST_PERIOD);
  });
});

describe('labels', () => {
  it('labels a month as a month, not as the midnight that starts it', () => {
    // '1 Sep 2026, 00:00' would invite reading a month's average as one hour.
    expect(formatPeriod('2026-09-01T00:00:00Z', 'month')).toBe('September 2026');
    expect(formatPeriod('2026-09-07T00:00:00Z', 'week')).toBe('Week of 7 Sep 2026');
    expect(formatPeriod('2026-09-09T00:00:00Z', 'day')).toBe('Wed 9 Sep 2026');
  });

  it('labels a coarse period in UTC, whatever clock the viewer is on', () => {
    // A day, week or month is a UTC calendar period, not an instant. Formatted
    // locally, the midnight that starts September 2026 is 31 August for every viewer
    // west of Greenwich, and the month gets the wrong name entirely.
    const previous = process.env.TZ;
    for (const zone of ['America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
      process.env.TZ = zone;
      expect(formatPeriod('2026-09-01T00:00:00Z', 'month')).toBe('September 2026');
      expect(formatPeriod('2026-09-09T00:00:00Z', 'day')).toBe('Wed 9 Sep 2026');
    }
    process.env.TZ = previous;
  });

  it('counts backwards in the resolution its own units', () => {
    expect(formatPeriodsBehind(0, 'month')).toBe('latest month');
    expect(formatPeriodsBehind(1, 'day')).toBe('1 day earlier');
    expect(formatPeriodsBehind(3, 'week')).toBe('3 weeks earlier');
  });
});

describe('ResolutionSwitcher', () => {
  beforeEach(() => {
    useGridStore.setState({
      resolution: 'hour',
      statistic: 'mean',
      window: makeWindow(),
      cursor: 0,
      playing: false,
    });
  });

  it('offers every resolution and marks the active one for assistive technology', () => {
    render(<ResolutionSwitcher />);
    for (const label of ['Hourly', 'Daily', 'Weekly', 'Monthly']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Hourly' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers no statistic at hourly resolution', () => {
    // An hour is a measurement. There is nothing to average.
    render(<ResolutionSwitcher />);
    expect(screen.queryByTestId('statistic-switcher')).not.toBeInTheDocument();
  });

  it('offers average and peak above hourly', () => {
    useGridStore.setState({ resolution: 'month' });
    render(<ResolutionSwitcher />);
    expect(screen.getByRole('button', { name: 'Average' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Peak' })).toBeInTheDocument();
  });

  it('drops the loaded window when the resolution changes', () => {
    // The window belongs to the old resolution. Keeping it would leave months of data
    // on an hourly slider until the fetch returned, with the cursor on the wrong period.
    render(<ResolutionSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));

    const state = useGridStore.getState();
    expect(state.resolution).toBe('month');
    expect(state.window).toBeNull();
    expect(state.cursor).toBe(0);
  });

  it('stops playback when the resolution changes', () => {
    useGridStore.setState({ playing: true });
    render(<ResolutionSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    expect(useGridStore.getState().playing).toBe(false);
  });

  it('keeps the window when the same resolution is chosen again', () => {
    render(<ResolutionSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Hourly' }));
    expect(useGridStore.getState().window).not.toBeNull();
  });
});

describe('TimeSlider at a coarse resolution', () => {
  beforeEach(() => {
    useGridStore.setState({
      resolution: 'month',
      statistic: 'peak',
      window: makeWindow(4, 'month', 'peak'),
      cursor: 0,
      playing: false,
    });
  });

  it('says how the period was summarised', () => {
    render(<TimeSlider />);
    expect(screen.getByTestId('statistic-note')).toHaveTextContent('highest hour in the month');
  });

  it('names the unit in the control label, not just in the data', () => {
    render(<TimeSlider />);
    expect(screen.getByTestId('slider-input')).toHaveAttribute(
      'aria-label',
      'Month shown on the map',
    );
  });

  it('says nothing about a statistic at hourly resolution', () => {
    useGridStore.setState({ resolution: 'hour', window: makeWindow() });
    render(<TimeSlider />);
    expect(screen.queryByTestId('statistic-note')).not.toBeInTheDocument();
  });
});

describe('paging', () => {
  it('steps a resolution-appropriate jump, not always twenty-four', () => {
    // PageUp at monthly resolution is a year, not a day of months.
    expect(indexForKey('PageUp', 0, 200, RESOLUTIONS_BY_ID.month.page)).toBe(12);
    expect(indexForKey('PageUp', 0, 200, RESOLUTIONS_BY_ID.hour.page)).toBe(24);
    expect(indexForKey('PageUp', 0, 200, RESOLUTIONS_BY_ID.day.page)).toBe(7);
  });
});
