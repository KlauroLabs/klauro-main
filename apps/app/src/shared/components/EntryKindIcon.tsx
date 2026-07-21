import { forwardRef } from 'react';
import type { EntryKind } from './entryPointKinds';

const WIREFRAME = '#B7BCC7';
const FOCUS = '#E6414B';
const STROKE_PRIMARY = 1.25;

export interface EntryKindIconProps {
  kind: EntryKind;
  size?: number;
  accent?: boolean;
  titleText?: string;
}

const GLYPHS: Record<EntryKind, string> = {

  http: 'M7 9h6M7 12h10M7 15h8',
  api: 'M8 7l-3 5 3 5M16 7l3 5-3 5',
  route: 'M6 18l4-12h4l4 12',
  page: 'M8 8h8v2H8zM8 12h5v2H8z',
  rpc: 'M6 9l3-3 3 3M18 15l-3 3-3-3M9 6v9M15 9v9',
  websocket: 'M5 9a10 10 0 0 1 14 0M8 12a6 6 0 0 1 8 0M12 16v.01',
  cli: 'M6 8l4 4-4 4M13 16h6',
  command: 'M7 7h4v4H7zM13 7h4v4h-4zM7 13h4v4H7zM13 13h4v4h-4z',
  ipc: 'M6 9h6l3 3-3 3H6zM17 9l1 3-1 3',

  message: 'M6 8h12v8H6zM6 8l6 5 6-5',
  event: 'M12 6v5l3.5 3.5M12 6a6 6 0 1 1 0 12',
  schedule: 'M12 7v5l3 2M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z',
  task: 'M7 7h10M7 12h10M7 17h6',
  pipeline: 'M6 8h4v3H6zM10 9.5h4M14 8h4v3h-4zM8 11v3h8v-3',

  lifecycle: 'M12 5v3M12 16v3M5 12h3M16 12h3M7.5 7.5l2 2M14.5 14.5l2 2M16.5 7.5l-2 2M9.5 14.5l-2 2',
  file: 'M8 4h6l4 4v12H8zM14 4v4h4M9 14l2 2 4-4',
  interrupt: 'M13 3 5 14h6l-1 7 8-11h-6z',
  driver: 'M9 4h6v3H9zM9 17h6v3H9zM4 9h3v6H4zM17 9h3v6h-3zM9 9h6v6H9z',

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
