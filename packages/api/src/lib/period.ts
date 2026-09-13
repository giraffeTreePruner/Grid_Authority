/**
 * Parsing and validating the hour parameters the map endpoints take.
 *
 * Every period is an interval-start UTC hour. A request naming anything else is
 * rejected rather than silently rounded, so a client cannot believe it asked for
 * something it did not get.
 */
import { ApiError } from './errors.js';

// Deliberately permissive about precision so that a value which is a valid instant but
// not on the hour reaches the specific check below and gets the specific message.
const INSTANT_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2})(?::(\d{2}))?(?::(\d{2}))?(Z|\+00:00)?$/;

/**
 * The resolutions a window can be requested at, and how many periods of each one
 * request may cover.
 *
 * The caps are not arbitrary: a window response carries one array per zone per period,
 * so the payload grows with the count. Seven days of hours, or two years of days, both
 * land around the same size. Each cap is the point past which a reader should be asking
 * for a coarser resolution instead of a bigger download.
 */
export const RESOLUTIONS = ['hour', 'day', 'week', 'month'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const MAX_PERIODS: Record<Resolution, number> = {
  hour: 7 * 24,
  day: 732, // Two years, so a year-over-year comparison fits in one request.
  week: 261, // Five years.
  month: 120, // Ten years, which outlives the dataset.
};

/** Statistics a coarse period can be read at. Hourly data has only the measurement. */
export const STATISTICS = ['mean', 'peak'] as const;
export type Statistic = (typeof STATISTICS)[number];

/** How long one period of each resolution lasts, for counting a requested range. */
const APPROXIMATE_HOURS: Record<Resolution, number> = {
  hour: 1,
  day: 24,
  week: 24 * 7,
  month: 24 * 30,
};

export const MAX_WINDOW_HOURS = MAX_PERIODS.hour;

/** Validate a resolution name, naming the alternatives rather than just refusing. */
export const parseResolution = (value: string | undefined): Resolution => {
  if (value === undefined) return 'hour';
  if ((RESOLUTIONS as readonly string[]).includes(value)) return value as Resolution;
  throw ApiError.badRequest(`resolution must be one of ${RESOLUTIONS.join(', ')}, got "${value}"`);
};

/** Validate a statistic name. Only meaningful at a coarse resolution. */
export const parseStatistic = (value: string | undefined, resolution: Resolution): Statistic => {
  if (value === undefined) return 'mean';
  if (!(STATISTICS as readonly string[]).includes(value)) {
    throw ApiError.badRequest(`statistic must be one of ${STATISTICS.join(', ')}, got "${value}"`);
  }
  if (resolution === 'hour' && value !== 'mean') {
    throw ApiError.badRequest(
      'statistic applies only to day, week and month resolutions: an hour has a ' +
        'measurement, not a summary',
    );
  }
  return value as Statistic;
};

/** Parse an ISO hour, rejecting anything that is not an exact UTC hour. */
export const parseHour = (value: string, field: string): Date => {
  const match = INSTANT_PATTERN.exec(value);
  if (match === null) {
    throw ApiError.badRequest(
      `${field} must be an ISO-8601 UTC hour such as 2026-09-11T14:00:00Z, got "${value}"`,
    );
  }

  const [, day, hour, minute = '00', second = '00'] = match;
  const parsed = new Date(`${day}T${hour}:${minute}:${second}Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw ApiError.badRequest(`${field} is not a valid instant: "${value}"`);
  }
  if (parsed.getUTCMinutes() !== 0 || parsed.getUTCSeconds() !== 0) {
    throw ApiError.badRequest(
      `${field} must be exactly on the hour: an hour labelled 14:00:00Z covers ` +
        `14:00:00 to 14:59:59, so "${value}" is ambiguous`,
    );
  }
  return parsed;
};

/** Validate a requested range against the cap for its resolution. */
export const parseWindow = (
  fromRaw: string,
  toRaw: string,
  resolution: Resolution = 'hour',
): { from: Date; to: Date } => {
  const from = parseHour(fromRaw, 'from');
  const to = parseHour(toRaw, 'to');

  if (to.getTime() < from.getTime()) {
    throw ApiError.badRequest('from must not be later than to');
  }

  const hours = Math.round((to.getTime() - from.getTime()) / 3600_000) + 1;
  const periods = Math.ceil(hours / APPROXIMATE_HOURS[resolution]);
  const cap = MAX_PERIODS[resolution];

  if (periods > cap) {
    throw ApiError.badRequest(
      `at ${resolution} resolution the window may cover at most ${cap} periods, ` +
        `requested about ${periods}. Ask for a coarser resolution to cover longer.`,
    );
  }
  return { from, to };
};

/** Every hour from `from` to `to` inclusive. */
export const hoursBetween = (from: Date, to: Date): Date[] => {
  const hours: Date[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += 3600_000) hours.push(new Date(t));
  return hours;
};
