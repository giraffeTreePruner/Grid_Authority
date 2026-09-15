/**
 * The Grid Authority mark: "GA", carved into blocks.
 *
 * One definition, three uses — the header logo, `public/favicon.svg`, and the
 * apple-touch icon. The committed SVG is a build artifact of `markSvg()` and a test
 * asserts the two match, so the file on disk cannot drift from the component.
 *
 * Letterforms are rectangles on a 32-unit grid rather than curves. That is the point of
 * the mark — territory divided into blocks, the way the map divides the country — and at
 * 16px a curve is one grey pixel anyway.
 *
 * Colours are the demand map's own sequential ramp, banded by row so the pair reads as
 * one object lit from above rather than as nine unrelated pieces.
 */

export interface MarkBlock {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** G, then A. Order matters only for reading the file. */
export const MARK_BLOCKS: MarkBlock[] = [
  { x: 3, y: 6, w: 12, h: 4 }, // G: top bar
  { x: 3, y: 6, w: 4, h: 20 }, // G: left stem
  { x: 3, y: 22, w: 12, h: 4 }, // G: bottom bar
  { x: 11, y: 16, w: 4, h: 10 }, // G: right lower stem
  { x: 9, y: 16, w: 6, h: 4 }, // G: tongue
  { x: 17, y: 6, w: 12, h: 4 }, // A: top bar
  { x: 17, y: 10, w: 4, h: 16 }, // A: left stem
  { x: 25, y: 10, w: 4, h: 16 }, // A: right stem
  { x: 17, y: 15, w: 12, h: 4 }, // A: crossbar
];

/** The app's ground, and the colour of every seam between blocks. */
export const MARK_GROUND = '#0b0e14';

/** Three steps of the map's sequential ramp: bright at the top, falling to dark. */
export const MARK_BANDS = { top: '#c9ecf8', middle: '#3aa6d0', bottom: '#14507e' };

/** Which band a block belongs to, by where it sits on the grid. */
export const bandFor = (block: MarkBlock): string => {
  if (block.y < 11) return MARK_BANDS.top;
  if (block.y < 20) return MARK_BANDS.middle;
  return MARK_BANDS.bottom;
};

/**
 * The mark as a standalone SVG document.
 *
 * `rounded` is false for the apple-touch icon: iOS applies its own mask, and a corner
 * radius underneath it shows as a dark rim inside the rounded square.
 */
export const markSvg = ({ rounded = true }: { rounded?: boolean } = {}): string => {
  const blocks = MARK_BLOCKS.map(
    (block) =>
      `<rect x="${block.x}" y="${block.y}" width="${block.w}" height="${block.h}" ` +
      `fill="${bandFor(block)}" stroke="${MARK_GROUND}" stroke-width="0.9"/>`,
  ).join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">` +
    `<rect width="32" height="32"${rounded ? ' rx="6"' : ''} fill="${MARK_GROUND}"/>` +
    `${blocks}</svg>\n`
  );
};
