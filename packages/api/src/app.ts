/**
 * The read-only JSON API.
 *
 * Assembled here so tests can build an instance against any database without starting
 * a listener.
 */
import cors from '@fastify/cors';
import etag from '@fastify/etag';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig } from './config/index.js';
import type { Env } from './env.js';
import { connect, type Sql } from './lib/db.js';
import { ApiError, errorBody } from './lib/errors.js';
import { analyticsRoutes } from './routes/analytics.js';
import { healthRoutes } from './routes/health.js';
import { mapRoutes } from './routes/map.js';
import { sourceRoutes } from './routes/sources.js';
import { zoneDetailRoutes } from './routes/zone-detail.js';
import { zoneRoutes } from './routes/zones.js';

export const API_PREFIX = '/api/v1';
export const RATE_LIMIT_PER_MINUTE = 60;

export interface BuildOptions {
  env: Env;
  sql?: Sql;
}

export interface BuiltApp {
  app: FastifyInstance;
  sql: Sql;
}

export const buildApp = async ({ env, sql: provided }: BuildOptions): Promise<BuiltApp> => {
  // Configuration is validated before the server accepts anything. An API that cannot
  // trust its registry must not serve it.
  loadConfig();

  const sql = provided ?? connect(env.DATABASE_URL);

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    trustProxy: true,
  });

  // Strong ETags on every response, so a repeat fetch of an unchanged hour is a 304.
  await app.register(etag, { weak: false });

  // Only the public site may call this from a browser. Everything else is welcome to
  // fetch it server-side; CORS is not an access control, just a browser one.
  await app.register(cors, { origin: env.PUBLIC_BASE_URL, methods: ['GET'], maxAge: 3600 });

  await app.register(rateLimit, {
    global: false,
    max: RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    // Behind Cloudflare and nginx the socket address is the proxy, so the forwarded
    // client address is what must be counted.
    keyGenerator: (request) => request.ip,
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send(errorBody(error.code, error.message));
    }
    const fastifyError = error as {
      validation?: unknown;
      message?: string;
      statusCode?: number;
    };

    if (fastifyError.statusCode === 429) {
      return reply
        .code(429)
        .send(
          errorBody(
            'rate_limited',
            `At most ${RATE_LIMIT_PER_MINUTE} requests a minute from one address.`,
          ),
        );
    }

    // A statement that ran past STATEMENT_TIMEOUT_MS. Postgres cancels it and the
    // driver raises 57014; without this it surfaced as a bare 500 and the panel said
    // "an unexpected error occurred", which tells a reader nothing and suggests the
    // site is broken rather than that one range was too much to ask for right now.
    //
    // It is a 503 because it is temporary and worth retrying — the same request
    // usually succeeds a moment later, when whatever was loading the database is done.
    if ((error as { code?: string }).code === '57014') {
      request.log.warn({ url: request.url }, 'statement timeout');
      return reply
        .code(503)
        .send(
          errorBody(
            'timed_out',
            'That range took too long to read. Try a shorter window, or the same one again in a moment.',
          ),
        );
    }

    if (fastifyError.validation) {
      return reply
        .code(400)
        .send(errorBody('bad_request', fastifyError.message ?? 'Invalid request.'));
    }

    // Any other error that names a client-side status is passed through with that
    // status; only genuinely unexpected failures become a 500.
    const status = fastifyError.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply
        .code(status)
        .send(errorBody('bad_request', fastifyError.message ?? 'Invalid request.'));
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send(errorBody('internal_error', 'An unexpected error occurred.'));
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(errorBody('not_found', `No route for ${request.method} ${request.url}`)),
  );

  // Nothing under /api should be indexed: it is data, not pages.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api')) reply.header('X-Robots-Tag', 'noindex');
    return payload;
  });

  await app.register(
    async (instance) => {
      // The limit covers /api as a whole, health included: an unlimited endpoint is
      // an unlimited way to reach the database.
      instance.addHook(
        'onRequest',
        instance.rateLimit({ max: RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' }),
      );
      analyticsRoutes(instance, sql);
      healthRoutes(instance, sql);
      zoneRoutes(instance, sql);
      mapRoutes(instance, sql);
      zoneDetailRoutes(instance, sql);
      sourceRoutes(instance, sql);
    },
    { prefix: API_PREFIX },
  );

  return { app, sql };
};
