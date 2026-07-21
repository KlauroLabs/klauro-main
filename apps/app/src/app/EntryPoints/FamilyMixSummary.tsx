import { Box, Stack, Typography } from '@mui/material';
import { FAMILIES } from '@/shared/components/entryPointKinds';
import type { FamilyCount } from '@/shared/hooks/useEntryPoints';

export function FamilyMixSummary({ familyCounts }: { familyCounts: FamilyCount[] }) {
  if (familyCounts.length === 0) return null;
  const total = familyCounts.reduce((sum, f) => sum + f.count, 0);
  return (
    <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
      {familyCounts.map(f => {
        const meta = FAMILIES[f.family];
        return (
          <Box
            key={f.family}
            sx={{
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              px: 2,
              py: 1.5,
              minWidth: 160,
            }}
          >
            <Typography variant="h5" component="div">
              {f.count}
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {meta.label}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {meta.modality} &middot; {Math.round((f.count / total) * 100)}%
            </Typography>
          </Box>
        );
      })}
    </Stack>
  );
}
