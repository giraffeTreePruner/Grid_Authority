/**
 * Step 1. Fetch the source polygons.
 *
 * electricitymaps-contrib publishes zone geometry under AGPL-3.0. This project is
 * AGPL-3.0, so reuse is permitted, and the attribution is recorded in
 * config/sources.yaml and geo/build/README.md.
 *
 * HIFLD Open "Control Areas" was the other candidate named in the build spec. Its
 * ArcGIS endpoints now reject anonymous queries, so it is not usable without
 * credentials; that is recorded rather than quietly skipped.
 *
 * The downloaded file is not committed. Only the derived artifacts are.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

export const SOURCE_URL =
  'https://raw.githubusercontent.com/electricitymaps/electricitymaps-contrib/master/geo/world.geojson';

const main = async () => {
  const target = join(repoRoot, 'geo', 'src', 'world.geojson');
  mkdirSync(dirname(target), { recursive: true });

  process.stderr.write(`fetching ${SOURCE_URL}\n`);
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`source returned HTTP ${response.status}`);
  }
  const text = await response.text();
  writeFileSync(target, text, 'utf8');

  const parsed = JSON.parse(text);
  process.stderr.write(
    `wrote ${target} (${(text.length / 1024 / 1024).toFixed(1)} MB, ` +
      `${parsed.features.length} features)\n`,
  );
};

await main();
