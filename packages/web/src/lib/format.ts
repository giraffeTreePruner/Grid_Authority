/**
 * Presenting instants and ages.
 *
 * Times are shown in the viewer's own zone, because that is the clock they are reading
 * from, with UTC alongside where precision matters. Storage and the API remain UTC
 * throughout; this is display only.
 */
import { format, formatDistanceToNowStrict } from 'date-fns';

export const parseInstant = (iso: string): Date => new Date(iso);

/** A short local label for an hour, for the slider and tooltips. */
export const formatHour = (iso: string): string => format(parseInstant(iso), 'EEE d MMM, HH:mm');

/** The same hour in UTC, since that is the label the data actually carries. */
export const formatHourUtc = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')}Z`;

export const formatDay = (iso: string): string => format(parseInstant(iso), 'EEE d MMM');

/**
 * How old a measurement is, in words.
 *
 * The data age is a first-class part of every reading in this project: a number with no
 * age attached invites the assumption that it is current.
 */
export const formatAge = (iso: string | null): string => {
  if (iso === null) return 'no data';
  return `${formatDistanceToNowStrict(parseInstant(iso))} ago`;
};

export const formatHoursBehind = (hours: number): string => {
  if (hours <= 0) return 'latest hour';
  if (hours === 1) return '1 hour earlier';
  if (hours < HOURS_IN_DAY) return `${hours} hours earlier`;
  const days = Math.floor(hours / HOURS_IN_DAY);
  const remainder = hours % HOURS_IN_DAY;
  const dayPart = days === 1 ? '1 day' : `${days} days`;
  return remainder === 0 ? `${dayPart} earlier` : `${dayPart} ${remainder}h earlier`;
};

const HOURS_IN_DAY = 24;
