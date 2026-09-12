/**
 * The validation gate.
 *
 * §11: every `in_map: true` zone must have exactly one feature, and every feature must
 * match a zone. Failing the build is the point — a zone that silently loses its polygon
 * disappears from the map with no other symptom.
 *
 * It also checks the committed artifact: that it exists, is a PMTiles v3 archive, and
 * is within the size budget.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

export const MAX_ARTIFACT_BYTES = 600 * 1024;

const problems = [];
const note = (line) => process.stderr.write(`${line}\n`);

const mappedZones = () => {
  const zones = parse(readFileSync(join(repoRoot, 'config', 'zones.yaml'), 'utf8'));
  return {
    mapped: new Set(zones.filter((zone) => zone.in_map).map((zone) => zone.key)),
    all: new Set(zones.map((zone) => zone.key)),
  };
};

const checkFeatures = (mapped, all) => {
  const path = join(repoRoot, 'geo', 'src', 'zones.simplified.geojson');
  const collection = JSON.parse(readFileSync(path, 'utf8'));

  const counts = new Map();
  for (const feature of collection.features) {
    const key = feature.properties?.zone_key;
    if (typeof key !== 'string' || key === '') {
      problems.push('a feature carries no zone_key');
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!all.has(key)) problems.push(`feature "${key}" matches no zone in the registry`);
    else if (!mapped.has(key)) problems.push(`feature "${key}" is for a zone with in_map: false`);

    if (feature.geometry === null) problems.push(`feature "${key}" has null geometry`);
  }

  for (const key of mapped) {
    const count = counts.get(key) ?? 0;
    if (count === 0) problems.push(`zone "${key}" is in_map but has no feature`);
    else if (count > 1) problems.push(`zone "${key}" has ${count} features; expected exactly one`);
  }

  note(`features: ${collection.features.length} for ${mapped.size} mapped zones`);
};

const checkArtifact = () => {
  const path = join(repoRoot, 'geo', 'zones.pmtiles');
  let stats;
  try {
    stats = statSync(path);
  } catch {
    problems.push('geo/zones.pmtiles does not exist; run the pipeline in geo/build/README.md');
    return;
  }

  const header = readFileSync(path).subarray(0, 8);
  if (header.subarray(0, 7).toString('ascii') !== 'PMTiles') {
    problems.push('geo/zones.pmtiles is not a PMTiles archive');
  } else if (header[7] !== 3) {
    problems.push(`geo/zones.pmtiles is spec version ${header[7]}; expected 3`);
  }

  const kb = (stats.size / 1024).toFixed(1);
  if (stats.size > MAX_ARTIFACT_BYTES) {
    problems.push(`geo/zones.pmtiles is ${kb} KB, over the ${MAX_ARTIFACT_BYTES / 1024} KB budget`);
  }
  note(`artifact: ${kb} KB of a ${MAX_ARTIFACT_BYTES / 1024} KB budget`);
};

const main = () => {
  const { mapped, all } = mappedZones();
  checkFeatures(mapped, all);
  checkArtifact();

  if (problems.length > 0) {
    note(`\n${problems.length} problem(s):`);
    for (const problem of problems) note(`  - ${problem}`);
    process.exit(1);
  }
  note('geometry validation passed');
};

main();
