/**
 * Configuration loading and validation.
 *
 * These cases mirror `workers/tests/test_config.py`. The API and the workers read the
 * same files, so a rule enforced on one side must be enforced on the other, and both
 * suites assert the same messages.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  inMapZones,
  loadConfig,
  loadModes,
  loadZones,
  sourceById,
  zoneByKey,
  zoneByRespondent,
} from '../src/config/index.js';

const VALID_ZONE = {
  key: 'US-TEX-ERCO',
  eia_respondent: 'ERCO',
  name: 'Electric Reliability Council of Texas, Inc.',
  short_name: 'ERCOT',
  interconnection: 'texas',
  timezone: 'America/Chicago',
  type: 'balancing_authority',
  parent: null,
  in_map: true,
  capabilities: {
    demand: true,
    demand_forecast: true,
    net_generation: true,
    fuel_mix: true,
    interchange: true,
  },
} as const;

const VALID_MODES = {
  canonical_modes: ['coal', 'gas', 'hydro', 'wind', 'solar', 'nuclear', 'imports', 'unknown'],
  renewable: ['hydro', 'wind', 'solar'],
  low_carbon: ['hydro', 'wind', 'solar', 'nuclear'],
  excluded_from_mix_percent: ['imports'],
  sources: { eia: { COL: 'coal', NG: 'gas' } },
};

const VALID_SOURCES = [
  {
    id: 'eia',
    label: 'EIA Form 930',
    attribution: 'U.S. Energy Information Administration',
    url: 'https://www.eia.gov/electricity/gridmonitor/',
    license: 'Public domain (U.S. Government work)',
    independent: true,
    notes: 'Hourly.',
    active: true,
  },
];

interface Overrides {
  zones?: unknown;
  excluded?: unknown;
  modes?: unknown;
  sources?: unknown;
}

let dir: string;

/** Write a complete config directory, overriding individual files. */
const writeConfig = (overrides: Overrides = {}): string => {
  const files: Record<string, unknown> = {
    'zones.yaml': overrides.zones ?? [VALID_ZONE],
    'excluded_respondents.yaml': overrides.excluded ?? [],
    'modes.yaml': overrides.modes ?? VALID_MODES,
    'sources.yaml': overrides.sources ?? VALID_SOURCES,
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), stringify(content), 'utf8');
  }
  return dir;
};

const zoneWith = (overrides: Record<string, unknown>) => ({ ...VALID_ZONE, ...overrides });

/** Run `fn` and return the ConfigError it threw, failing the test if it did not throw. */
const configErrorFrom = (fn: () => unknown): ConfigError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('expected a ConfigError, but nothing was thrown');
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grid-config-'));
});

describe('committed configuration', () => {
  it('loads without error', () => {
    const config = loadConfig();
    expect(zoneByRespondent(config.zones, 'ERCO')).toBeDefined();
    expect(config.modes.sources.eia).toBeDefined();
    expect(sourceById(config.sources, 'eia')).toBeDefined();
  });
});

describe('valid configuration', () => {
  it('round trips', () => {
    const config = loadConfig(writeConfig());
    const zone = zoneByKey(config.zones, 'US-TEX-ERCO');
    expect(zone?.capabilities.fuel_mix).toBe(true);
    expect(inMapZones(config.zones)).toHaveLength(1);
  });
});

describe('file-level failures', () => {
  it('names a missing file', () => {
    const error = configErrorFrom(() => loadZones(dir));
    expect(error.message).toContain('zones.yaml');
    expect(error.message).toContain('does not exist');
  });

  it('reports the line of a YAML syntax error', () => {
    writeFileSync(join(dir, 'zones.yaml'), '- key: US-TEX-ERCO\n   bad indent: true\n', 'utf8');
    const error = configErrorFrom(() => loadZones(dir));
    expect(error.message).toContain('zones.yaml');
    expect(error.message).toContain('line');
  });
});

