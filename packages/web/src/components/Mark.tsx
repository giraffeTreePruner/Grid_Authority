/**
 * The mark, inline, for the header.
 *
 * Inline rather than an <img>: it is a handful of rectangles, so a request for it would
 * cost more than the markup, and it stays crisp at any size without a second asset.
 *
 * Decorative here — the wordmark beside it already says "Grid Authority" — so it is
 * hidden from assistive technology rather than repeating that in an alt text.
 */
import { MARK_BLOCKS, MARK_GROUND, bandFor } from '../lib/mark.ts';

export interface MarkProps {
  size?: number;
  className?: string;
}

export const Mark = ({ size = 22, className }: MarkProps): JSX.Element => (
  <svg
    viewBox="0 0 32 32"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    focusable="false"
    data-testid="mark"
  >
    <rect width="32" height="32" rx="6" fill={MARK_GROUND} />
    {MARK_BLOCKS.map((block) => (
      <rect
        key={`${block.x}-${block.y}-${block.w}-${block.h}`}
        x={block.x}
        y={block.y}
        width={block.w}
        height={block.h}
        fill={bandFor(block)}
        stroke={MARK_GROUND}
        strokeWidth={0.9}
      />
    ))}
  </svg>
);
