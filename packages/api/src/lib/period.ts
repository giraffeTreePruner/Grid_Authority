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

export const MAX_WINDOW_HOURS = 7 * 24;

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

/** Validate a requested range, enforcing the seven-day cap. */
export const parseWindow = (fromRaw: string, toRaw: string): { from: Date; to: Date } => {
  const from = parseHour(fromRaw, 'from');
  const to = parseHour(toRaw, 'to');

  if (to.getTime() < from.getTime()) {
    throw ApiError.badRequest('from must not be later than to');
  }

  const hours = Math.round((to.getTime() - from.getTime()) / 3600_000) + 1;
  if (hours > MAX_WINDOW_HOURS) {
    throw ApiError.badRequest(
      `the window may cover at most ${MAX_WINDOW_HOURS} hours (7 days), requested ${hours}`,
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
