/**
 * How current the data is, and whether anything is wrong.
 *
 * A number with no age attached invites the assumption that it is current, so the age
 * is always on screen. When the newest data is more than three hours old the API says
 * so in `meta.stale`, and that is surfaced as a banner rather than left to inference.
 */
import { formatAge } from '../lib/format.ts';
import type { Meta } from '../api/types.ts';

export interface StatusBarProps {
  meta: Meta | null;
  error: string | null;
  onRetry?: () => void;
}

export const StatusBar = ({ meta, error, onRetry }: StatusBarProps): JSX.Element => {
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
      <div className="px-4 py-2 text-xs text-zinc-500" data-testid="status-loading">
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
    return (
      <div
        role="status"
        className="flex items-center gap-2 bg-amber-950 px-4 py-2 text-xs text-amber-100"
        data-testid="status-stale"
      >
        <span className="font-medium">
          EIA data is {hoursBehind === null ? 'unavailable' : `${hoursBehind} hours behind`}
        </span>
        <span className="text-amber-200/80">
          The map shows the newest hour published, not the current hour.
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-2 px-4 py-2 text-xs text-zinc-500"
      data-testid="status-ok"
    >
      <span>Newest hour {age}</span>
      <span aria-hidden="true">·</span>
      <span>Source: EIA Form 930</span>
    </div>
  );
};
