import { Box, Chip, Stack, Typography } from '@mui/material';
import type { EntryPoint } from '@/shared/hooks/useEntryPoints';

export function CapabilitiesCard({ entryPoint }: { entryPoint: EntryPoint }) {
  const caps = entryPoint.capabilities ?? [];
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        Capabilities it serves
      </Typography>
      {caps.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          None — infrastructure. Its flow's role is plumbing, not business purpose, and that's
          correct, not a gap.
        </Typography>
      ) : (
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {caps.map(cap => (
            <Chip
              key={cap.capability_id}
              size="small"
              variant="outlined"
              label={cap.role === 'primary' ? cap.capability_name : `${cap.capability_name} · ${cap.role}`}
              color={cap.role === 'primary' ? 'primary' : 'default'}
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}
