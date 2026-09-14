/**
 * The zone detail panel.
 *
 * The acceptance criterion for task 20: selecting a zone renders both charts with the
 * units the data was actually recorded in.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZoneDetailResponse } from '../src/api/types.ts';
import { ZonePanel } from '../src/components/ZonePanel.tsx';
import { MIX_ORDER } from '../src/lib/series.ts';
import { useGridStore } from '../src/store/useGridStore.ts';

// uPlot needs a canvas, which jsdom does not provide. The series builders are tested
// directly in series.test.ts; here the chart is reduced to a marker so the panel's own
// behaviour is what is under test.
vi.mock('../src/components/Chart.tsx', () => ({
  Chart: ({ ariaLabel }: { ariaLabel: string }) => (
    <div data-testid="chart" aria-label={ariaLabel} />
  ),
}));

const hours = ['2026-09-11T10:00:00Z', '2026-09-11T11:00:00Z', '2026-09-11T12:00:00Z'];

const detail = (overrides: Partial<ZoneDetailResponse> = {}): ZoneDetailResponse => {
  const mix: Record<string, (number | null)[]> = Object.fromEntries(
    MIX_ORDER.map((mode) => [mode, [null, null, null]]),
  );
  mix.wind = [400, 420, 450];
  mix.gas = [600, 580, 550];

  return {
    zone: {
      key: 'US-TEX-ERCO',
      name: 'Electric Reliability Council of Texas, Inc.',
      short_name: 'ERCOT',
      interconnection: 'texas',
      type: 'balancing_authority',
      in_map: true,
      capabilities: {
        demand: true,
        demand_forecast: true,
        net_generation: true,
        fuel_mix: true,
        interchange: true,
      },
    },
    series: {
      period: hours,
      demand_mw: [58000, null, 58500],
      demand_forecast_mw: [57800, null, null],
      demand_forecast_horizon_h: [24, null, null],
      net_generation_mw: [57500, null, 58000],
      net_interchange_mw: [-250, null, -260],
      mix,
      renewable_share: [0.41, null, 0.42],
      low_carbon_share: [0.52, null, 0.53],
    },
    sources: ['eia'],
    latest_period: hours.at(-1) ?? null,
    forecast_horizon_h: 24,
    meta: {
      generated_at: '2026-09-11T13:00:00Z',
      sources: ['eia'],
      data_latest_period: hours.at(-1) ?? null,
      stale: false,
    },
    ...overrides,
  };
};

const wrapper = ({ children }: { children: ReactNode }): JSX.Element => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const respondWith = (body: unknown, status = 200): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
};

describe('ZonePanel', () => {
  beforeEach(() => {
    useGridStore.setState({ selectedZone: null, detailWindow: '168h' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders nothing until a zone is selected', () => {
    const { container } = render(<ZonePanel />, { wrapper });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders both charts with the recorded unit', async () => {
    respondWith(detail());
    useGridStore.setState({ selectedZone: 'US-TEX-ERCO' });
    render(<ZonePanel />, { wrapper });

    await waitFor(() => expect(screen.getByTestId('demand-chart')).toBeInTheDocument());
    expect(screen.getByTestId('mix-chart')).toBeInTheDocument();

    // EIA reports every series in megawatthours, demand included, whatever the column
    // name says. The unit shown must be the one the data was recorded in.
    expect(screen.getByTestId('source-badge')).toHaveTextContent('MWh');
    expect(screen.getByTestId('mix-chart')).toHaveTextContent('MWh');
  });

  it('shows the source and the age of the data', async () => {
    respondWith(detail());
    useGridStore.setState({ selectedZone: 'US-TEX-ERCO' });
    render(<ZonePanel />, { wrapper });

    await waitFor(() => expect(screen.getByTestId('source-badge')).toBeInTheDocument());
    expect(screen.getByTestId('source-badge')).toHaveTextContent('EIA Form 930');
    expect(screen.getByTestId('source-badge')).toHaveTextContent('ago');
  });

  it('lists only the modes the zone reported', async () => {
    respondWith(detail());
    useGridStore.setState({ selectedZone: 'US-TEX-ERCO' });
    render(<ZonePanel />, { wrapper });

    await waitFor(() => expect(screen.getByTestId('mix-legend')).toBeInTheDocument());
    const legend = screen.getByTestId('mix-legend');
    expect(legend).toHaveTextContent('Wind');
    expect(legend).toHaveTextContent('Gas');
    expect(legend).not.toHaveTextContent('Coal');
  });

  it('counts the hours with no demand rather than hiding them', async () => {
    respondWith(detail());
    useGridStore.setState({ selectedZone: 'US-TEX-ERCO' });
    render(<ZonePanel />, { wrapper });

    await waitFor(() => expect(screen.getByText('Hours with no demand')).toBeInTheDocument());
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
  });

  it('explains an empty forecast instead of rendering a blank chart', async () => {
    const body = detail();
    body.series.demand_forecast_mw = [null, null, null];
    body.series.demand_forecast_horizon_h = [null, null, null];
    respondWith(body);

    useGridStore.setState({ selectedZone: 'US-TEX-ERCO' });
    render(<ZonePanel />, { wrapper });

    await waitFor(() => expect(screen.getByTestId('no-forecast')).toBeInTheDocument());
    expect(screen.getByTestId('no-forecast')).toHaveTextContent('24 hours');
  });

  it('says so when a zone has never published', async () => {
    respondWith(detail({ latest_period: null }));
    useGridStore.setState({ selectedZone: 'US-NW-BPAT' });
    render(<ZonePanel />, { wrapper });

    await waitFor(() => expect(screen.getByTestId('panel-empty')).toBeInTheDocument());
  });

  it('reports an API failure in the panel rather than silently showing nothing', async () => {
    respondWith({ error: { code: 'not_found', message: 'No zone with key "US-NOPE"' } }, 404);
    useGridStore.setState({ selectedZone: 'US-NOPE' });
    render(<ZonePanel />, { wrapper });

    await waitFor(() => expect(screen.getByTestId('panel-error')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('No zone with key');
  });

  it('closes on request', async () => {
    respondWith(detail());
    useGridStore.setState({ selectedZone: 'US-TEX-ERCO' });
    render(<ZonePanel />, { wrapper });

    await waitFor(() => expect(screen.getByTestId('zone-panel')).toBeInTheDocument());
    screen.getByRole('button', { name: 'Close zone detail' }).click();

    await waitFor(() => expect(useGridStore.getState().selectedZone).toBeNull());
  });
});

describe('ZonePanel over long windows', () => {
  beforeEach(() => {
    respondWith(detail());
    useGridStore.setState({ selectedZone: 'US-TEX-ERCO', detailWindow: '168h' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers the windows the map can reach', async () => {
    // The map spans 2019 to now; a panel capped at a week makes the two halves of the
    // same page disagree about what is being looked at.
    render(<ZonePanel />, { wrapper });
    for (const window of ['24h', '168h', '30d', '1y', 'all']) {
      expect(await screen.findByRole('button', { name: window })).toBeInTheDocument();
    }
  });

  it('says nothing about buckets while the window is hourly', async () => {
    render(<ZonePanel />, { wrapper });
    await screen.findByRole('button', { name: '24h' });
    expect(screen.queryByTestId('panel-bucket-note')).not.toBeInTheDocument();
  });

  it('says what one point covers once the window is bucketed', async () => {
    // A chart that looks hourly and is not invites every conclusion an hourly chart
    // would support.
    useGridStore.setState({ detailWindow: 'all' });
    render(<ZonePanel />, { wrapper });
    expect(await screen.findByTestId('panel-bucket-note')).toHaveTextContent(
      'Each point is one month',
    );
  });
});
