/**
 * Canada and Mexico, as context only.
 *
 * The map draws US balancing authorities and nothing else, which leaves the continent
 * ending at a hard edge. These two outlines restore the shape of the land around it.
 *
 * They are not data and must never be mistaken for it. On this map a grey shape already
 * means "a zone that published nothing this hour", so context is drawn far fainter than
 * that, carries no properties, and is not interactive — see MapView.
 *
 * Source is the same electricitymaps-contrib world.geojson the zones come from, so
 * there is no second licence or attribution to track: the provinces and states are
 * dissolved to one feature per country, since the internal boundaries are detail nobody
 * is reading here.
 *
 * Run by hand:  node geo/build/prepare-context.js   (then `pnpm -C geo/build simplify-context`)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

/** Country keys to keep, and the name each one is published under. */
const COUNTRIES = { CA: 'Canada', MX: 'Mexico' };

const source = JSON.parse(readFileSync(join(repoRoot, 'geo', 'src', 'world.geojson'), 'utf8'));

/** Every polygon ring of a feature, whatever geometry type it uses. */
const polygonsOf = (geometry) => {
  if (geometry === null || geometry === undefined) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
};

const features = Object.entries(COUNTRIES).map(([key, name]) => {
  const parts = source.features
    .filter((feature) => feature.properties?.countryKey === key)
    .flatMap((feature) => polygonsOf(feature.geometry));

  if (parts.length === 0) {
    throw new Error(`no features with countryKey "${key}" in world.geojson`);
  }

  // Only `name`, and only so the layer is legible in a debugger. Nothing reads it, and
  // nothing may: a context shape has no value, no state and no meaning beyond its edge.
  return {
    type: 'Feature',
    properties: { name },
    geometry: { type: 'MultiPolygon', coordinates: parts },
  };
});

const target = join(repoRoot, 'geo', 'src', 'context.raw.geojson');
writeFileSync(target, JSON.stringify({ type: 'FeatureCollection', features }));

const counts = features.map((f) => `${f.properties.name}: ${f.geometry.coordinates.length} parts`);
process.stderr.write(`wrote ${target}\n${counts.join('\n')}\n`);
