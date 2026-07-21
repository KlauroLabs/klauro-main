import { Box, Stack, Typography } from '@mui/material';
import type { MergedCapability } from '@/app/Codebase/casSummary';
import { CapabilityGlyphIcon, type CapabilityGlyph } from '@/shared/components/icons/CapabilityGlyphIcon';
import { StatGlyphIcon } from '@/shared/components/icons/StatGlyphIcon';

const iconCycle: CapabilityGlyph[] = ['coinsSwap', 'activity', 'dollarCircle', 'speedometer', 'barChart', 'fileSearch'];
const accentCycle = ['#FF9800', '#59B6F9', '#B1E94B', '#9F86FF', '#87F1D4', '#168F42'];

export function CapabilityCard({ capability, index }: { capability: MergedCapability; index: number }) {
  const glyph = iconCycle[index % iconCycle.length];
  const accent = accentCycle[index % accentCycle.length];
  return (
    <Stack spacing={2} sx={{ p: 4, height: '100%' }}>
      <Stack spacing={2}>
        <Box sx={{ display: 'inline-flex', p: 1, borderRadius: 1, border: '0.5px solid', borderColor: `${accent}80` }}>
          <CapabilityGlyphIcon glyph={glyph} color={accent} size={20} />
        </Box>
        <Typography variant="h3">{capability.name}</Typography>
      </Stack>
      <Stack spacing={3}>
        <Typography variant="body2" color="text.secondary" sx={{ minHeight: 44 }}>
          {capability.description || 'No description available yet.'}
        </Typography>
        <Stack direction="row" spacing={2}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <StatGlyphIcon glyph="flows" size={14} />
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              <Typography variant="caption" color="text.primary">{capability.flowCount ?? '—'}</Typography>
              <Typography variant="caption" color="text.disabled">flows</Typography>
            </Stack>
          </Stack>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <StatGlyphIcon glyph="entities" size={14} />
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              <Typography variant="caption" color="text.primary">{capability.entityCount ?? '—'}</Typography>
              <Typography variant="caption" color="text.disabled">Entities</Typography>
            </Stack>
          </Stack>
        </Stack>
      </Stack>
    </Stack>
  );
}
