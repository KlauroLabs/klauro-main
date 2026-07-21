import { Chip } from '@mui/material';
import type { FlowConcept } from '@/shared/api/index';
import { roleLabel } from './flowFormat';

const ROLE_COLOR: Record<'core' | 'supporting' | 'infrastructure' | 'unknown', { fg: string; bg: string }> = {
  core: { fg: '#9E77ED', bg: 'rgba(158,119,237,0.11)' },
  supporting: { fg: '#4181D7', bg: 'rgba(65,129,215,0.1)' },
  infrastructure: { fg: '#21AA7C', bg: 'rgba(33,170,124,0.08)' },
  unknown: { fg: '#9BA3C0', bg: 'rgba(155,163,192,0.1)' },
};

export function FlowRoleBadge({ role, size = 'small' }: { role: FlowConcept['role']; size?: 'small' | 'medium' }) {
  const key = role === 'core' || role === 'supporting' || role === 'infrastructure' ? role : 'unknown';
  const { fg, bg } = ROLE_COLOR[key];
  return (
    <Chip
      size={size}
      label={roleLabel(role)}
      sx={{ bgcolor: bg, color: fg, border: 'none', fontWeight: 600 }}
    />
  );
}
