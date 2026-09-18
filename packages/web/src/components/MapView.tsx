/**
 * The map.
 *
 * No basemap: zone polygons and a thin boundary line, which keeps the payload small and
 * reads as deliberate rather than as a missing tile layer.
 *
 * Values reach the map through `setFeatureState`, never by restyling the source. That is
 * what lets the slider scrub and the metric switch repaint from memory.
 */
import maplibregl, { type MapGeoJSONFeature } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import { METRICS, metricIndex } from '../lib/metrics.ts';
import { fillColourExpression, fillOpacityExpression, lineWidthExpression } from '../lib/paint.ts';
import { contextUrl, registerPmtilesProtocol, zonesArchiveUrl } from '../lib/pmtiles.ts';
import { useGridStore, valuesAcrossWindow, valuesAtCursor } from '../store/useGridStore.ts';

const SOURCE_ID = 'zones';
const SOURCE_LAYER = 'zones';
const FILL_LAYER = 'zones-fill';
const LINE_LAYER = 'zones-line';
const CONTEXT_SOURCE = 'context';
const CONTEXT_FILL = 'context-fill';
const CONTEXT_LINE = 'context-line';

/**
 * Canada and Mexico: the shape of the land, and nothing more.
 *
 * Deliberately fainter than a no-data zone. On this map a grey shape already means "a
 * zone that published nothing this hour", and context must not be mistakable for that:
 * a no-data fill resolves to about #1d1f24 against the background, and this to about
 * #11141a — present enough to read as land, too faint to read as a measurement.
 *
 * These layers are never queried for features, so they cannot be hovered, clicked or
 * selected. A shape with no data behind it should not respond as though it had some.
 */
const CONTEXT_FILL_COLOUR = '#3f3f46';
const CONTEXT_FILL_OPACITY = 0.12;
const CONTEXT_LINE_COLOUR = '#242830';

/**
 * Continental US, which is all MVP 1 draws.
 *
 * Opened by fitting these bounds rather than at a fixed zoom. A fixed 3.4 is right on a
 * desktop and wrong on a phone, where 375px of width shows barely half the country and
 * the reader arrives already lost. Fitting adapts to whatever viewport it lands in.
 */
const US_BOUNDS: [[number, number], [number, number]] = [
  [-125.0, 24.4],
  [-66.9, 49.4],
];
const FIT_PADDING = 16;

/**
 * The zoom range the tiles actually cover, from `tippecanoe -Z2 -z8` in
 * `geo/build/README.md`.
 *
 * MapLibre over-zooms past a source's maxzoom but does not under-zoom below its
 * minzoom: at a lower zoom there is simply no tile, and the map goes empty with no
 * error. So the map may not be allowed to go below where the archive starts.
 *
 * The archive starts at 2 rather than 3 because the continental US does not fit on a
 * phone at 3. A 375px viewport needs roughly 2.2 to show it, so a floor of 3 left a
 * mobile reader panning around a map they could never see whole. The extra zoom level
 * costs about 6 KB.
 */
const TILE_MIN_ZOOM = 2;
const TILE_MAX_ZOOM = 8;

export interface MapViewProps {
  geometryVersion: string;
  onReady?: () => void;
}

