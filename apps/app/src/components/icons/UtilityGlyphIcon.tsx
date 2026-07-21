import { forwardRef } from 'react';

/**
 * Small (14-16px) engineered control glyphs — filter/sort badge icons that
 * repeat across the designed list screens (Figma "Workspace" node 1748:6595,
 * "Frame 1597881679" Tags/Sort badges: tag-03 + switch-horizontal-01;
 * "Flow List" node 2030:31178 mirrors the same Tags/Type/Sort badge
 * pattern). Fixes a real violation found this pass: `RepositoriesSection.tsx`
 * was using a raw 🏷 emoji as the Tags badge's "icon" — the design language
 * is explicit that icons are engineered stroke symbols, never emoji or
 * filled glyphs (LANE-COMMON.md's geometry system).
 */

const WIREFRAME = '#B7BCC7';
const STROKE = 1.25;

export type UtilityGlyph = 'tag' | 'sort';

const GLYPHS: Record<UtilityGlyph, string> = {
  // tag-03: a tag/label shape with a small hole
  tag: 'M12 3h6a2 2 0 0 1 2 2v6l-9 9-8-8 9-9zM17 7.5a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1z',
  // switch-horizontal-01: two opposing arrows for sort/swap
  sort: 'M4 8h13M13 5l4 3-4 3M20 16H7M11 13l-4 3 4 3',
};

export interface UtilityGlyphIconProps {
  glyph: UtilityGlyph;
  size?: number;
  titleText?: string;
}

export const UtilityGlyphIcon = forwardRef<SVGSVGElement, UtilityGlyphIconProps>(function UtilityGlyphIcon(
  { glyph, size = 14, titleText },
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
      aria-label={titleText ?? glyph}
    >
      {titleText ? <title>{titleText}</title> : null}
      <path
        d={GLYPHS[glyph]}
        stroke={WIREFRAME}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill={glyph === 'tag' ? 'none' : undefined}
      />
    </svg>
  );
});
