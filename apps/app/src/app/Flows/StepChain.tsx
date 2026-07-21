import { Box, Paper, Stack, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import type { FlowStep } from '@/shared/api/index';
import { stepSideEffectCount } from './flowFormat';
import { tokens } from '@/theme/index';

export function StepChain({
  steps,
  selectedStepId,
  onSelect,
}: {
  steps: FlowStep[];
  selectedStepId: string | undefined;
  onSelect: (stepId: string) => void;
}) {
  return (
    <Paper variant="outlined">
      <Box sx={{ px: 3, py: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="subtitle2">Flow Overview</Typography>
        <Typography variant="caption" color="text.secondary">
          The ordered steps this flow moves through, entry to terminus.
        </Typography>
      </Box>
      <Stack direction="row" spacing={0} sx={{ px: 3, py: 2.5, overflowX: 'auto', alignItems: 'center' }}>
        {steps.map((step, index) => (
          <Stack key={step.step_id} direction="row" spacing={0} sx={{ alignItems: 'center', flexShrink: 0 }}>
            <Box
              component="button"
              onClick={() => onSelect(step.step_id)}
              sx={{
                cursor: 'pointer',
                textAlign: 'left',
                bgcolor: 'transparent',
                border: '1px solid',
                borderColor: step.step_id === selectedStepId ? 'primary.main' : 'divider',
                borderRadius: 1,
                px: 2,
                py: 1,
                minWidth: 110,
              }}
            >
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{step.name}</Typography>
              {stepSideEffectCount(step) > 0 ? (
                <Typography variant="caption" color="text.secondary">
                  {stepSideEffectCount(step)} side effect{stepSideEffectCount(step) === 1 ? '' : 's'}
                </Typography>
              ) : null}
            </Box>
            {index < steps.length - 1 ? (
              <ChevronRightIcon fontSize="small" sx={{ color: tokens.wireframe, mx: 0.5, flexShrink: 0 }} />
            ) : null}
          </Stack>
        ))}
      </Stack>
      <Stack direction="row" spacing={1} sx={{ px: 3, pb: 2, alignItems: 'center' }}>
        <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'primary.main' }} />
        <Typography variant="caption" color="text.secondary">Current step</Typography>
      </Stack>
    </Paper>
  );
}
