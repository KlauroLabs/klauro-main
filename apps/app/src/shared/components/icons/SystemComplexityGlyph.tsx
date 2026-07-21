const WIREFRAME = '#B7BCC7';
const CONSTRUCTION = '#2A2B36';

export function SystemComplexityGlyph({ size = 96 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" fill="none" role="img" aria-hidden="true">
      <circle cx="48" cy="48" r="30" stroke={CONSTRUCTION} strokeWidth="1" />
      <circle cx="48" cy="48" r="22" stroke={WIREFRAME} strokeWidth="1.25" />
      <ellipse cx="48" cy="48" rx="22" ry="8" stroke={WIREFRAME} strokeWidth="0.75" />
      <ellipse cx="48" cy="48" rx="8" ry="22" stroke={WIREFRAME} strokeWidth="0.75" />
      <line x1="26" y1="48" x2="70" y2="48" stroke={WIREFRAME} strokeWidth="0.75" />
      <line x1="48" y1="26" x2="48" y2="70" stroke={WIREFRAME} strokeWidth="0.75" />
      <circle cx="48" cy="48" r="4" stroke={WIREFRAME} strokeWidth="1.25" />
      <circle cx="80" cy="30" r="3" stroke={WIREFRAME} strokeWidth="1" />
      <circle cx="14" cy="62" r="2.5" stroke={WIREFRAME} strokeWidth="1" />
      <circle cx="72" cy="76" r="2" stroke={WIREFRAME} strokeWidth="1" />
      <path d="M52 30 74 30" stroke={CONSTRUCTION} strokeWidth="0.75" strokeDasharray="2 2" />
      <path d="M18 60 26 55" stroke={CONSTRUCTION} strokeWidth="0.75" strokeDasharray="2 2" />
    </svg>
  );
}
