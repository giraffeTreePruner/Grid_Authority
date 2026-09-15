/**
 * Registering the PMTiles protocol with MapLibre.
 *
 * This must happen before any map is constructed, or the style's `pmtiles://` source
 * resolves to nothing. Registration is idempotent so hot reload does not stack
 * protocols.
 */
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';

let registered = false;

export const registerPmtilesProtocol = (): void => {
  if (registered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  registered = true;
};

/** Where the committed archive is served from, cache-busted by GEOMETRY_VERSION. */
export const zonesArchiveUrl = (version: string): string =>
  `pmtiles://${window.location.origin}/zones.pmtiles?v=${encodeURIComponent(version)}`;

/**
 * The Canada and Mexico outlines, cache-busted the same way.
 *
 * Context only: the map draws US balancing authorities, and without these the continent
 * ends at a hard edge with nothing to say whether that is the coastline or the limit of
 * the data.
 */
export const contextUrl = (version: string): string =>
  `${window.location.origin}/context.geojson?v=${encodeURIComponent(version)}`;
