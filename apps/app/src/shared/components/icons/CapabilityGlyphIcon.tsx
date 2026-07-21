import { forwardRef } from 'react';

const STROKE = 1.25;

export type CapabilityGlyph = 'coinsSwap' | 'activity' | 'dollarCircle' | 'speedometer' | 'barChart' | 'fileSearch';

const GLYPHS: Record<CapabilityGlyph, string> = {

  coinsSwap: 'M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM16 20a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 16l-2 2 2 2M19 8l2-2-2-2',

  activity: 'M3 12h4l2-7 4 14 2-7h6',

  dollarCircle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v10M15 9.5c0-1.1-1.34-2-3-2s-3 .9-3 2 1.34 1.5 3 1.5 3 .9 3 2-1.34 2-3 2-3-.9-3-2',

  speedometer: 'M4 15a8 8 0 1 1 16 0M12 15l4-5M4 15h1M19 15h1M12 6v1',

  barChart: 'M5 19V10M11 19V5M17 19v-6M4 8l4-3 4 3 6-4',

  fileSearch: 'M7 3h7l4 4v14H7zM14 3v4h4M9.5 15a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM11.4 16.9 13 18.5',
};

export interface CapabilityGlyphIconProps {
  glyph: CapabilityGlyph;
  color: string;
  size?: number;
  titleText?: string;
}

export const CapabilityGlyphIcon = forwardRef<SVGSVGElement, CapabilityGlyphIconProps>(function CapabilityGlyphIcon(
  { glyph, color, size = 20, titleText },
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
      <path d={GLYPHS[glyph]} stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
});
