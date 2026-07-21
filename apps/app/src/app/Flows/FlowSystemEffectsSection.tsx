import { Box, Paper, Stack, Typography } from '@mui/material';
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined';
import type { ILSOContract } from '@/shared/api/index';

export function FlowSystemEffectsSection({ sideEffects }: { sideEffects: ILSOContract['side_effects'] }) {
  const hasAny = sideEffects.external_integrations.length > 0 || sideEffects.state_changes.length > 0;
  return (
    <Paper variant="outlined">
      <Box sx={{ px: 3, py: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="subtitle2">System Effects</Typography>
        <Typography variant="caption" color="text.secondary">
          External services this flow calls, and the state it changes.
        </Typography>
      </Box>
      {!hasAny ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 3 }}>
          No external integrations or state changes recorded for this flow.
        </Typography>
      ) : (
        <Stack spacing={3} sx={{ p: 3 }}>
          {sideEffects.external_integrations.length > 0 ? (
            <Box>
              <Typography variant="overline" color="text.secondary">External integrations</Typography>
              <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', gap: 1.5, mt: 1 }}>
                {sideEffects.external_integrations.map(item => (
                  <Stack
                    key={item}
                    direction="row"
                    spacing={1} sx={{ alignItems: 'center', border: '1px solid', borderColor: 'divider', borderRadius: 1, px: 1.5, py: 1, minWidth: 160 }}
                  >
                    <CloudOutlinedIcon fontSize="small" color="disabled" />
                    <Typography variant="body2">{item}</Typography>
                  </Stack>
                ))}
              </Stack>
            </Box>
          ) : null}
          {sideEffects.state_changes.length > 0 ? (
            <Box>
              <Typography variant="overline" color="text.secondary">State changes</Typography>
              <Stack spacing={0.5} sx={{ mt: 1 }}>
                {sideEffects.state_changes.map(change => (
                  <Typography key={change} variant="body2">• {change}</Typography>
                ))}
              </Stack>
            </Box>
          ) : null}
        </Stack>
      )}
    </Paper>
  );
}
