/**
 * Configuration errors.
 *
 * Configuration is validated once, at startup, and an invalid file is always fatal.
 * Every message names the file and the field so the fix is obvious from the error alone.
 */
export class ConfigError extends Error {
  readonly path: string;
  readonly problems: readonly string[];

  constructor(path: string, problems: readonly string[]) {
    const detail = problems.map((problem) => `  - ${problem}`).join('\n');
    super(`${path} is invalid:\n${detail}`);
    this.name = 'ConfigError';
    this.path = path;
    this.problems = problems;
  }
}
