import { Box, Chip, Divider, Paper, Stack, Typography } from '@mui/material';
import type { ILSOContract } from '@/shared/api/index';

export function FlowDataSection({ contract }: { contract: ILSOContract }) {
  return (
    <Paper variant="outlined">
      <Box sx={{ px: 3, py: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="subtitle2">Data</Typography>
        <Typography variant="caption" color="text.secondary">
          What this flow takes in, what it returns, and the rules it operates under.
        </Typography>
      </Box>
      <Stack spacing={2.5} sx={{ p: 3 }}>
        <Field label="Inputs" values={contract.input} />
        <Field label="Outputs" values={contract.output} />
        <Divider />
        <Box>
          <Typography variant="overline" color="text.secondary">Constraints</Typography>
          {contract.constraints.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              No constraints recorded for this flow.
            </Typography>
          ) : (
            <Stack spacing={0.5} sx={{ mt: 1 }}>
              {contract.constraints.map(constraint => (
                <Typography key={constraint} variant="body2">• {constraint}</Typography>
              ))}
            </Stack>
          )}
        </Box>
      </Stack>
    </Paper>
  );
}

function Field({ label, values }: { label: string; values: string[] }) {
  return (
    <Box>
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
