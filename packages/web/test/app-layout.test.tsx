/**
 * Which controls are on screen, and when.
 *
 * One rule: a control for the map is shown only when the map is. On a phone the zone
 * panel is a full sheet over the map, so the metric switcher, the resolution control
 * and the time slider would be driving something invisible — and the panel has its own
 * window control, which put two unrelated time ranges on screen at once with only one
 * of them doing anything.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('maplibre-gl', () => {
  class Map {
    addControl = vi.fn();
    on = vi.fn();
    setFeatureState = vi.fn();
    setPaintProperty = vi.fn();
    getCanvas = vi.fn(() => ({ style: {} }));
    getContainer = vi.fn(() => document.createElement('div'));
    queryRenderedFeatures = vi.fn(() => []);
    resize = vi.fn();
    remove = vi.fn();
  }
  return {
    default: {
      Map,
      NavigationControl: class {},
      AttributionControl: class {},
      addProtocol: vi.fn(),
    },
    Map,
    NavigationControl: class {},
    AttributionControl: class {},
    addProtocol: vi.fn(),
  };
});
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));

const { App } = await import('../src/App.tsx');
const { useGridStore } = await import('../src/store/useGridStore.ts');

const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const MAP_CONTROLS = ['metric-controls', 'resolution-controls', 'slider-controls'];

describe('map controls follow the map', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } })),
      ),
    );
    useGridStore.setState({ selectedZone: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows every map control while the map is the thing on screen', () => {
    render(<App />, { wrapper });
    for (const id of MAP_CONTROLS) {
      expect(screen.getByTestId(id).className).not.toContain('hidden');
    }
  });

  it('hides them on a phone once a zone sheet covers the map', () => {
    useGridStore.setState({ selectedZone: 'US-TEX-ERCO' });
    render(<App />, { wrapper });
    for (const id of MAP_CONTROLS) {
      const control = screen.getByTestId(id);
      expect(control.className, id).toContain('hidden');
      // Still there beside a visible map: this is a phone rule, not a removal.
      expect(control.className, id).toMatch(/sm:(block|flex)/);
    }
  });
});

/**
 * jsdom has no layout engine, so these assert the rule rather than the pixels. The
 * measurement that motivated them was taken in a real browser at 812x375: the floating
 * legend is 360x117 over about 175px of map, a quarter of the thing it explains.
 */
describe('the legend on a short screen', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } })),
      ),
    );
    useGridStore.setState({ selectedZone: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('moves out of the map and into the footer', () => {
    render(<App />, { wrapper });

    // The floating one steps aside where height is scarce...
    const floating = document.querySelector('.absolute.bottom-4.left-4');
    expect(floating?.className).toContain('short:hidden');

    // ...and the one beside the footer appears only there, so nothing is lost and
    // nothing is on screen twice.
    const footerLegend = screen.getByTestId('footer-legend');
    expect(footerLegend.className).toContain('hidden');
    expect(footerLegend.className).toContain('short:flex');
  });

  it('follows the same rule as the floating one when a zone sheet is open', () => {
    // A legend for a map the reader cannot see is the rule this file is named for, and
    // moving it to the footer must not create an exception to it.
    useGridStore.setState({ selectedZone: 'US-TEX-ERCO' });
    render(<App />, { wrapper });
    expect(screen.getByTestId('footer-legend').className).toContain('short:hidden');
  });
});
