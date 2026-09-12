/**
 * The geometry artifact, checked from whatever is committed.
 *
 * §11 makes this a build gate. Running it in CI means a registry change that adds a
 * mapped zone without geometry fails a test rather than quietly leaving a hole in the
 * map, which has no other symptom.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MAX_ARTIFACT_BYTES = 600 * 1024;

interface ZoneEntry {
  key: string;
  in_map: boolean;
}

const zones = (): ZoneEntry[] =>
  parse(readFileSync(join(repoRoot, 'config', 'zones.yaml'), 'utf8')) as ZoneEntry[];

const features = (): { properties: { zone_key?: string }; geometry: unknown }[] =>
  JSON.parse(readFileSync(join(repoRoot, 'geo', 'src', 'zones.simplified.geojson'), 'utf8'))
    .features;

describe('geometry', () => {
  it('has exactly one feature per mapped zone', () => {
    const mapped = zones()
      .filter((zone) => zone.in_map)
      .map((zone) => zone.key);
    const keys = features().map((feature) => feature.properties.zone_key);

    expect(keys).toHaveLength(mapped.length);
    expect([...keys].sort()).toEqual([...mapped].sort());
  });

  it('has no feature for a zone that is off the map', () => {
    const offMap = new Set(
      zones()
        .filter((zone) => !zone.in_map)
        .map((zone) => zone.key),
    );
    for (const feature of features()) {
      expect(offMap.has(feature.properties.zone_key ?? '')).toBe(false);
    }
  });

  it('carries only zone_key on each feature, so nothing can drift', () => {
    for (const feature of features()) {
      const keys = Object.keys(feature.properties).filter((key) => key !== 'derived_from');
      expect(keys).toEqual(['zone_key']);
      expect(feature.geometry).not.toBeNull();
    }
  });

  it('ships a PMTiles v3 archive within budget', () => {
    const path = join(repoRoot, 'geo', 'zones.pmtiles');
    const header = readFileSync(path).subarray(0, 8);
    expect(header.subarray(0, 7).toString('ascii')).toBe('PMTiles');
    expect(header[7]).toBe(3);
    expect(statSync(path).size).toBeLessThan(MAX_ARTIFACT_BYTES);
  });

  it('passes the build gate', () => {
    // The gate is the thing that runs by hand; running it here keeps the two honest.
    const output = execFileSync('node', [join(repoRoot, 'geo', 'build', 'validate.js')], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(output).toBeDefined();
  });
});