export const MapView = ({ geometryVersion, onReady }: MapViewProps): JSX.Element => {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const painted = useRef<Set<string>>(new Set());

  // Readiness is state, not a ref. The window response usually arrives before the
  // tiles finish loading, and a ref would leave the paint effect having already run
  // and returned early, with nothing to re-trigger it: the map would stay grey.
  const [ready, setReady] = useState(false);

  const metric = useGridStore((state) => state.metric);
  const cursor = useGridStore((state) => state.cursor);
  const windowPayload = useGridStore((state) => state.window);
  const selectedZone = useGridStore((state) => state.selectedZone);
  const selectZone = useGridStore((state) => state.selectZone);
  const hoverZone = useGridStore((state) => state.hoverZone);

  // --- construction, once ------------------------------------------------------------
  useEffect(() => {
    if (container.current === null || map.current !== null) return;
    registerPmtilesProtocol();

    const instance = new maplibregl.Map({
      container: container.current,
      style: {
        version: 8,
        sources: {
          [SOURCE_ID]: {
            type: 'vector',
            url: zonesArchiveUrl(geometryVersion),
            // setFeatureState addresses features by id; zone_key is the only property
            // the tiles carry, so it becomes the id.
            promoteId: 'zone_key',
          },
          [CONTEXT_SOURCE]: { type: 'geojson', data: contextUrl(geometryVersion) },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#0b0e14' } },
          // Before the zone layers, so context sits underneath and a zone is never
          // drawn over by its neighbours' surroundings.
          {
            id: CONTEXT_FILL,
            type: 'fill',
            source: CONTEXT_SOURCE,
            paint: {
              'fill-color': CONTEXT_FILL_COLOUR,
              'fill-opacity': CONTEXT_FILL_OPACITY,
            },
          },
          {
            id: CONTEXT_LINE,
            type: 'line',
            source: CONTEXT_SOURCE,
            paint: { 'line-color': CONTEXT_LINE_COLOUR, 'line-width': 0.5 },
          },
          {
            id: FILL_LAYER,
            type: 'fill',
            source: SOURCE_ID,
            'source-layer': SOURCE_LAYER,
            paint: { 'fill-color': '#3f3f46', 'fill-opacity': 0.85 },
          },
          {
            id: LINE_LAYER,
            type: 'line',
            source: SOURCE_ID,
            'source-layer': SOURCE_LAYER,
            paint: { 'line-color': '#0b0e14', 'line-width': 0.4 },
          },
        ],
      },
      bounds: US_BOUNDS,
      fitBoundsOptions: { padding: FIT_PADDING },
      attributionControl: false,
      maxZoom: TILE_MAX_ZOOM,
      minZoom: TILE_MIN_ZOOM,
    });

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution:
          'Boundaries: electricitymaps-contrib (AGPL-3.0) · Data: U.S. EIA Form 930',
      }),
      'bottom-right',
    );

    // Start it folded into its ⓘ. Compact attribution opens on load, and expanded it is
    // a band across the bottom of the map — on a landscape phone, across a map only
    // about 150px tall.
    //
    // Folded, not removed, and the button is never hidden: the boundaries are AGPL
    // geometry and the data is EIA's, so both credits have to stay reachable. This is
    // MapLibre's own collapsed state, one tap from being open.
    instance
      .getContainer()
      .querySelector('.maplibregl-ctrl-attrib')
      ?.classList.remove('maplibregl-compact-show');

    const zoneKeyOf = (feature: MapGeoJSONFeature): string | null => {
      const key = feature.properties?.zone_key;
      return typeof key === 'string' ? key : null;
    };

    let hovered: string | null = null;
    const setHover = (key: string | null): void => {
      if (hovered !== null) {
        instance.setFeatureState(
          { source: SOURCE_ID, sourceLayer: SOURCE_LAYER, id: hovered },
          { hovered: false },
        );
      }
      hovered = key;
      if (key !== null) {
        instance.setFeatureState(
          { source: SOURCE_ID, sourceLayer: SOURCE_LAYER, id: key },
          { hovered: true },
        );
      }
      hoverZone(key);
      instance.getCanvas().style.cursor = key === null ? '' : 'pointer';
    };

    instance.on('mousemove', FILL_LAYER, (event) => {
      const feature = event.features?.[0];
      setHover(feature === undefined ? null : zoneKeyOf(feature));
    });
    instance.on('mouseleave', FILL_LAYER, () => setHover(null));
    instance.on('click', FILL_LAYER, (event) => {
      const feature = event.features?.[0];
      if (feature !== undefined) selectZone(zoneKeyOf(feature));
    });

    // A click that hits no zone closes the panel, which is what a reader expects from
    // clicking the background.
    instance.on('click', (event) => {
      const hits = instance.queryRenderedFeatures(event.point, { layers: [FILL_LAYER] });
      if (hits.length === 0) selectZone(null);
    });

    instance.on('load', () => {
      setReady(true);
      instance.setPaintProperty(FILL_LAYER, 'fill-opacity', fillOpacityExpression());
      instance.setPaintProperty(LINE_LAYER, 'line-width', lineWidthExpression());
      instance.setPaintProperty(LINE_LAYER, 'line-color', '#111827');
      onReady?.();
    });

    // Development only: lets the map be inspected from the console, which is the
    // only practical way to check what the tiles actually contain.
    if (import.meta.env.DEV) {
      (globalThis as unknown as { __gridMap?: maplibregl.Map }).__gridMap = instance;
    }

    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
      setReady(false);
    };
  }, [geometryVersion, hoverZone, onReady, selectZone]);

  // Computed from the window rather than the cursor, so scrubbing does not re-scale
  // the ramp, and recomputed only when the window or the metric changes.
  const windowValues = useMemo(
    () => valuesAcrossWindow(windowPayload, metricIndex(metric)),
    [windowPayload, metric],
  );

  // --- painting, on every metric or cursor change -------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready || windowPayload === null) return;

    const position = metricIndex(metric);
    const values = valuesAtCursor(windowPayload, cursor, position);

    // Feature ids are the zone key, promoted from the tile property, so state can be
    // addressed without a lookup table.
    for (const [key, value] of values) {
      instance.setFeatureState(
        { source: SOURCE_ID, sourceLayer: SOURCE_LAYER, id: key },
        { value },
      );
      painted.current.add(key);
    }

    instance.setPaintProperty(
      FILL_LAYER,
      'fill-color',
      fillColourExpression(METRICS[metric], windowValues),
    );
  }, [metric, cursor, windowPayload, windowValues, ready]);

  // --- the canvas follows its container ------------------------------------------------
  //
  // MapLibre listens for window resizes and nothing else, so it never learns that the
  // zone panel opened and took a third of the width from it. The canvas then keeps its
  // old size and the map is drawn stretched into a container that no longer matches.
  //
  // The view itself is left alone: re-fitting here would snatch the map back from a
  // reader who had panned somewhere.
  useEffect(() => {
    const node = container.current;
    const instance = map.current;
    if (node === null || instance === null || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (node.clientWidth > 0 && node.clientHeight > 0) instance.resize();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ready]);

  // --- selection ---------------------------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready) return;
    for (const key of painted.current) {
      instance.setFeatureState(
        { source: SOURCE_ID, sourceLayer: SOURCE_LAYER, id: key },
        { selected: key === selectedZone },
      );
    }
  }, [selectedZone, ready]);

  return <div ref={container} className="h-full w-full" data-testid="map" />;
};
