/**
 * YAML loading and validation for the files in `config/`.
 *
 * Loaders are deliberately strict. A file that does not match its schema throws
 * {@link ConfigError} naming the file, the offending field path and the reason.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, YAMLParseError } from 'yaml';
import type { z } from 'zod';
import { ConfigError } from './errors.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Repository `config/` directory, resolved from this module's location. */
export const DEFAULT_CONFIG_DIR = resolve(here, '../../../..', 'config');

/**
 * Directory holding the YAML config files.
 *
 * `GRID_CONFIG_DIR` overrides the repository default so tests and alternate
 * deployments can point at another directory.
 */
export const configDir = (): string => process.env.GRID_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;

/** Parse a YAML file, reporting the location of a syntax error. */
export const readYaml = (path: string): unknown => {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ConfigError(path, ['file does not exist']);
    throw new ConfigError(path, [`could not be read: ${(error as Error).message}`]);
  }

  try {
    return parse(text);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const [line, column] = error.linePos?.[0]
        ? [error.linePos[0].line, error.linePos[0].col]
        : [undefined, undefined];
      const where = line === undefined ? '' : `line ${line}, column ${column}: `;
      throw new ConfigError(path, [`${where}${error.message.split('\n')[0]}`]);
    }
    throw new ConfigError(path, ['could not be parsed as YAML']);
  }
};

/**
 * Render a zod issue path as a readable field path.
 *
 * Array indices become `entry N` (1-based) so the path matches how a person counts
 * entries in the file.
 */
const formatPath = (path: readonly PropertyKey[]): string => {
  if (path.length === 0) return '(document root)';
  return path
    .map((part) => (typeof part === 'number' ? `entry ${part + 1}` : String(part)))
    .join('.');
};

/** Validate parsed YAML against a schema, naming every failing field. */
export const validate = <T>(path: string, schema: z.ZodType<T>, data: unknown): T => {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `${formatPath(issue.path)}: ${issue.message}`,
  );
  throw new ConfigError(path, problems);
};

/** Read and validate one config file. */
export const loadFile = <T>(path: string, schema: z.ZodType<T>): T =>
  validate(path, schema, readYaml(path));

/** Resolve a config file name against the active config directory. */
export const configPath = (name: string, directory?: string): string =>
  join(directory ?? configDir(), name);
