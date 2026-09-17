/**
 * Visitor counting, end to end.
 *
 * The case that matters is the one a real browser makes. `navigator.sendBeacon` cannot
 * set a content type freely, so the beacon sends `text/plain` to avoid a CORS preflight,
 * and the body is a JSON string inside a plain-text request. Nothing in this suite may
 * assume `application/json`, because almost no visitor sends it.
 */
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../src/app.js';
import { createHarness, databaseUrl, testEnv, type Harness } from './helpers.js';

const withDatabase = databaseUrl() === undefined ? describe.skip : describe;

withDatabase('POST /hit', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  /** What the browser beacon actually sends: a JSON body typed as plain text. */
  const beacon = (path: string) =>
    harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/hit`,
      headers: { 'content-type': 'text/plain', 'user-agent': 'test-agent' },
      payload: JSON.stringify({ path }),
    });

  /** What the fetch fallback sends, for the minority of browsers that take it. */
  const jsonHit = (path: string) =>
    harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/hit`,
      headers: { 'content-type': 'application/json', 'user-agent': 'test-agent' },
      payload: { path },
    });

  const statsBody = async () => {
    const response = await harness.app.inject({ method: 'GET', url: `${API_PREFIX}/stats` });
    expect(response.statusCode).toBe(200);
    return response.json();
  };

  it('records a hit sent as text/plain, the way the beacon sends it', async () => {
    const response = await beacon('/');
    expect(response.statusCode).toBe(204);
  });

  it('records a hit sent as application/json, the way the fallback sends it', async () => {
    const response = await jsonHit('/about/data');
    expect(response.statusCode).toBe(204);
  });

  it('counts what it recorded', async () => {
    const before = await statsBody();
    await beacon('/stats');
    const after = await statsBody();
    expect(after.views.today).toBe(before.views.today + 1);
    expect(after.views.all).toBe(before.views.all + 1);
  });

  it('counts one visitor once across several views in a day', async () => {
    const before = await statsBody();
    await beacon('/');
    await beacon('/');
    const after = await statsBody();
    expect(after.views.today).toBe(before.views.today + 2);
    // Same address and user agent, so the same per-day pseudonym.
    expect(after.visitors.today).toBe(before.visitors.today);
  });

  it('rejects an unknown path', async () => {
    const response = await beacon('/wp-login.php');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/path must be one of/);
  });

  it('rejects a body that is not an object', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/hit`,
      headers: { 'content-type': 'text/plain' },
      payload: 'not json at all',
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an empty body', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/hit`,
      headers: { 'content-type': 'text/plain' },
      payload: '',
    });
    expect(response.statusCode).toBe(400);
  });
});

/**
 * The same endpoint, under the privileges production actually grants.
 *
 * `0007_analytics.up.sql` gives the API role `SELECT, INSERT` on the analytics tables and
 * nothing more, on purpose: a bug in the API then cannot rewrite or destroy a record it
 * has already written. The suite above runs as the owner, so it cannot see a statement
 * the API is not allowed to issue — and one was there for months. The route used to prune
 * old salts with a `DELETE`, which failed on permissions, so the first hit of every UTC
 * day died with a 500 and salts were never pruned at all.
 *
 * This binds the app to a role granted exactly what the migration grants, so any
 * statement the API is not entitled to issue fails here rather than in production.
 */
withDatabase('POST /hit under the API role', () => {
  let harness: Harness;
  let restricted: ReturnType<typeof postgres> | undefined;
  let app: Awaited<ReturnType<typeof buildApp>>['app'] | undefined;
  let role: string | undefined;

  beforeAll(async () => {
    harness = await createHarness();

    role = `apirole_${randomBytes(5).toString('hex')}`;
    const password = randomBytes(12).toString('hex');

    // Mirrors the runbook: SELECT on everything, INSERT on the two analytics tables.
    await harness.sql.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    await harness.sql.unsafe(`GRANT USAGE ON SCHEMA "${harness.schema}" TO "${role}"`);
    await harness.sql.unsafe(
      `GRANT SELECT ON ALL TABLES IN SCHEMA "${harness.schema}" TO "${role}"`,
    );
    await harness.sql.unsafe(`GRANT SELECT, INSERT ON page_hit TO "${role}"`);
    await harness.sql.unsafe(`GRANT SELECT, INSERT ON visitor_salt TO "${role}"`);

    const url = new URL(databaseUrl() as string);
    url.username = role;
    url.password = password;
    restricted = postgres(url.toString(), {
      max: 2,
      connection: { timezone: 'UTC', search_path: harness.schema },
      transform: { undefined: null },
      onnotice: () => {},
    });

    ({ app } = await buildApp({ env: testEnv(), sql: restricted }));
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await restricted?.end();
    // The schema goes first. While it exists the role holds grants on its tables, and
    // a role with dependent objects cannot be dropped.
    await harness?.close();
    if (role !== undefined) {
      const admin = postgres(databaseUrl() as string, { max: 1, onnotice: () => {} });
      await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  });

  it('records the first hit of the day, which needs a salt created', async () => {
    // The schema is fresh, so there is no salt yet: this request is the one that has to
    // create it, and it is the request that used to fail.
    const response = await (app as NonNullable<typeof app>).inject({
      method: 'POST',
      url: `${API_PREFIX}/hit`,
      headers: { 'content-type': 'text/plain', 'user-agent': 'restricted-agent' },
      payload: JSON.stringify({ path: '/' }),
    });
    expect(response.statusCode).toBe(204);
  });

  it('records a second hit, which reuses the salt', async () => {
    const response = await (app as NonNullable<typeof app>).inject({
      method: 'POST',
      url: `${API_PREFIX}/hit`,
      headers: { 'content-type': 'text/plain', 'user-agent': 'restricted-agent' },
      payload: JSON.stringify({ path: '/stats' }),
    });
    expect(response.statusCode).toBe(204);
  });

  it('reports both of them', async () => {
    const response = await (app as NonNullable<typeof app>).inject({
      method: 'GET',
      url: `${API_PREFIX}/stats`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().views.today).toBe(2);
    expect(response.json().visitors.today).toBe(1);
  });

  it('still cannot delete a hit it recorded', async () => {
    // The promise the grant exists for. If this ever succeeds, the migration's claim
    // that the API cannot destroy a record is no longer true.
    await expect(
      (restricted as NonNullable<typeof restricted>)`DELETE FROM page_hit`,
    ).rejects.toThrow(/permission denied/i);
  });
});
