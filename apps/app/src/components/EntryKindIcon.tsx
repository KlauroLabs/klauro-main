import { forwardRef } from 'react';
import type { EntryKind } from './entryPointKinds';

/**
 * Shared entry-point kind icon — one engineered, outlined symbol per kind in
 * the fixed vocabulary (`entryPointKinds.ts`). Built for the entry-points
 * lane, reused as-is by the flows lane (same kinds, same meaning).
 *
 * Design-language rules honored here (apps/app/docs/LANE-COMMON.md — the
 * theme/index.ts token file is still in flight from the ui-scaffold lane, so
 * the raw hex/stroke values below are the documented design-language
 * constants, not hardcoded guesses; swap to theme tokens once that file
 * lands):
 *  - stroke only, never filled — geometry conveys meaning, not color
 *  - one consistent stroke weight per icon (1.25px "primary")
 *  - wireframe/icon color #B7BCC7 by default; `accent` swaps to the single
 *    focus color #E6414B (used sparingly, e.g. selected state)
 *  - every family shares a container shape (the "envelope" of the glyph) so
 *    the eye reads family first, kind second — matching the brief's family
 *    mix taking visual priority over the full vocabulary.
 */

const WIREFRAME = '#B7BCC7';
const FOCUS = '#E6414B';
const STROKE_PRIMARY = 1.25;

export interface EntryKindIconProps {
  kind: EntryKind;
  size?: number;
  accent?: boolean;
  titleText?: string;
}

// Inner glyph per kind — all drawn in a 24x24 box, stroke-only, no fills.
const GLYPHS: Record<EntryKind, string> = {
  // request & wait — circle container, symbols suggest a two-way exchange
  http: 'M7 9h6M7 12h10M7 15h8',
  api: 'M8 7l-3 5 3 5M16 7l3 5-3 5',
  route: 'M6 18l4-12h4l4 12',
  page: 'M8 8h8v2H8zM8 12h5v2H8z',
  rpc: 'M6 9l3-3 3 3M18 15l-3 3-3-3M9 6v9M15 9v9',
  websocket: 'M5 9a10 10 0 0 1 14 0M8 12a6 6 0 0 1 8 0M12 16v.01',
  cli: 'M6 8l4 4-4 4M13 16h6',
  command: 'M7 7h4v4H7zM13 7h4v4h-4zM7 13h4v4H7zM13 13h4v4h-4z',
  ipc: 'M6 9h6l3 3-3 3H6zM17 9l1 3-1 3',
  // send & forget — envelope container, arrow leaving without a return path
  message: 'M6 8h12v8H6zM6 8l6 5 6-5',
  event: 'M12 6v5l3.5 3.5M12 6a6 6 0 1 1 0 12',
  schedule: 'M12 7v5l3 2M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z',
  task: 'M7 7h10M7 12h10M7 17h6',
  pipeline: 'M6 8h4v3H6zM10 9.5h4M14 8h4v3h-4zM8 11v3h8v-3',
  // reacts on its own — dashed/passive container, no explicit caller
  lifecycle: 'M12 5v3M12 16v3M5 12h3M16 12h3M7.5 7.5l2 2M14.5 14.5l2 2M16.5 7.5l-2 2M9.5 14.5l-2 2',
  file: 'M8 4h6l4 4v12H8zM14 4v4h4M9 14l2 2 4-4',
  interrupt: 'M13 3 5 14h6l-1 7 8-11h-6z',
  driver: 'M9 4h6v3H9zM9 17h6v3H9zM4 9h3v6H4zM17 9h3v6h-3zM9 9h6v6H9z',
  // specialized — data/ML container
  train: 'M12 5a4 4 0 0 1 4 4v2l2 2v3H6v-3l2-2V9a4 4 0 0 1 4-4z',
  'notebook-cell': 'M5 6h14v3H5zM5 12h14M5 16h9',
};

export const EntryKindIcon = forwardRef<SVGSVGElement, EntryKindIconProps>(function EntryKindIcon(
  { kind, size = 18, accent = false, titleText },
  ref,
) {
  const color = accent ? FOCUS : WIREFRAME;
  const path = GLYPHS[kind];
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label={titleText ?? kind}
    >
      {titleText ? <title>{titleText}</title> : null}
      <rect x="2.5" y="2.5" width="19" height="19" rx="4" stroke={color} strokeWidth={STROKE_PRIMARY} />
      <path d={path} stroke={color} strokeWidth={STROKE_PRIMARY} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
});
