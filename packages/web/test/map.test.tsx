/**
 * The map shell.
 *
 * MapLibre needs WebGL, which jsdom does not provide, so the library is mocked at the
 * boundary. What is being tested is this project's code: that the map is constructed
 * with the PMTiles source, and that window values reach it through setFeatureState
 * rather than by restyling the source.
 */
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWindow } from './fixtures.ts';

const featureStates: { id: string; state: Record<string, unknown> }[] = [];
const paintProperties: { layer: string; property: string; value: unknown }[] = [];
const handlers = new Map<string, (event: unknown) => void>();
let constructedWith: Record<string, unknown> | null = null;

vi.mock('maplibre-gl', () => {
  class Map {
    constructor(options: Record<string, unknown>) {
      constructedWith = options;
    }
    addControl = vi.fn();
    on = vi.fn((event: string, layerOrHandler: unknown, maybeHandler?: unknown) => {
      const handler = typeof layerOrHandler === 'function' ? layerOrHandler : maybeHandler;
      handlers.set(event, handler as (event: unknown) => void);
    });
    setFeatureState = vi.fn((target: { id: string }, state: Record<string, unknown>) => {
      featureStates.push({ id: target.id, state });
    });
    setPaintProperty = vi.fn((layer: string, property: string, value: unknown) => {
      paintProperties.push({ layer, property, value });
    });
    getCanvas = vi.fn(() => ({ style: {} }));
    queryRenderedFeatures = vi.fn(() => []);
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

const { MapView } = await import('../src/components/MapView.tsx');
const { useGridStore } = await import('../src/store/useGridStore.ts');

/** Fire the map's load event. It sets React state, so it must run inside act. */
const fireLoad = (): void => {
  act(() => {
    handlers.get('load')?.({});
  });
};

describe('MapView', () => {
  beforeEach(() => {
    featureStates.length = 0;
    paintProperties.length = 0;
    handlers.clear();
    constructedWith = null;
    useGridStore.setState({
      metric: 'demand_mw',
      selectedZone: null,
      hoveredZone: null,
      cursor: 0,
      playing: false,
      window: null,
    });
  });

  it('mounts', () => {
    const { getByTestId } = render(<MapView geometryVersion="1" />);
    expect(getByTestId('map')).toBeInTheDocument();
  });

  it('builds the style from the PMTiles archive with no basemap', () => {
    render(<MapView geometryVersion="7" />);
    const style = constructedWith?.style as {
      sources: Record<string, { url: string; promoteId: string }>;
      layers: { id: string; type: string }[];
    };

    const zoneSource = style.sources.zones;
    expect(zoneSource).toBeDefined();
    expect(zoneSource!.url).toContain('pmtiles://');
    expect(zoneSource!.url).toContain('v=7');
    // setFeatureState addresses features by id, so zone_key must be promoted.
    expect(zoneSource!.promoteId).toBe('zone_key');
    // A background and the zone layers, and nothing else: there is no basemap.
    expect(style.layers.map((layer) => layer.type).sort()).toEqual(
      ['background', 'fill', 'line'].sort(),
    );
  });

  it('paints when the window arrives before the map finishes loading', async () => {
    // The realistic order: the API answers in milliseconds, the tiles take longer.
    // Held by a test because getting this wrong leaves the map permanently grey with
    // no error anywhere.
    render(<MapView geometryVersion="1" />);

    const payload = makeWindow();
    useGridStore.getState().setWindow(payload);
    expect(featureStates).toHaveLength(0);

    fireLoad();

    await waitFor(() => {
      const ids = new Set(featureStates.map((entry) => entry.id));
      expect(ids).toEqual(new Set(Object.keys(payload.zones)));
    });
    await waitFor(() =>
      expect(paintProperties.some((entry) => entry.property === 'fill-color')).toBe(true),
    );
  });

  it('applies feature state for every zone once a window arrives', async () => {
    render(<MapView geometryVersion="1" />);
    fireLoad();

    const payload = makeWindow();
    useGridStore.getState().setWindow(payload);

    await waitFor(() => {
      const ids = new Set(featureStates.map((entry) => entry.id));
      expect(ids).toEqual(new Set(Object.keys(payload.zones)));
    });
  });

  it('distinguishes a zone with no data from one reading zero', async () => {
    render(<MapView geometryVersion="1" />);
    fireLoad();
    useGridStore.getState().setWindow(makeWindow());

    await waitFor(() => {
      const noData = featureStates.findLast((entry) => entry.id === 'US-NW-BPAT');
      const zero = featureStates.findLast((entry) => entry.id === 'US-CAL-CISO');
      expect(noData?.state.value).toBeNull();
      expect(zero?.state.value).toBe(0);
    });
  });

  it('repaints from memory when the metric changes, issuing no request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<MapView geometryVersion="1" />);
    fireLoad();
    useGridStore.getState().setWindow(makeWindow());

    await waitFor(() => expect(featureStates.length).toBeGreaterThan(0));
    const before = featureStates.length;

    useGridStore.getState().setMetric('renewable_share');

    await waitFor(() => expect(featureStates.length).toBeGreaterThan(before));
    // Renewable share for ERCO is 0.41 in the fixture, not its demand.
    const erco = featureStates.findLast((entry) => entry.id === 'US-TEX-ERCO');
    expect(erco?.state.value).toBe(0.41);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('repaints when the cursor moves, issuing no request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<MapView geometryVersion="1" />);
    fireLoad();
    useGridStore.getState().setWindow(makeWindow());
    await waitFor(() => expect(featureStates.length).toBeGreaterThan(0));

    useGridStore.getState().setCursor(0);

    await waitFor(() => {
      const erco = featureStates.findLast((entry) => entry.id === 'US-TEX-ERCO');
      expect(erco?.state.value).toBe(58000);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('holds the colour ramp still while the cursor moves', async () => {
    // The domain is computed from the window, not the hour on screen. Per-hour scaling
    // means a zone can hold its value and change colour, or change value and hold its
    // colour, so no two frames can be compared by eye.
    render(<MapView geometryVersion="1" />);
    fireLoad();
    useGridStore.getState().setWindow(makeWindow());

    const fillColour = (): unknown =>
      paintProperties.findLast((entry) => entry.property === 'fill-color')?.value;

    await waitFor(() => expect(fillColour()).toBeDefined());
    useGridStore.getState().setCursor(0);
    await waitFor(() => {
      const erco = featureStates.findLast((entry) => entry.id === 'US-TEX-ERCO');
      expect(erco?.state.value).toBe(58000);
    });
    const atFirstHour = fillColour();

    // ERCO's demand rises by 100 an hour in the fixture, so an hour-scaled domain
    // would move here and a window-scaled one would not.
    useGridStore.getState().setCursor(3);
    await waitFor(() => {
      const erco = featureStates.findLast((entry) => entry.id === 'US-TEX-ERCO');
      expect(erco?.state.value).toBe(58300);
    });

    expect(fillColour()).toEqual(atFirstHour);
  });

  it('will not zoom out past the zoom the tiles start at', () => {
    // tippecanoe builds the archive with -Z3 -z8. MapLibre over-zooms past a maxzoom
    // but does not under-zoom below a minzoom: below z3 there is no tile, and the map
    // renders empty with no error to say why.
    render(<MapView geometryVersion="1" />);
    expect(constructedWith?.minZoom).toBe(3);
    expect(constructedWith?.maxZoom).toBe(8);
  });

  it('marks the selected zone through feature state', async () => {
    render(<MapView geometryVersion="1" />);
    fireLoad();
    useGridStore.getState().setWindow(makeWindow());
    await waitFor(() => expect(featureStates.length).toBeGreaterThan(0));

    useGridStore.getState().selectZone('US-TEX-ERCO');

    await waitFor(() => {
      const selected = featureStates.findLast(
        (entry) => entry.id === 'US-TEX-ERCO' && 'selected' in entry.state,
      );
      expect(selected?.state.selected).toBe(true);
    });
  });
});
