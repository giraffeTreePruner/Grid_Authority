/**
 * The read-only JSON API.
 *
 * Assembled here so tests can build an instance against any database without starting
 * a listener.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig } from './config/index.js';
import type { Env } from './env.js';
import { connect, type Sql } from './lib/db.js';
import { ApiError, errorBody } from './lib/errors.js';
import { healthRoutes } from './routes/health.js';
import { sourceRoutes } from './routes/sources.js';
import { zoneRoutes } from './routes/zones.js';

export const API_PREFIX = '/api/v1';

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
    disableRequestLogging: env.NODE_ENV === 'test',
    trustProxy: true,
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send(errorBody(error.code, error.message));
    }
    const fastifyError = error as { validation?: unknown; message?: string };
    if (fastifyError.validation) {
      return reply
        .code(400)
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
      healthRoutes(instance, sql);
      zoneRoutes(instance, sql);
      sourceRoutes(instance, sql);
    },
    { prefix: API_PREFIX },
  );

  return { app, sql };
};
