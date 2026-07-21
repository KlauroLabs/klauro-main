// RepositoryCard's stack tag chips (Figma "Workspace", node 1748:6595 card
// grid): every card shows its languages/frameworks as small COLORED pills
// (confirmed via get_screenshot — "Jest"/"Flask" render distinctly
// green/orange, not a uniform neutral chip). A stack tag has no server-side
// color/category field, so this maps a fixed, muted palette by tag name via
// a stable hash — the same tag always renders the same color across every
// card, without inventing a taxonomy the API doesn't provide.
const palette: Array<{ bg: string; fg: string }> = [
  { bg: 'rgba(114, 184, 92, 0.16)', fg: '#8FD17A' }, // green
  { bg: 'rgba(224, 149, 74, 0.16)', fg: '#E5A969' }, // orange
  { bg: 'rgba(114, 184, 197, 0.16)', fg: '#8FD1DE' }, // teal
  { bg: 'rgba(154, 129, 227, 0.16)', fg: '#B39EEE' }, // purple
  { bg: 'rgba(214, 138, 173, 0.16)', fg: '#E0A6C4' }, // pink
  { bg: 'rgba(196, 189, 92, 0.16)', fg: '#D9CF7E' }, // olive
];

function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function stackTagColor(tag: string): { bg: string; fg: string } {
  return palette[hash(tag) % palette.length];
}
