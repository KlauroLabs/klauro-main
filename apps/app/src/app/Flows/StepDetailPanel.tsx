import { Box, Chip, IconButton, Paper, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import type { FlowStep } from '@/shared/api/index';

function functionFileHint(functionId: string): string | null {
  const colonForm = /^function:(.+):[^:]+$/.exec(functionId);
  if (colonForm) return colonForm[1];
  const underscoreForm = /^function_file_?(.+?)_[A-Za-z0-9]+_\d+$/.exec(functionId);
  if (underscoreForm) return underscoreForm[1].replace(/_/g, '/');
  return null;
}

export function StepDetailPanel({ step, index, total, onClose }: { step: FlowStep; index: number; total: number; onClose: () => void }) {
  return (
    <Paper variant="outlined" sx={{ p: 3, position: { md: 'sticky' }, top: { md: 88 } }}>
      <Stack direction="row" sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{step.name}</Typography>
          <Typography variant="caption" color="text.secondary">Step {index + 1} of {total}</Typography>
        </Box>
        <IconButton size="small" aria-label="Close step detail" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>
      <Typography variant="body2" sx={{ mt: 2 }}>{step.description}</Typography>

      <Box sx={{ mt: 3 }}>
        <Typography variant="overline" color="text.secondary">Functions</Typography>
        <Stack spacing={1} sx={{ mt: 1 }}>
          {step.functions.length === 0 ? (
            <Typography variant="body2" color="text.secondary">No functions resolved for this step.</Typography>
          ) : (
            step.functions.map(fn => {
              const hint = functionFileHint(fn.function_id);
              return (
                <Box key={fn.function_id}>
                  <Typography variant="body2">{fn.section?.label ?? hint ?? fn.function_id}</Typography>
                  {hint ? (
                    <Typography variant="caption" color="text.secondary" component="code" sx={{ fontFamily: 'monospace' }}>
                      {hint}
                    </Typography>
                  ) : null}
                </Box>
              );
            })
          )}
        </Stack>
      </Box>

      <ChipField label="Inputs" values={step.contract.input} />
      <ChipField label="Outputs" values={step.contract.output} />
    </Paper>
  );
}

function ChipField({ label, values }: { label: string; values: string[] }) {
  return (
    <Box sx={{ mt: 3 }}>
      <Typography variant="overline" color="text.secondary">{label}</Typography>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1, mt: 1 }}>
        {values.length === 0 ? (
          <Typography variant="body2" color="text.secondary">None recorded</Typography>
        ) : (
          values.map(value => <Chip key={value} size="small" label={value} variant="outlined" />)
        )}
      </Stack>
    </Box>
  );
}
