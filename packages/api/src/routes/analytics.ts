/**
 * Visitor counting, and the endpoint that reports it.
 *
 * `POST /hit` records one page view. `GET /stats` returns the counts the unlisted page
 * draws. Both live under the normal API prefix, so both are rate limited like anything
 * else.
 *
 * A visitor is identified as `sha256(day salt || ip || user agent)`. The salt is random
 * per UTC day and deleted after eight, so the raw address is never stored, the same
 * person is one identity within a day and a different one tomorrow, and once a salt is
 * gone nobody can re-derive that day's hashes — including whoever runs the server.
 *
 * What that costs, stated because the numbers have to be read correctly: there is no
 * true all-time unique visitor count. Counting one person across months needs a stable
 * identifier, which is exactly what is being refused. Weekly and all-time visitor
 * figures are sums of daily uniques, so a reader who comes back on five days counts
 * five times. The page says so rather than letting the number imply otherwise.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../lib/db.js';
import { ApiError } from '../lib/errors.js';
import { buildMeta, latestDataPeriod } from '../lib/meta.js';

/** Days a salt is kept. Long enough to fix a bug, short enough to mean something. */
export const SALT_RETENTION_DAYS = 8;

/** Paths the app actually has. An unknown path is a typo or someone poking at it. */
export const KNOWN_PATHS = ['/', '/about/data', '/stats'] as const;

interface DailyRow {
  day: string;
  views: string;
  visitors: string;
}

/**
 * The salt for a UTC day, created on first use.
 *
 * `ON CONFLICT DO NOTHING` then re-select, so two requests arriving in the same instant
 * cannot produce two salts and split a day's visitors into two populations.
 */
const saltFor = async (sql: Sql, day: string): Promise<string> => {
  const existing = await sql<{ salt: string }[]>`SELECT salt FROM visitor_salt WHERE day = ${day}`;
  if (existing[0] !== undefined) return existing[0].salt;

  const fresh = randomBytes(32).toString('hex');
  await sql`
    INSERT INTO visitor_salt (day, salt) VALUES (${day}, ${fresh}) ON CONFLICT (day) DO NOTHING
  `;
  // Pruned here rather than on a schedule: a new salt is made once a day, which is
  // exactly how often this needs doing, and it keeps the retention promise next to the
  // thing it is a promise about.
  await sql`
    DELETE FROM visitor_salt WHERE day < (${day}::date - ${SALT_RETENTION_DAYS}::integer)
  `;

  const settled = await sql<{ salt: string }[]>`SELECT salt FROM visitor_salt WHERE day = ${day}`;
  if (settled[0] === undefined) throw ApiError.unavailable('could not establish a salt for today');
  return settled[0].salt;
};

export const visitorHash = (salt: string, ip: string, userAgent: string): string =>
  createHash('sha256').update(`${salt}|${ip}|${userAgent}`).digest('hex').slice(0, 32);

/** Today in UTC, as a date string. The whole scheme is keyed on UTC days. */
export const utcDay = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

export const analyticsRoutes = (app: FastifyInstance, sql: Sql): void => {
  app.post<{ Body: { path?: string } }>('/hit', async (request, reply) => {
    const path = request.body?.path;
    if (typeof path !== 'string' || !(KNOWN_PATHS as readonly string[]).includes(path)) {
      throw ApiError.badRequest(`path must be one of ${KNOWN_PATHS.join(', ')}`);
    }

    const day = utcDay();
    const salt = await saltFor(sql, day);
    const visitor = visitorHash(salt, request.ip, request.headers['user-agent'] ?? '');

    await sql`
      INSERT INTO page_hit (day, path, visitor) VALUES (${day}, ${path}, ${visitor})
    `;

    // Nothing to say back. The beacon does not read a response and a body would only
    // be something for a client to depend on.
    return reply.code(204).send();
  });

  app.get('/stats', async (_request, reply) => {
    const rows = await sql<DailyRow[]>`
      SELECT day::text AS day, count(*)::text AS views, count(DISTINCT visitor)::text AS visitors
        FROM page_hit
       GROUP BY day
       ORDER BY day DESC
    `;

    const today = utcDay();
    const weekStart = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);

    const sum = (from: DailyRow[], field: 'views' | 'visitors'): number =>
      from.reduce((total, row) => total + Number(row[field]), 0);

    const todayRows = rows.filter((row) => row.day === today);
    const weekRows = rows.filter((row) => row.day >= weekStart);

    const latest = await latestDataPeriod(sql);
    reply.header('Cache-Control', 'no-store');
    return reply.send({
      // Page views are exact at every span: they are just a count of rows.
      views: {
        today: sum(todayRows, 'views'),
        week: sum(weekRows, 'views'),
        all: sum(rows, 'views'),
      },
      // Visitors are exact for a single day only. Wider spans sum daily uniques, so a
      // reader returning on five days is counted five times. `visitors_note` carries
      // that caveat to whatever renders this, so it cannot be dropped by accident.
      visitors: {
        today: sum(todayRows, 'visitors'),
        week: sum(weekRows, 'visitors'),
        all: sum(rows, 'visitors'),
      },
      visitors_note:
        'Unique per day. Weekly and all-time are sums of daily uniques, so a returning ' +
        'reader counts once per day they visit — identities rotate daily by design.',
      daily: rows
        .slice(0, 30)
        .map((row) => ({ day: row.day, views: Number(row.views), visitors: Number(row.visitors) })),
      // Filled in when a Cloudflare token is configured; null until then, and the page
      // says "not configured" rather than showing a zero that looks like no traffic.
      cloudflare: null,
      meta: buildMeta(latest),
    });
  });
};
