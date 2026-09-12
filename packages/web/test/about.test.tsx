/**
 * The About Data page and the status states.
 *
 * The label requirement is the substance here: any series computed with the Electricity
 * Maps methodology must carry its label verbatim wherever it appears, and this page is
 * where the wording is published.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourcesResponse } from '../src/api/types.ts';
import { StatusBar } from '../src/components/StatusBar.tsx';
import { routeFor } from '../src/lib/route.ts';
import { AboutData } from '../src/pages/AboutData.tsx';

const EMAPS_LABEL = 'Electricity Maps methodology (our implementation)';

const sources = (): SourcesResponse => ({
  sources: [
    {
      id: 'eia',
      label: 'EIA Form 930',
      attribution: 'U.S. Energy Information Administration, Hourly Electric Grid Monitor',
      url: 'https://www.eia.gov/electricity/gridmonitor/',
      license: 'Public domain (U.S. Government work)',
      independent: true,
      notes: 'Hourly. Provisional and revised for several days after publication.',
      active: true,
      jobs: [
        {
          job: 'poll',
          last_success_at: '2026-09-11T12:00:00Z',
          last_failure_at: null,
          data_latest_period: '2026-09-11T11:00:00Z',
        },
      ],
      observed_latency: [
        {
          dataset: 'interchange-data',
          lag_minutes: 2520,
          latest_period: '2026-09-10T07:00:00Z',
          measured_at: '2026-09-12T01:00:00Z',
          readings: 12,
        },
      ],
    },
    {
      id: 'emaps_method',
      label: EMAPS_LABEL,
      attribution: 'Methodology and emission factors from electricitymaps-contrib (AGPL-3.0)',
      url: 'https://github.com/electricitymaps/electricitymaps-contrib',
      license: 'AGPL-3.0 (methodology and configuration reused; data computed by this project)',
      independent: false,
      notes: 'Not Electricity Maps data. This project applies their published methodology.',
      active: false,
      jobs: [],
      observed_latency: [],
    },
  ],
  meta: {
    generated_at: '2026-09-11T12:00:00Z',
    sources: ['eia'],
    data_latest_period: '2026-09-11T11:00:00Z',
    stale: false,
  },
});

const wrapper = ({ children }: { children: ReactNode }): JSX.Element => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('routing', () => {
  it('sends /about/data to the about page and everything else to the map', () => {
    expect(routeFor('/about/data')).toBe('about-data');
    expect(routeFor('/about/data/')).toBe('about-data');
    expect(routeFor('/')).toBe('map');
    expect(routeFor('/anything')).toBe('map');
  });
});

describe('AboutData', () => {
  it('lists every source with its licence and attribution', async () => {
    respondWith(sources());
    render(<AboutData />, { wrapper });

    await waitFor(() => expect(screen.getByTestId('source-eia')).toBeInTheDocument());
    const eia = screen.getByTestId('source-eia');
    expect(eia).toHaveTextContent('Public domain');
    expect(eia).toHaveTextContent('U.S. Energy Information Administration');
  });

  it('includes the inactive Electricity Maps entry with its label verbatim', async () => {
    respondWith(sources());
    render(<AboutData />, { wrapper });

    await waitFor(() => expect(screen.getByTestId('source-emaps_method')).toBeInTheDocument());
    const entry = screen.getByTestId('source-emaps_method');
    // Verbatim: the wording is the requirement, not an approximation of it.
    expect(entry).toHaveTextContent(EMAPS_LABEL);
    expect(entry).toHaveTextContent('registered, not in use');
    expect(entry).toHaveTextContent('AGPL-3.0');
  });

  it('marks a derived source as not independent', async () => {
    respondWith(sources());
    render(<AboutData />, { wrapper });

    await waitFor(() => expect(screen.getByTestId('source-emaps_method')).toBeInTheDocument());
    expect(screen.getByTestId('source-emaps_method')).toHaveTextContent(
      'derived from another source',
    );
  });

  it('reports measured lag rather than an assumed figure', async () => {
    respondWith(sources());
    render(<AboutData />, { wrapper });

    await waitFor(() => expect(screen.getByTestId('latency-eia')).toBeInTheDocument());
    expect(screen.getByTestId('latency-eia')).toHaveTextContent('42.0h behind');
  });

  it('states that nothing is interpolated', async () => {
    respondWith(sources());
    render(<AboutData />, { wrapper });
    expect(screen.getByTestId('about-data')).toHaveTextContent('Nothing is interpolated');
  });

  it('reports a failure instead of an empty page', async () => {
    respondWith({ error: { code: 'unavailable', message: 'Database is down.' } }, 503);
    render(<AboutData />, { wrapper });

    await waitFor(() => expect(screen.getByTestId('about-error')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('Database is down.');
  });
});

describe('StatusBar', () => {
  const meta = (stale: boolean, latest: string | null) => ({
    generated_at: '2026-09-11T12:00:00Z',
    sources: ['eia'],
    data_latest_period: latest,
    stale,
  });

  it('shows the stale banner when the API says the data is behind', () => {
    const hoursAgo = new Date(Date.now() - 5 * 3600_000).toISOString();
    render(<StatusBar meta={meta(true, hoursAgo)} error={null} />);

    expect(screen.getByTestId('status-stale')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('hours behind');
  });

  it('says so when there is no data at all rather than showing a number', () => {
    render(<StatusBar meta={meta(true, null)} error={null} />);
    expect(screen.getByTestId('status-stale')).toHaveTextContent('unavailable');
  });

  it('shows the age when the data is current', () => {
    const recent = new Date(Date.now() - 30 * 60_000).toISOString();
    render(<StatusBar meta={meta(false, recent)} error={null} />);

    expect(screen.getByTestId('status-ok')).toHaveTextContent('ago');
    expect(screen.getByTestId('status-ok')).toHaveTextContent('EIA Form 930');
  });

  it('offers a retry when the API is unreachable, rather than a blank map', () => {
    const onRetry = vi.fn();
    render(<StatusBar meta={null} error="The API could not be reached." onRetry={onRetry} />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(onRetry).toHaveBeenCalled();
  });

  it('shows a loading state before anything has arrived', () => {
    render(<StatusBar meta={null} error={null} />);
    expect(screen.getByTestId('status-loading')).toBeInTheDocument();
  });
});

describe('ZoneList', () => {
  const zones = [
    {
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
    {
      key: 'US-US48',
      name: 'United States Lower 48',
      short_name: 'US Lower 48',
      interconnection: null,
      type: 'country_total',
      in_map: false,
      capabilities: {
        demand: true,
        demand_forecast: true,
        net_generation: true,
        fuel_mix: true,
        interchange: false,
      },
    },
  ];

  it('offers every mapped zone as a real button, so the map is reachable by keyboard', async () => {
    const { ZoneList } = await import('../src/components/ZoneList.tsx');
    const { useGridStore } = await import('../src/store/useGridStore.ts');
    const { makeWindow } = await import('./fixtures.ts');
    useGridStore.setState({ window: makeWindow(), cursor: 0, metric: 'demand_mw' });

    render(<ZoneList zones={zones} />);
    screen.getByRole('button', { name: /Show zone list/ }).click();

    await waitFor(() => expect(screen.getByRole('list', { name: 'Zones' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /ERCOT/ })).toBeInTheDocument();
    // Aggregates are off the map and must not appear in a list of what is drawn.
    expect(screen.queryByRole('button', { name: /US Lower 48/ })).not.toBeInTheDocument();
  });

  it('gives the number as well as the colour, and says no data where there is none', async () => {
    const { ZoneList } = await import('../src/components/ZoneList.tsx');
    const { useGridStore } = await import('../src/store/useGridStore.ts');
    const { makeWindow } = await import('./fixtures.ts');
    useGridStore.setState({ window: makeWindow(), cursor: 0, metric: 'demand_mw' });

    const withBpa = [
      ...zones,
      { ...zones[0]!, key: 'US-NW-BPAT', short_name: 'BPA', name: 'Bonneville' },
    ];
    render(<ZoneList zones={withBpa} />);
    screen.getByRole('button', { name: /Show zone list/ }).click();

    await waitFor(() => expect(screen.getByRole('button', { name: /BPA/ })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /BPA/ })).toHaveTextContent('no data');
    // 58000 MWh is shown as 58.0 GWh: large values scale so the column stays readable.
    expect(screen.getByRole('button', { name: /ERCOT/ })).toHaveTextContent('58.0 GWh');
  });
});
