/**
 * A source label with the age of what it produced.
 *
 * Every figure in this project is shown with where it came from and how old it is. A
 * number without either invites the reader to assume it is authoritative and current.
 */
import { formatAge } from '../lib/format.ts';

export interface SourceBadgeProps {
  label: string;
  latestPeriod: string | null;
  unit?: string;
}

export const SourceBadge = ({ label, latestPeriod, unit }: SourceBadgeProps): JSX.Element => (
  <span
    className="inline-flex items-center gap-1.5 rounded bg-zinc-800/70 px-2 py-0.5 text-[10px] text-zinc-400"
    data-testid="source-badge"
  >
    <span className="font-medium text-zinc-300">{label}</span>
    {unit !== undefined && <span>· {unit}</span>}
    <span aria-hidden="true">·</span>
    <span>{formatAge(latestPeriod)}</span>
  </span>
);
