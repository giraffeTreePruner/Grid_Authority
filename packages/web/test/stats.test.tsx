/**
 * The unlisted usage page, and the beacon that feeds it.
 *
 * The property worth holding is honesty about what the numbers mean: an all-time
 * "visitors" figure that is really a sum of daily uniques must say so, and the two
 * sources must stay separate rather than being added together into one confident wrong
 * total.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Stats } from '../src/pages/Stats.tsx';
import { reportPageView, resetBeaconForTests } from '../src/lib/beacon.ts';
import { PATH_FOR, routeFor } from '../src/lib/route.ts';

const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const payload = (over: Record<string, unknown> = {}) => ({
  views: { today: 12, week: 80, all: 4213 },
  visitors: { today: 7, week: 41, all: 980 },
  visitors_note: 'Unique per day. Weekly and all-time are sums of daily uniques.',
  daily: [{ day: '2026-09-16', views: 12, visitors: 7 }],
  cloudflare: null,
  meta: {
    generated_at: '2026-09-16T12:00:00Z',
    sources: ['eia'],
    data_latest_period: null,
    stale: false,
  },
  ...over,
});

const respondWith = (body: unknown): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
      ),
    ),
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('routing', () => {
  it('knows the unlisted path', () => {
    expect(routeFor('/stats')).toBe('stats');
    expect(routeFor('/stats/')).toBe('stats');
    expect(routeFor('/')).toBe('map');
    expect(routeFor('/about/data')).toBe('about-data');
  });
});

describe('the beacon', () => {
  beforeEach(() => {
    resetBeaconForTests();
  });

  it('reports the canonical path, not the address bar', () => {
    // A query string is not a different page, and echoing the URL back would store
    // whatever a visitor happened to be carrying in it.
    const beacon = vi.fn((_url: string, _body?: BodyInit | null) => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });

    reportPageView(PATH_FOR.map);

    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon.mock.calls[0]?.[0]).toContain('/hit');
  });

  it('reports once, however many times it is called', () => {
    // StrictMode runs effects twice in development; that must not double every count.
    const beacon = vi.fn((_url: string, _body?: BodyInit | null) => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });

    reportPageView('/');
    reportPageView('/');
    reportPageView('/about/data');

    expect(beacon).toHaveBeenCalledTimes(1);
  });

  it('never throws, even when an extension replaces sendBeacon with a trap', () => {
    // A lost count is a wrong count. A thrown error is a broken page. Privacy
    // extensions do replace this API with one that throws, so this is a real case
    // rather than a defensive one.
    vi.stubGlobal('navigator', {
      sendBeacon: () => {
        throw new Error('blocked by extension');
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('also blocked'))),
    );

    expect(() => reportPageView('/')).not.toThrow();
  });
});

describe('the usage page', () => {
  it('shows views and visitors for each span', async () => {
    respondWith(payload());
    render(<Stats />, { wrapper });

    expect(await screen.findByTestId('views-all')).toHaveTextContent('4,213');
    expect(screen.getByTestId('visitors-today')).toHaveTextContent('7');
    expect(screen.getByTestId('visitors-all')).toHaveTextContent('980');
  });

  it('carries the caveat about what a wider visitor count means', async () => {
    // The number is a sum of daily uniques. Printing it without saying so invites it to
    // be read as people, which it is not.
    respondWith(payload());
    render(<Stats />, { wrapper });
    expect(await screen.findByTestId('visitors-note')).toHaveTextContent('sums of daily uniques');
  });

  it('says Cloudflare is not configured rather than showing zero', async () => {
    // Zero reads as "no traffic". Absent reads as absent.
    respondWith(payload());
    render(<Stats />, { wrapper });
    expect(await screen.findByTestId('cloudflare-absent')).toBeInTheDocument();
    expect(screen.queryByTestId('cf-views-today')).not.toBeInTheDocument();
  });

  it('keeps the two sources apart when both are present', async () => {
    respondWith(
      payload({
        cloudflare: {
          views: { today: 99, week: 400, all: 0 },
          visitors: { today: 55, week: 0, all: 0 },
        },
      }),
    );
    render(<Stats />, { wrapper });

    // Each source keeps its own figure; nothing sums them into one total.
    expect(await screen.findByTestId('cf-views-today')).toHaveTextContent('99');
    expect(screen.getByTestId('views-today')).toHaveTextContent('12');
  });
});
