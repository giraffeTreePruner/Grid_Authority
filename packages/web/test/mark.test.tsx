/**
 * The mark, and the one thing that can quietly go wrong with it.
 *
 * The header renders it from `mark.ts`; the browser reads `public/favicon.svg` before
 * any of that code runs. Two copies of the same drawing, and nothing but a test stops
 * them diverging the first time someone adjusts a rectangle.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Mark } from '../src/components/Mark.tsx';
import { MARK_BANDS, MARK_BLOCKS, bandFor, markSvg } from '../src/lib/mark.ts';

// vitest runs from the package root, and import.meta.url is not a file URL under jsdom.
const committed = (name: string): string =>
  readFileSync(resolve(process.cwd(), 'public', name), 'utf8');

describe('the mark', () => {
  it('matches the favicon committed to disk', () => {
    // If this fails, regenerate the file rather than editing it: the module is the
    // source and the SVG is its output.
    expect(committed('favicon.svg')).toBe(markSvg());
  });

  it('bands the letters by row, bright at the top', () => {
    // The whole design is that the pair reads as one object lit from above. A block
    // taking its colour from anywhere else breaks that without looking broken.
    expect(bandFor({ x: 3, y: 6, w: 12, h: 4 })).toBe(MARK_BANDS.top);
    expect(bandFor({ x: 17, y: 15, w: 12, h: 4 })).toBe(MARK_BANDS.middle);
    expect(bandFor({ x: 3, y: 22, w: 12, h: 4 })).toBe(MARK_BANDS.bottom);
  });

  it('uses only the map ramp, so the logo and the data agree', () => {
    const ramp = new Set(Object.values(MARK_BANDS));
    for (const block of MARK_BLOCKS) expect(ramp.has(bandFor(block))).toBe(true);
  });

  it('renders every block in the header', () => {
    render(<Mark />);
    // One background plus one rect per block.
    expect(screen.getByTestId('mark').querySelectorAll('rect')).toHaveLength(
      MARK_BLOCKS.length + 1,
    );
  });

  it('is decorative, because the wordmark beside it already names the site', () => {
    render(<Mark />);
    expect(screen.getByTestId('mark')).toHaveAttribute('aria-hidden', 'true');
  });
});
