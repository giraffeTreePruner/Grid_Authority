/**
 * Bundle budgets, enforced at build time.
 *
 * §10: initial JS at most 200 KB gzipped excluding MapLibre, and the geometry artifact
 * at most 600 KB. MapLibre is excluded because it is a fixed cost of drawing a map at
 * all; what this guards is the application code growing without anyone noticing.
 */
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, 'dist', 'assets');

export const APP_JS_BUDGET = 200 * 1024;
export const GEOMETRY_BUDGET = 600 * 1024;

/** MapLibre is its own chunk and is measured, but not counted against the app budget. */
const isVendorMap = (name) => name.startsWith('maplibre-');

const main = () => {
  const files = readdirSync(assets).filter((name) => name.endsWith('.js'));
  if (files.length === 0) throw new Error('no JS assets found; run the build first');

  let appBytes = 0;
  let vendorBytes = 0;

  for (const name of files) {
    const gzipped = gzipSync(readFileSync(join(assets, name))).length;
    if (isVendorMap(name)) vendorBytes += gzipped;
    else appBytes += gzipped;
    process.stderr.write(`  ${name.padEnd(36)} ${(gzipped / 1024).toFixed(1)} KB gzipped\n`);
  }

  const geometry = statSync(join(here, '..', '..', 'geo', 'zones.pmtiles')).size;

  const problems = [];
  if (appBytes > APP_JS_BUDGET) {
    problems.push(
      `application JS is ${(appBytes / 1024).toFixed(1)} KB gzipped, over the ` +
        `${APP_JS_BUDGET / 1024} KB budget`,
    );
  }
  if (geometry > GEOMETRY_BUDGET) {
    problems.push(
      `geometry is ${(geometry / 1024).toFixed(1)} KB, over the ${GEOMETRY_BUDGET / 1024} KB budget`,
    );
  }

  process.stderr.write(
    `\napplication JS ${(appBytes / 1024).toFixed(1)} KB of ${APP_JS_BUDGET / 1024} KB` +
      ` · MapLibre ${(vendorBytes / 1024).toFixed(1)} KB (excluded)` +
      ` · geometry ${(geometry / 1024).toFixed(1)} KB of ${GEOMETRY_BUDGET / 1024} KB\n`,
  );

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    process.exit(1);
  }
  process.stderr.write('within budget\n');
};

main();
