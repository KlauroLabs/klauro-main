import { Box, Chip, Stack, Typography } from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import type { EntryPoint } from '@/shared/hooks/useEntryPoints';

export function OutputCard({ entryPoint }: { entryPoint: EntryPoint }) {
  const output = entryPoint.output;
  const codes = output?.status_codes ?? [];

  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        What it returns
      </Typography>
      {renderShape(output)}
      {codes.length ? (
        <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1.5, flexWrap: 'wrap' }}>
          {codes.map(code => (
            <Chip key={code} size="small" variant="outlined" label={code} color={code >= 400 ? 'error' : 'success'} />
          ))}
        </Stack>
      ) : null}
    </Box>
  );
}

function renderShape(output: EntryPoint['output']) {
  if (!output || (output.is_void && !output.type)) {
    return (
      <Typography variant="body2" color="text.secondary">
        Nothing (void) — its result is the work it does; follow its flow to see the effect.
      </Typography>
    );
  }
  if (output.is_void) {
    return (
      <Typography variant="body2" color="text.secondary">
        Nothing (void).
      </Typography>
    );
  }
  if (output.is_named_type && output.type) {
    return (
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
        <Typography component="code" variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
          {output.type}
        </Typography>
        <ArrowForwardIcon fontSize="inherit" sx={{ opacity: 0.6 }} />
        <Typography variant="caption" color="text.secondary">
          named type, defined elsewhere
        </Typography>
      </Stack>
    );
  }
  if (output.type) {
    return (
      <Typography variant="body2">
        <Typography component="code" sx={{ fontFamily: 'monospace' }}>{output.type}</Typography>
      </Typography>
    );
  }
  return (
    <Typography variant="body2" color="text.secondary">
      Not determined from static analysis.
    </Typography>
  );
}
