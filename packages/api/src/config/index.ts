/**
 * Loading and validation of the YAML contracts in `config/`.
 *
 * All configuration is read once at startup. Invalid configuration is a fatal error,
 * never a warning: an API that cannot trust its configuration must not serve data.
 */
import { ConfigError } from './errors.js';
import { configPath, loadFile } from './load.js';
import {
  excludedRespondentsSchema,
  modesConfigSchema,
  sourcesConfigSchema,
  zoneRegistrySchema,
  type ExcludedRespondents,
  type ModesConfig,
  type Source,
  type SourcesConfig,
  type Zone,
  type ZoneRegistry,
} from './schemas.js';

export const ZONES_FILE = 'zones.yaml';
export const EXCLUDED_FILE = 'excluded_respondents.yaml';
export const MODES_FILE = 'modes.yaml';
export const SOURCES_FILE = 'sources.yaml';

/** Every config file, validated together. */
export interface AppConfig {
  readonly zones: ZoneRegistry;
  readonly excludedRespondents: ExcludedRespondents;
  readonly modes: ModesConfig;
  readonly sources: SourcesConfig;
}

export const loadZones = (directory?: string): ZoneRegistry =>
  loadFile(configPath(ZONES_FILE, directory), zoneRegistrySchema);

export const loadExcludedRespondents = (directory?: string): ExcludedRespondents =>
  loadFile(configPath(EXCLUDED_FILE, directory), excludedRespondentsSchema);

export const loadModes = (directory?: string): ModesConfig =>
  loadFile(configPath(MODES_FILE, directory), modesConfigSchema);

export const loadSources = (directory?: string): SourcesConfig =>
  loadFile(configPath(SOURCES_FILE, directory), sourcesConfigSchema);

/**
 * Load and validate every config file.
 *
 * Cross-file invariants are checked here: a respondent may not be both a zone and an
 * excluded respondent, and the `eia` source must have a mode mapping.
 */
export const loadConfig = (directory?: string): AppConfig => {
  const zones = loadZones(directory);
  const excludedRespondents = loadExcludedRespondents(directory);
  const modes = loadModes(directory);
  const sources = loadSources(directory);

  const excludedCodes = new Set(excludedRespondents.map((entry) => entry.code));
  const overlap = zones
    .map((zone) => zone.eia_respondent)
    .filter((code) => excludedCodes.has(code))
    .sort();
  if (overlap.length > 0) {
    throw new ConfigError(
      configPath(EXCLUDED_FILE, directory),
      overlap.map(
        (code) =>
          `respondent '${code}' is both a zone in ${ZONES_FILE} and excluded here; ` +
          'it must appear in exactly one',
      ),
    );
  }

  if (modes.sources.eia === undefined) {
    throw new ConfigError(configPath(MODES_FILE, directory), [
      "sources.eia: no mapping for the 'eia' source",
    ]);
  }

  return { zones, excludedRespondents, modes, sources };
};

let cached: AppConfig | undefined;

/** Process-wide configuration, loaded on first use. */
export const cachedConfig = (): AppConfig => (cached ??= loadConfig());

/** Reset the process-wide cache. Tests only. */
export const resetConfigCache = (): void => {
  cached = undefined;
};

export const zoneByKey = (zones: ZoneRegistry, key: string): Zone | undefined =>
  zones.find((zone) => zone.key === key);

export const zoneByRespondent = (zones: ZoneRegistry, respondent: string): Zone | undefined =>
  zones.find((zone) => zone.eia_respondent === respondent);

export const inMapZones = (zones: ZoneRegistry): ZoneRegistry =>
  zones.filter((zone) => zone.in_map);

export const sourceById = (sources: SourcesConfig, id: string): Source | undefined =>
  sources.find((source) => source.id === id);

export { ConfigError } from './errors.js';
export { configDir, configPath, loadFile, readYaml, validate } from './load.js';
export type {
  Capabilities,
  ExcludedRespondent,
  ExcludedRespondents,
  Interconnection,
  ModesConfig,
  Source,
  SourcesConfig,
  Zone,
  ZoneRegistry,
  ZoneType,
} from './schemas.js';
