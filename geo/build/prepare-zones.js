/**
 * Step 2. Select the zones this project maps, join them to the registry, and derive
 * the one polygon the source does not carry.
 *
 * Everything here is explicit. A zone with no geometry is reported by name so it can
 * be moved to `in_map: false` with a reason, rather than silently disappearing from
 * the map.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

/**
 * SWPW has no polygon of its own. It is the Southwest Power Pool's West balancing
 * authority area, created when SPP absorbed the two Western Area Power Administration
 * balancing authorities. Two independent lines of evidence support the union:
 * the source carries WACM and WAUW, and this project's own ingest shows both ceased
 * publishing at 2026-04-02T18 with SWPW beginning at the same time.
 *
 * This is a derivation, not source data, and is labelled as such in the output.
 */
export const DERIVED = {
  'US-NW-SWPW': { from: ['US-NW-WACM', 'US-NW-WAUW'], why: 'absorbed both on 2026-04-02' },
};

const readZones = () => {
  const text = readFileSync(join(repoRoot, 'config', 'zones.yaml'), 'utf8');
  return parse(text).filter((zone) => zone.in_map);
};

/** Merge several features into one MultiPolygon. */
const union = (features) => {
  const polygons = [];
  for (const feature of features) {
    const { type, coordinates } = feature.geometry;
    if (type === 'Polygon') polygons.push(coordinates);
    else if (type === 'MultiPolygon') polygons.push(...coordinates);
    else throw new Error(`cannot merge geometry of type ${type}`);
  }
  return { type: 'MultiPolygon', coordinates: polygons };
};

const main = () => {
  const world = JSON.parse(readFileSync(join(repoRoot, 'geo', 'src', 'world.geojson'), 'utf8'));
  const byZone = new Map();
  for (const feature of world.features) {
    const key = feature.properties?.zoneName;
    if (typeof key === 'string') byZone.set(key, feature);
  }

  const zones = readZones();
  const features = [];
  const derived = [];
  const missing = [];

  for (const zone of zones) {
    const direct = byZone.get(zone.key);
    if (direct !== undefined) {
      // Features carry only zone_key: everything else comes from the API at runtime,
      // and duplicating it here would let the two drift apart.
      features.push({
        type: 'Feature',
        properties: { zone_key: zone.key },
        geometry: direct.geometry,
      });
      continue;
    }

    const recipe = DERIVED[zone.key];
    if (recipe !== undefined) {
      const parts = recipe.from.map((key) => {
        const part = byZone.get(key);
        if (part === undefined) throw new Error(`${zone.key} needs ${key}, which is absent`);
        return part;
      });
      features.push({
        type: 'Feature',
        properties: { zone_key: zone.key, derived_from: recipe.from.join('+') },
        geometry: union(parts),
      });
      derived.push(`${zone.key} = ${recipe.from.join(' ∪ ')} (${recipe.why})`);
      continue;
    }

    missing.push(zone.key);
  }

  const target = join(repoRoot, 'geo', 'src', 'zones.raw.geojson');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ type: 'FeatureCollection', features }), 'utf8');

  process.stderr.write(`${features.length} features written to ${target}\n`);
  for (const line of derived) process.stderr.write(`  derived: ${line}\n`);
  if (missing.length > 0) {
    process.stderr.write(
      `\n${missing.length} zone(s) marked in_map but with no geometry:\n` +
        missing.map((key) => `  ${key}\n`).join('') +
        'Each must move to in_map: false with a documented reason, or gain geometry.\n',
    );
    process.exitCode = 1;
  }
};

main();
