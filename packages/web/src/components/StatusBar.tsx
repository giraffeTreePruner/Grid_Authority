/**
 * How current the data is, and whether anything is wrong.
 *
 * A number with no age attached invites the assumption that it is current, so the age
 * is always on screen. When the newest data is more than three hours old the API says
 * so in `meta.stale`, and that is surfaced as a banner rather than left to inference.
 *
 * The staleness banner can be dismissed, because on a phone in landscape it is a
 * permanent 32px band across a 375px screen and EIA runs hours behind most of the time,
 * so it is nearly always on. Dismissing it does not take the age off the screen: the
 * slider readout carries the period and how long ago it was, which is what the rule
 * above is actually about.
 *
 * It lasts for the page load and no longer. Remembering it across visits would mean a
 * reader who dismissed it once could never again be told the data is behind, and on a
 * site whose whole claim is honesty about its data that is the wrong default.
 */
import { useState } from 'react';
import { formatAge } from '../lib/format.ts';
import type { Meta } from '../api/types.ts';

export interface StatusBarProps {
  meta: Meta | null;
  error: string | null;
  onRetry?: () => void;
}

export const StatusBar = ({ meta, error, onRetry }: StatusBarProps): JSX.Element | null => {
  const [staleDismissed, setStaleDismissed] = useState(false);

  if (error !== null) {
    return (
      <div
        role="alert"
        className="flex items-center gap-3 bg-red-950 px-4 py-2 text-xs text-red-100"
        data-testid="status-error"
      >
        <span className="font-medium">The API could not be reached.</span>
        <span className="text-red-200/80">{error}</span>
        {onRetry !== undefined && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded bg-red-900 px-2 py-0.5 hover:bg-red-800"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (meta === null) {
    return (
      <div className="px-4 py-2 text-xs text-zinc-500 short:py-0.5" data-testid="status-loading">
        Loading…
      </div>
    );
  }

  const age = formatAge(meta.data_latest_period);
  const hoursBehind =
    meta.data_latest_period === null
      ? null
      : Math.floor((Date.now() - new Date(meta.data_latest_period).getTime()) / 3600_000);

  if (meta.stale) {
    if (staleDismissed) return null;
    return (
      <div
        role="status"
        className="flex items-center gap-2 bg-amber-950 px-4 py-2 text-xs text-amber-100 short:py-1"
        data-testid="status-stale"
      >
        <span className="font-medium">
          EIA data is {hoursBehind === null ? 'unavailable' : `${hoursBehind} hours behind`}
        </span>
        {/* Dropped where height is scarce, not just where width is. The headline says
            the data is behind, which is the part that changes what a reader believes;
            the sentence explaining it is what stops the notice sharing a row with the
            resolution buttons, and a second row costs more than the sentence is worth
            on a 375px-tall screen. */}
        <span className="hidden text-amber-200/80 sm:inline short:!hidden">
          The map shows the newest hour published, not the current hour.
        </span>
        <button
          type="button"
          onClick={() => setStaleDismissed(true)}
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-amber-200/70 hover:bg-amber-900 hover:text-amber-100"
          aria-label="Dismiss the staleness notice"
          data-testid="dismiss-stale"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-2 px-4 py-2 text-xs text-zinc-500 short:py-0.5"
      data-testid="status-ok"
    >
      <span>Newest hour {age}</span>
      <span aria-hidden="true">·</span>
      <span>Source: EIA Form 930</span>
    </div>
  );
};