describe('zone registry', () => {
  it('rejects an unknown field', () => {
    writeConfig({ zones: [zoneWith({ colour: 'blue' })] });
    expect(configErrorFrom(() => loadZones(dir)).message).toContain('entry 1');
  });

  it('names the entry and field for a bad enum', () => {
    writeConfig({ zones: [zoneWith({ interconnection: 'atlantic' })] });
    expect(configErrorFrom(() => loadZones(dir)).message).toContain('entry 1.interconnection');
  });

  it('rejects an invalid time zone', () => {
    writeConfig({ zones: [zoneWith({ timezone: 'Mars/Olympus' })] });
    expect(configErrorFrom(() => loadZones(dir)).message).toContain(
      'is not an IANA time zone name',
    );
  });

  it('rejects a duplicate zone key', () => {
    writeConfig({ zones: [VALID_ZONE, zoneWith({ eia_respondent: 'CISO' })] });
    expect(configErrorFrom(() => loadZones(dir)).message).toContain("duplicate key 'US-TEX-ERCO'");
  });

  it('rejects a duplicate respondent', () => {
    writeConfig({ zones: [VALID_ZONE, zoneWith({ key: 'US-CAL-CISO' })] });
    expect(configErrorFrom(() => loadZones(dir)).message).toContain(
      "duplicate eia_respondent 'ERCO'",
    );
  });

  it('rejects an unknown parent', () => {
    writeConfig({ zones: [zoneWith({ parent: 'US-NOWHERE' })] });
    expect(configErrorFrom(() => loadZones(dir)).message).toContain(
      "parent 'US-NOWHERE' is not a zone key",
    );
  });

  it('keeps aggregates off the map', () => {
    writeConfig({
      zones: [
        zoneWith({ key: 'US-US48', eia_respondent: 'US48', type: 'country_total', in_map: true }),
      ],
    });
    expect(configErrorFrom(() => loadZones(dir)).message).toContain(
      "in_map must be false for type 'country_total'",
    );
  });

  it('requires an interconnection for a balancing authority', () => {
    writeConfig({ zones: [zoneWith({ interconnection: null })] });
    expect(configErrorFrom(() => loadZones(dir)).message).toContain(
      'interconnection is required for a balancing_authority',
    );
  });
});

describe('mode configuration', () => {
  it('rejects a facet code mapped to an unknown mode', () => {
    writeConfig({ modes: { ...VALID_MODES, sources: { eia: { XYZ: 'antimatter' } } } });
    expect(configErrorFrom(() => loadModes(dir)).message).toContain(
      "sources.eia.XYZ: 'antimatter' is not in canonical_modes",
    );
  });

  it('requires renewable modes to be canonical', () => {
    writeConfig({ modes: { ...VALID_MODES, renewable: ['hydro', 'tidal'] } });
    expect(configErrorFrom(() => loadModes(dir)).message).toContain(
      "renewable: 'tidal' is not in canonical_modes",
    );
  });

  it('will not exclude a renewable mode from the denominator', () => {
    writeConfig({ modes: { ...VALID_MODES, excluded_from_mix_percent: ['imports', 'solar'] } });
    expect(configErrorFrom(() => loadModes(dir)).message).toContain(
      'renewable and excluded_from_mix_percent overlap',
    );
  });

  it('requires every renewable mode to be low carbon', () => {
    writeConfig({ modes: { ...VALID_MODES, low_carbon: ['nuclear'] } });
    expect(configErrorFrom(() => loadModes(dir)).message).toContain(
      'low_carbon is missing renewable modes',
    );
  });
});

describe('cross-file invariants', () => {
  it('rejects a respondent that is both a zone and excluded', () => {
    writeConfig({ excluded: [{ code: 'ERCO', reason: 'duplicated by mistake' }] });
    expect(configErrorFrom(() => loadConfig(dir)).message).toContain(
      "respondent 'ERCO' is both a zone",
    );
  });

  it('requires a reason for an excluded respondent', () => {
    writeConfig({ excluded: [{ code: 'YAD', reason: '' }] });
    expect(configErrorFrom(() => loadConfig(dir)).message).toContain('entry 1.reason');
  });

  it('requires the eia source to be registered', () => {
    writeConfig({ sources: [{ ...VALID_SOURCES[0], id: 'other' }] });
    expect(configErrorFrom(() => loadConfig(dir)).message).toContain(
      "the 'eia' source must be registered",
    );
  });
});
