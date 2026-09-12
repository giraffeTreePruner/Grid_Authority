/**
 * Environment configuration, validated once at startup.
 *
 * An invalid environment is a fatal startup error. A server that cannot tell which
 * origin it serves, or which database it reads, should not accept a request.
 */
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'is required'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  PUBLIC_BASE_URL: z.string().url('must be a full URL, for example https://grid.example.org'),
  GEOMETRY_VERSION: z.string().default('1'),
});

export type Env = z.infer<typeof schema>;

/** Read and validate the environment, naming every variable that is wrong. */
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const problems = result.error.issues.map(
    (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  throw new Error(`environment is invalid:\n${problems.join('\n')}`);
};
