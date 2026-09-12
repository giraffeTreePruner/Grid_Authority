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
import { useEffect, useRef } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import { METRICS, metricIndex } from '../lib/metrics.ts';
import { fillColourExpression, fillOpacityExpression, lineWidthExpression } from '../lib/paint.ts';
import { registerPmtilesProtocol, zonesArchiveUrl } from '../lib/pmtiles.ts';
import { useGridStore, valuesAtCursor } from '../store/useGridStore.ts';

const SOURCE_ID = 'zones';
const SOURCE_LAYER = 'zones';
const FILL_LAYER = 'zones-fill';
const LINE_LAYER = 'zones-line';

/** Continental US, which is all MVP 1 draws. */
const INITIAL_VIEW = { center: [-98.5, 39.5] as [number, number], zoom: 3.4 };

export interface MapViewProps {
  geometryVersion: string;
  onReady?: () => void;
}

export const MapView = ({ geometryVersion, onReady }: MapViewProps): JSX.Element => {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const loaded = useRef(false);
  const painted = useRef<Set<string>>(new Set());

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
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#0b0e14' } },
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
      ...INITIAL_VIEW,
      attributionControl: false,
      maxZoom: 8,
      minZoom: 2,
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
      loaded.current = true;
      instance.setPaintProperty(FILL_LAYER, 'fill-opacity', fillOpacityExpression());
      instance.setPaintProperty(LINE_LAYER, 'line-width', lineWidthExpression());
      instance.setPaintProperty(LINE_LAYER, 'line-color', '#111827');
      onReady?.();
    });

    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
      loaded.current = false;
    };
  }, [geometryVersion, hoverZone, onReady, selectZone]);

  // --- painting, on every metric or cursor change -------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !loaded.current || windowPayload === null) return;

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
      fillColourExpression(METRICS[metric], [...values.values()]),
    );
  }, [metric, cursor, windowPayload]);

  // --- selection ---------------------------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !loaded.current) return;
    for (const key of painted.current) {
      instance.setFeatureState(
        { source: SOURCE_ID, sourceLayer: SOURCE_LAYER, id: key },
        { selected: key === selectedZone },
      );
    }
  }, [selectedZone]);

  return <div ref={container} className="h-full w-full" data-testid="map" />;
};
