import { forwardRef } from 'react';

const WIREFRAME = '#B7BCC7';
const STROKE = 1.25;

export type UtilityGlyph = 'tag' | 'sort';

const GLYPHS: Record<UtilityGlyph, string> = {

  tag: 'M12 3h6a2 2 0 0 1 2 2v6l-9 9-8-8 9-9zM17 7.5a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1z',

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
