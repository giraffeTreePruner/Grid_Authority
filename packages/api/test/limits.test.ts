/**
 * Rate limiting, CORS, robots and the statement timeout.
 *
 * These are the protections that have to be on in production, so the tests assert they
 * are on rather than that they are configured.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX, RATE_LIMIT_PER_MINUTE } from '../src/app.js';
import { connect, STATEMENT_TIMEOUT_MS } from '../src/lib/db.js';
import { createHarness, databaseUrl, testEnv, type Harness } from './helpers.js';

const withDatabase = databaseUrl() === undefined ? describe.skip : describe;

withDatabase('limits and headers', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    harness.app.inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers });

  describe('rate limiting', () => {
    it('allows the first sixty requests and refuses the sixty-first', async () => {
      const ip = '203.0.113.10';
      const headers = { 'x-forwarded-for': ip };

      let lastAllowed = 0;
      for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i += 1) {
        lastAllowed = (await get('/zones', headers)).statusCode;
      }
      expect(lastAllowed).toBe(200);

      const refused = await get('/zones', headers);
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['retry-after']).toBeDefined();
      expect(refused.json().error.code).toBe('rate_limited');
    });

    it('counts each client separately', async () => {
      const response = await get('/zones', { 'x-forwarded-for': '203.0.113.99' });
      expect(response.statusCode).toBe(200);
    });

    it('advertises the limit in headers', async () => {
      const response = await get('/zones', { 'x-forwarded-for': '203.0.113.50' });
      expect(response.headers['x-ratelimit-limit']).toBe(String(RATE_LIMIT_PER_MINUTE));
      expect(Number(response.headers['x-ratelimit-remaining'])).toBeLessThan(RATE_LIMIT_PER_MINUTE);
    });

    it('covers health too, since it also reaches the database', async () => {
      const response = await get('/health', { 'x-forwarded-for': '203.0.113.77' });
      expect(response.headers['x-ratelimit-limit']).toBe(String(RATE_LIMIT_PER_MINUTE));
    });
  });

  describe('CORS', () => {
    it('allows the public site', async () => {
      const response = await get('/zones', {
        origin: testEnv().PUBLIC_BASE_URL,
        'x-forwarded-for': '203.0.113.20',
      });
      expect(response.headers['access-control-allow-origin']).toBe(testEnv().PUBLIC_BASE_URL);
    });

    it('never reflects the requesting origin back', async () => {
      // A fixed allow-origin is what blocks other sites: the browser compares the
      // header against its own origin and refuses when they differ. Reflecting the
      // request's origin is the mistake that would allow everyone.
      const attacker = 'https://someone-elses-site.example';
      const response = await get('/zones', {
        origin: attacker,
        'x-forwarded-for': '203.0.113.21',
      });
      expect(response.headers['access-control-allow-origin']).not.toBe(attacker);
      expect(response.headers['access-control-allow-origin']).toBe(testEnv().PUBLIC_BASE_URL);
    });

    it('permits only GET', async () => {
      const response = await harness.app.inject({
        method: 'OPTIONS',
        url: `${API_PREFIX}/zones`,
        headers: {
          origin: testEnv().PUBLIC_BASE_URL,
          'access-control-request-method': 'DELETE',
          'x-forwarded-for': '203.0.113.22',
        },
      });
      expect(response.headers['access-control-allow-methods']).toBe('GET');
    });
  });

  describe('robots', () => {
    it('marks every API response noindex', async () => {
      for (const path of ['/zones', '/sources', '/health']) {
        const response = await get(path, { 'x-forwarded-for': '203.0.113.30' });
        expect(response.headers['x-robots-tag']).toBe('noindex');
      }
    });

    it('marks errors noindex as well', async () => {
      const response = await get('/zones/US-NOWHERE', { 'x-forwarded-for': '203.0.113.31' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['x-robots-tag']).toBe('noindex');
    });
  });

  describe('statement timeout', () => {
    it('is set on the connection the API uses', async () => {
      // Asked of a connection built by `connect`, which is what the API runs on. The
      // harness makes its own client without a timeout, so checking that one proved
      // nothing about the product — and `SHOW` returns "0" when none is set, so the
      // previous `toBeDefined()` passed whether the feature existed or not.
      const sql = connect(databaseUrl() as string);
      try {
        const [row] = await sql<{ statement_timeout: string }[]>`SHOW statement_timeout`;
        // Postgres reports it in its own units: "5s" for 5000ms, "500ms" below a second.
        const reported = row?.statement_timeout ?? '';
        const milliseconds = reported.endsWith('ms')
          ? Number(reported.slice(0, -2))
          : Number(reported.slice(0, -1)) * 1000;
        expect(milliseconds).toBe(STATEMENT_TIMEOUT_MS);
      } finally {
        await sql.end();
      }
    });

    it('cancels a query that runs too long', async () => {
      const guarded = harness.sql;
      await expect(
        guarded`SET LOCAL statement_timeout = 50; SELECT pg_sleep(1)`.simple(),
      ).rejects.toThrow(/statement timeout|canceling/i);
    });
  });
});
