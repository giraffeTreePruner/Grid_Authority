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
