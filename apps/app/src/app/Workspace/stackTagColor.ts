const palette: Array<{ bg: string; fg: string }> = [
  { bg: 'rgba(114, 184, 92, 0.16)', fg: '#8FD17A' },
  { bg: 'rgba(224, 149, 74, 0.16)', fg: '#E5A969' },
  { bg: 'rgba(114, 184, 197, 0.16)', fg: '#8FD1DE' },
  { bg: 'rgba(154, 129, 227, 0.16)', fg: '#B39EEE' },
  { bg: 'rgba(214, 138, 173, 0.16)', fg: '#E0A6C4' },
  { bg: 'rgba(196, 189, 92, 0.16)', fg: '#D9CF7E' },
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
