/**
 * Schemas for the YAML contracts in `config/`.
 *
 * These mirror the pydantic models in `workers/config/models.py`. The two languages
 * read the same files, so a rule enforced in one must be enforced in the other;
 * the shared test fixtures in `packages/api/test/config.test.ts` and
 * `workers/tests/test_config.py` cover the same cases on both sides.
 *
 * Objects are strict: an unknown key is an error rather than a silently ignored
 * field, so a typo cannot quietly disable a capability.
 */
import { z } from 'zod';

const ZONE_KEY_PATTERN = /^[A-Z0-9]+(-[A-Z0-9]+)+$/;
const RESPONDENT_PATTERN = /^[A-Z0-9-]+$/;
const MODE_PATTERN = /^[a-z][a-z0-9_]*$/;

export const interconnectionSchema = z.enum(['eastern', 'western', 'texas', 'alaska', 'hawaii']);
export const zoneTypeSchema = z.enum(['balancing_authority', 'region', 'country_total']);

export type Interconnection = z.infer<typeof interconnectionSchema>;
export type ZoneType = z.infer<typeof zoneTypeSchema>;

const isIanaTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

export const capabilitiesSchema = z
  .strictObject({
    demand: z.boolean(),
    demand_forecast: z.boolean(),
    net_generation: z.boolean(),
    fuel_mix: z.boolean(),
    interchange: z.boolean(),
  })
  .describe('Which EIA series a zone is expected to publish');

export const zoneSchema = z
  .strictObject({
    key: z
      .string()
      .regex(
        ZONE_KEY_PATTERN,
        "is not a canonical zone key (uppercase segments joined by hyphens, for example 'US-TEX-ERCO')",
      ),
    eia_respondent: z
      .string()
      .regex(RESPONDENT_PATTERN, 'is not a valid EIA respondent code (uppercase, A-Z0-9-)'),
    name: z.string().min(1),
    short_name: z.string().min(1),
    interconnection: interconnectionSchema.nullable(),
    timezone: z.string().refine(isIanaTimeZone, 'is not an IANA time zone name'),
    type: zoneTypeSchema,
    parent: z.string().nullable().default(null),
    in_map: z.boolean(),
    capabilities: capabilitiesSchema,
  })
  .superRefine((zone, ctx) => {
    if (zone.type === 'balancing_authority' && zone.interconnection === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['interconnection'],
        message: 'interconnection is required for a balancing_authority',
      });
    }
    if (zone.type !== 'balancing_authority' && zone.in_map) {
      ctx.addIssue({
        code: 'custom',
        path: ['in_map'],
        message:
          `in_map must be false for type '${zone.type}': aggregates would be ` +
          'double-counted against the balancing authorities they contain',
      });
    }
  });

export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type Zone = z.infer<typeof zoneSchema>;

/** Report each value that appears more than once. */
const duplicates = (label: string, values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const value of values) {
    if (seen.has(value) && !repeated.includes(value)) repeated.push(value);
    seen.add(value);
  }
  return repeated.map((value) => `duplicate ${label} '${value}'`);
};

const addIssues = (ctx: z.RefinementCtx, problems: readonly string[]): void => {
  for (const message of problems) ctx.addIssue({ code: 'custom', message });
};

export const zoneRegistrySchema = z
  .array(zoneSchema)
  .min(1, 'the zone registry is empty')
  .superRefine((zones, ctx) => {
    const problems = [
      ...duplicates(
        'key',
        zones.map((zone) => zone.key),
      ),
      ...duplicates(
        'eia_respondent',
        zones.map((zone) => zone.eia_respondent),
      ),
    ];
    const keys = new Set(zones.map((zone) => zone.key));
    for (const zone of zones) {
      if (zone.parent !== null && !keys.has(zone.parent)) {
        problems.push(`${zone.key}: parent '${zone.parent}' is not a zone key`);
      }
      if (zone.parent === zone.key) {
        problems.push(`${zone.key}: parent refers to itself`);
      }
    }
    addIssues(ctx, problems);
  });

export const excludedRespondentSchema = z.strictObject({
  code: z
    .string()
    .regex(RESPONDENT_PATTERN, 'is not a valid EIA respondent code (uppercase, A-Z0-9-)'),
  reason: z.string().min(1),
});

export type ExcludedRespondent = z.infer<typeof excludedRespondentSchema>;

export const excludedRespondentsSchema = z
  .array(excludedRespondentSchema)
  .superRefine((entries, ctx) => {
    addIssues(
      ctx,
      duplicates(
        'code',
        entries.map((entry) => entry.code),
      ),
    );
  });

export const modesConfigSchema = z
  .strictObject({
    canonical_modes: z
      .array(z.string().regex(MODE_PATTERN, 'is not a valid mode name (lowercase snake_case)'))
      .min(1, 'at least one canonical mode is required'),
    renewable: z.array(z.string()),
    low_carbon: z.array(z.string()),
    excluded_from_mix_percent: z.array(z.string()),
    sources: z.record(z.string(), z.record(z.string(), z.string())),
  })
  .superRefine((modes, ctx) => {
    const canonical = new Set(modes.canonical_modes);
    const problems = duplicates('mode', modes.canonical_modes);

    for (const field of ['renewable', 'low_carbon', 'excluded_from_mix_percent'] as const) {
      const members = modes[field];
      problems.push(...duplicates(`${field} entry`, members));
      for (const mode of members) {
        if (!canonical.has(mode)) problems.push(`${field}: '${mode}' is not in canonical_modes`);
      }
    }

    for (const [source, mapping] of Object.entries(modes.sources)) {
      for (const [code, mode] of Object.entries(mapping)) {
        if (!canonical.has(mode)) {
          problems.push(`sources.${source}.${code}: '${mode}' is not in canonical_modes`);
        }
      }
    }

    const excluded = new Set(modes.excluded_from_mix_percent);
    const overlap = modes.renewable.filter((mode) => excluded.has(mode)).sort();
    if (overlap.length > 0) {
      problems.push(
        `renewable and excluded_from_mix_percent overlap on [${overlap.join(', ')}]: ` +
          'a mode cannot both count as renewable and be excluded from the denominator',
      );
    }

    const lowCarbon = new Set(modes.low_carbon);
    const missing = modes.renewable.filter((mode) => !lowCarbon.has(mode)).sort();
    if (missing.length > 0) {
      problems.push(
        `low_carbon is missing renewable modes [${missing.join(', ')}]: ` +
          'every renewable mode is also low carbon',
      );
    }

    addIssues(ctx, problems);
  });

export type ModesConfig = z.infer<typeof modesConfigSchema>;

export const sourceSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  attribution: z.string().min(1),
  url: z.string().refine((value) => /^https?:\/\//.test(value), 'is not an http(s) URL'),
  license: z.string().min(1),
  independent: z.boolean(),
  notes: z.string().default(''),
  active: z.boolean(),
});

export type Source = z.infer<typeof sourceSchema>;

export const sourcesConfigSchema = z.array(sourceSchema).superRefine((sources, ctx) => {
  const problems = duplicates(
    'id',
    sources.map((source) => source.id),
  );
  if (!sources.some((source) => source.id === 'eia')) {
    problems.push("the 'eia' source must be registered");
  }
  addIssues(ctx, problems);
});

export type ZoneRegistry = z.infer<typeof zoneRegistrySchema>;
export type ExcludedRespondents = z.infer<typeof excludedRespondentsSchema>;
export type SourcesConfig = z.infer<typeof sourcesConfigSchema>;
