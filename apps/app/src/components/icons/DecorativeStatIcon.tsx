import { forwardRef } from 'react';

/**
 * Larger (~28-30px) decorative outline glyphs for the 4-card stat row under
 * the Repo overview header (Figma node 1647:37709, frame "Frame 1597881691"):
 * codepen (Capabilities), file-code-02 (Entry points), bezier-curve-03
 * (Contributors), intersect-square (Codebase age) — confirmed via
 * get_metadata on that frame. Engineered at the same geometry as the raster
 * Figma exports (see StatGlyphIcon's header note on why these are hand-drawn
 * rather than traced), stroke-only per the design language.
 */

const WIREFRAME = '#B7BCC7';
const STROKE = 1.25;

export type DecorativeStat = 'capabilities' | 'entryPoints' | 'contributors' | 'age';

const GLYPHS: Record<DecorativeStat, string> = {
  // codepen: hex outline with inner chevrons
  capabilities: 'M12 3l8 5v8l-8 5-8-5V8zM12 3v9M4 8l8 4 8-4M12 21v-9',
  // file-code-02: document with a code bracket
  entryPoints: 'M7 3h7l4 4v14H7zM14 3v4h4M9.5 13l-2 2 2 2M13.5 13l2 2-2 2',
  // bezier-curve-03: curve with two anchor handles
  contributors: 'M4 18a10 10 0 0 1 16-8M4 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM20 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  // intersect-square: two overlapping rounded squares
  age: 'M4 4h11v11H4zM9 9h11v11H9z',
};

export interface DecorativeStatIconProps {
  stat: DecorativeStat;
  size?: number;
  titleText?: string;
}

export const DecorativeStatIcon = forwardRef<SVGSVGElement, DecorativeStatIconProps>(function DecorativeStatIcon(
  { stat, size = 28, titleText },
  ref,
) {
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label={titleText ?? stat}
    >
      {titleText ? <title>{titleText}</title> : null}
      <path d={GLYPHS[stat]} stroke={WIREFRAME} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
});
