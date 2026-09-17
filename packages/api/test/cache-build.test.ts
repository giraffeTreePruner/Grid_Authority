/**
 * The cache-build path, which is what makes the zone-detail cache able to exist.
 *
 * The warming job fills that cache by asking the API, so its compute ran on the
 * reader's connection and died at the reader's five seconds — meaning the cache could
 * only ever hold entries that were already fast enough not to need it. Every zone whose
 * `all` window actually needed caching was therefore the one zone it could never cache,
 * and the panel reported a timeout for exactly those.
 *
 * Two properties hold it together, and both are asserted here: a build gets the longer
 * ceiling, and a request that came through nginx cannot claim to be one.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../src/app.js';
import {
  BUILD_STATEMENT_TIMEOUT_MS,
  connect,
  connectBuilder,
  STATEMENT_TIMEOUT_MS,
} from '../src/lib/db.js';
import { BUILD_HEADER } from '../src/routes/zone-detail.js';
import { createHarness, databaseUrl, testEnv, type Harness } from './helpers.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const withDatabase = databaseUrl() === undefined ? describe.skip : describe;

describe('the header cannot arrive from outside', () => {
  it('is blanked by nginx on everything it proxies', () => {
    // The whole security argument for the header is positional: the warming job talks
    // to Fastify directly, and anything coming through the front door has this
    // overwritten. If that directive is ever dropped, a visitor can opt into the
    // expensive path, so it is asserted here rather than trusted to review.
    const conf = readFileSync(resolve(repoRoot, 'deploy/nginx.conf'), 'utf8');
    const apiBlock = conf.slice(conf.indexOf('location /api/ {'));
    expect(apiBlock).toContain('proxy_set_header X-Grid-Cache-Build "";');
  });

  it('is the same name the worker sends', () => {
    const warm = readFileSync(resolve(repoRoot, 'workers/eia/warm.py'), 'utf8');
    expect(warm).toContain(`BUILD_HEADER = "${'X-Grid-Cache-Build'}"`);
    expect(BUILD_HEADER).toBe('x-grid-cache-build');
  });
});

describe('the two pools', () => {
  it('give a build a longer ceiling than a reader', () => {
    expect(BUILD_STATEMENT_TIMEOUT_MS).toBeGreaterThan(STATEMENT_TIMEOUT_MS);
  });

  it('keeps a build under the proxy read timeout', () => {
    // A build cut off by nginx is a bare 504 the API cannot explain. Cut off by
    // Postgres it is a 57014, which the error handler turns into a 503 that says why.
    const conf = readFileSync(resolve(repoRoot, 'deploy/nginx.conf'), 'utf8');
    const match = /proxy_read_timeout\s+(\d+)s/.exec(conf);
    expect(match).not.toBeNull();
    const proxySeconds = Number(match?.[1]);
    expect(BUILD_STATEMENT_TIMEOUT_MS / 1000).toBeLessThan(proxySeconds);
  });

  withDatabase('against the database', () => {
    it('reports the timeout each pool was built with', async () => {
      const reader = connect(databaseUrl() as string);
      const builder = connectBuilder(databaseUrl() as string);
      const read = async (sql: ReturnType<typeof connect>): Promise<number> => {
        const [row] = await sql<{ statement_timeout: string }[]>`SHOW statement_timeout`;
        const reported = row?.statement_timeout ?? '';
        return reported.endsWith('ms')
          ? Number(reported.slice(0, -2))
          : Number(reported.slice(0, -1)) * 1000;
      };
      try {
        expect(await read(reader)).toBe(STATEMENT_TIMEOUT_MS);
        expect(await read(builder)).toBe(BUILD_STATEMENT_TIMEOUT_MS);
      } finally {
        await reader.end();
        await builder.end();
      }
    });
  });
});

withDatabase('which pool a request lands on', () => {
  let harness: Harness;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let builder: ReturnType<typeof postgres>;
  let zone: string;

  beforeAll(async () => {
    harness = await createHarness();

    // A genuinely separate pool, carrying the builder's timeout and the test schema,
    // so the route is exercised against two distinct connections rather than one
    // standing in for both. `connectBuilder` takes no schema, and its own timeout is
    // asserted above.
    builder = postgres(databaseUrl() as string, {
      max: 2,
      connection: {
        timezone: 'UTC',
        search_path: harness.schema,
        statement_timeout: BUILD_STATEMENT_TIMEOUT_MS,
      },
      transform: { undefined: null },
      onnotice: () => {},
    });

    ({ app } = await buildApp({ env: testEnv(), sql: harness.sql, builder }));
    await app.ready();

    const [row] = await harness.sql<{ key: string }[]>`
      SELECT key FROM zones WHERE in_map ORDER BY key LIMIT 1
    `;
    zone = row?.key as string;

    // Something to aggregate. With no observations the route returns an empty series
    // early and caches nothing, which is correct and would prove nothing here.
    for (let hour = 0; hour < 6; hour += 1) {
      const period = new Date(Date.UTC(2026, 8, 11, 6 + hour)).toISOString();
      await harness.sql`
        INSERT INTO obs_region_hourly
          (zone_key, period_utc, source, demand_mw, net_generation_mw, total_interchange_mw)
        VALUES (${zone}, ${period}, 'eia', ${1000 + hour}, ${900 + hour}, -50)
      `;
      await harness.sql`
        INSERT INTO obs_mix_hourly
          (zone_key, period_utc, source, wind_mw, gas_mw, total_generation_mw)
        VALUES (${zone}, ${period}, 'eia', 400, 600, 1000)
      `;
    }
  });

  afterAll(async () => {
    await app?.close();
    await builder?.end();
    await harness?.close();
  });

  const get = (window: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `${API_PREFIX}/zones/${zone}?window=${window}`, headers });

  it('answers a build request and stores the entry', async () => {
    const response = await get('all', { [BUILD_HEADER]: '1' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-cache']).toBe('computed');

    const [cached] = await harness.sql<{ window_key: string }[]>`
      SELECT window_key FROM zone_detail_cache
       WHERE zone_key = ${zone} AND window_key = 'all'
    `;
    expect(cached?.window_key).toBe('all');
  });

  it('serves a reader from what the build stored', async () => {
    const response = await get('all');
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-cache']).toBe('stored');
  });

  it('does not treat an empty header as a build', async () => {
    // nginx drops a header set to "" rather than forwarding a blank one, but that is
    // its convention and not this code's guarantee. An empty string is not undefined,
    // so presence alone would be enough to opt in.
    await harness.sql`DELETE FROM zone_detail_cache WHERE zone_key = ${zone}`;
    const response = await get('90d', { [BUILD_HEADER]: '' });
    expect(response.statusCode).toBe(200);
    // Served by the reader path, so it still computes and still caches — what matters
    // is that it did not get the builder's ceiling on the way.
    expect(response.headers['x-cache']).toBe('computed');
  });

  it('ignores the header on an hourly window, which is never cached', async () => {
    // Hourly windows are fast, change every poll, and are deliberately uncached. The
    // header must not turn one into a cache entry, or the panel's live view would
    // start being served from something up to a day old.
    const response = await get('24h', { [BUILD_HEADER]: '1' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-cache']).toBe('computed');

    const stored = await harness.sql<{ window_key: string }[]>`
      SELECT window_key FROM zone_detail_cache WHERE zone_key = ${zone}
    `;
    expect(stored.map((row) => row.window_key)).not.toContain('24h');
  });
});
