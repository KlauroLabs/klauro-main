import { forwardRef } from 'react';

/**
 * Shared, small (14-20px) engineered stat-row glyphs — the icon set that sits
 * before a "N <label>" pair on stat rows across the Home ("Jump Back In" /
 * "Workspace" list, Figma node 1698-13626) and Workspace ("Frame 1597881835"
 * 5-stat row, node 1748-6595) designed screens. Figma names these glyphs
 * code-square-02 (Lines), codepen (Capabilities/Flows), layers-two-01
 * (Repositories), layers-three-01 (Workspace), database-03 (Entities), and
 * users-03 (Contributors) — the underlying vector nodes export from the
 * Figma MCP bridge as rasterized boolean-group PNGs, not path data, so these
 * are engineered fresh at the same visual geometry rather than traced, using
 * EntryKindIcon's established discipline (stroke-only, one weight, no fill).
 */

const WIREFRAME = '#B7BCC7';
const STROKE = 1.25;

export type StatGlyph =
  | 'lines'
  | 'capabilities'
  | 'flows'
  | 'entities'
  | 'contributors'
  | 'repositories'
  | 'workspace';

const GLYPHS: Record<StatGlyph, string> = {
  // code-square-02: rounded square with a code bracket
  lines: 'M9 9l-2.5 3L9 15M15 9l2.5 3L15 15',
  // codepen: hex outline with inner chevrons (capabilities / flows share the network glyph)
  capabilities: 'M12 3l8 5v8l-8 5-8-5V8zM12 3v9M4 8l8 4 8-4M12 21v-9',
  flows: 'M12 3l8 5v8l-8 5-8-5V8zM12 3v9M4 8l8 4 8-4M12 21v-9',
  // database-03: stacked disc container
  entities: 'M5 6c0-1.66 3.13-3 7-3s7 1.34 7 3-3.13 3-7 3-7-1.34-7-3zM5 6v12c0 1.66 3.13 3 7 3s7-1.34 7-3V6M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3',
  // users-03: two overlapping head+shoulder silhouettes
  contributors: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3.31 2.69-6 6-6s6 2.69 6 6M17 8a2.5 2.5 0 1 1-1-4.8M21 20c0-2.7-1.8-4.97-4.26-5.71',
  // layers-two-01: two stacked rhombi
  repositories: 'M12 4l8 4-8 4-8-4zM4 14l8 4 8-4',
  // layers-three-01: three stacked rhombi
  workspace: 'M12 3l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4',
};

export interface StatGlyphIconProps {
  glyph: StatGlyph;
  size?: number;
  titleText?: string;
}

export const StatGlyphIcon = forwardRef<SVGSVGElement, StatGlyphIconProps>(function StatGlyphIcon(
  { glyph, size = 14, titleText },
  ref,
) {
  const path = GLYPHS[glyph];
  const withBox = glyph === 'lines';
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
      {withBox ? (
        <rect x="3" y="3" width="18" height="18" rx="4" stroke={WIREFRAME} strokeWidth={STROKE} />
      ) : null}
      <path d={path} stroke={WIREFRAME} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
});
