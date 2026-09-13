/**
 * Resolutions the map can be read at, and what one step of the slider means at each.
 *
 * The resolution is explicit rather than inferred from how wide the range is. A step
 * that silently changes meaning as you zoom leaves the reader unable to say what they
 * are looking at, and a screenshot of it unable to say either.
 *
 * Every span here is the API's cap for that resolution, or less. Asking for more is a
 * 400, which is the right answer — the way to see longer is a coarser resolution, not
 * a larger download.
 */
import { format } from 'date-fns';
import { parseInstant } from './format.ts';

export const RESOLUTIONS = ['hour', 'day', 'week', 'month'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const STATISTICS = ['mean', 'peak'] as const;
export type Statistic = (typeof STATISTICS)[number];

export interface ResolutionDefinition {
  id: Resolution;
  /** On the control. */
  label: string;
  /** What one step of the slider covers, for the accessible description. */
  step: string;
  /** How far back the window reaches, in hours. */
  spanHours: number;
  /** A step of PageUp/PageDown, in periods. */
  page: number;
}

const HOUR = 1;
const DAY = 24;

export const RESOLUTION_LIST: ResolutionDefinition[] = [
  { id: 'hour', label: 'Hourly', step: 'hour', spanHours: 7 * DAY, page: DAY },
  // Two years, the API's cap: enough for a year-over-year comparison in one request.
  { id: 'day', label: 'Daily', step: 'day', spanHours: 730 * DAY, page: 7 },
  { id: 'week', label: 'Weekly', step: 'week', spanHours: 260 * 7 * DAY, page: 4 },
  // Ten years outlives EIA-930, which begins in 2019, so this is "everything".
  { id: 'month', label: 'Monthly', step: 'month', spanHours: 119 * 30 * DAY, page: 12 },
];

export const RESOLUTIONS_BY_ID: Record<Resolution, ResolutionDefinition> = Object.fromEntries(
  RESOLUTION_LIST.map((definition) => [definition.id, definition]),
) as Record<Resolution, ResolutionDefinition>;

/** EIA-930 begins here; asking for anything earlier only wastes a request. */
export const EARLIEST_PERIOD = Date.UTC(2019, 0, 1);

/**
 * The range to request for a resolution, ending at the most recent complete hour.
 *
 * Clamped at the start of the dataset: a ten-year month window from 2026 would
 * otherwise ask for six years that do not exist.
 */
export const rangeFor = (
  resolution: Resolution,
  now: Date = new Date(),
): { from: string; to: string } => {
  const end = new Date(now);
  end.setUTCMinutes(0, 0, 0);
  end.setUTCHours(end.getUTCHours() - 1);

  const span = RESOLUTIONS_BY_ID[resolution].spanHours;
  const start = new Date(Math.max(end.getTime() - (span - HOUR) * 3600_000, EARLIEST_PERIOD));

  const iso = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;
  return { from: iso(start), to: iso(end) };
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * A period's label at a given resolution.
 *
 * A month is labelled by its month, not by the midnight that happens to start it:
 * "September 2026" is what the period is, and "1 Sep 2026, 00:00" invites reading a
 * month's mean as one particular hour.
 *
 * Coarse periods are formatted in **UTC**, deliberately, and against the rule that an
 * hour is shown in the viewer's own clock. A day, week or month is a UTC calendar
 * period, not an instant: rendering 2026-09-01T00:00Z in local time labels September as
 * August for every viewer west of Greenwich, and shifts every daily label by one for
 * half the world. An hour is an instant, so it keeps the local clock.
 */
export const formatPeriod = (iso: string, resolution: Resolution): string => {
  const at = parseInstant(iso);
  if (resolution === 'hour') return format(at, 'EEE d MMM, HH:mm');

  const day = at.getUTCDate();
  const month = MONTHS[at.getUTCMonth()]!;
  const year = at.getUTCFullYear();

  switch (resolution) {
    case 'day':
      return `${WEEKDAYS[at.getUTCDay()]!} ${day} ${month.slice(0, 3)} ${year}`;
    case 'week':
      return `Week of ${day} ${month.slice(0, 3)} ${year}`;
    case 'month':
      return `${month} ${year}`;
  }
};

/** How far behind the newest a position sits, in that resolution's own units. */
export const formatPeriodsBehind = (behind: number, resolution: Resolution): string => {
  const { step } = RESOLUTIONS_BY_ID[resolution];
  if (behind <= 0) return `latest ${step}`;
  if (behind === 1) return `1 ${step} earlier`;
  return `${behind} ${step}s earlier`;
};

/**
 * What the statistic means, in words, for the period on screen.
 *
 * Shown wherever a summary is: a reader looking at a month coloured by its peak hour
 * should never have to infer that from the controls.
 */
export const describeStatistic = (statistic: Statistic, resolution: Resolution): string => {
  const { step } = RESOLUTIONS_BY_ID[resolution];
  return statistic === 'mean' ? `average across the ${step}` : `highest hour in the ${step}`;
};
