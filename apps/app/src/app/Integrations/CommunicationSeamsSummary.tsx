import { useMemo } from 'react';
import { Box, Typography, Stack, Chip } from '@mui/material';
import type { ExitPoint } from '@/shared/hooks/useExitPoints';

export type SeamModality = 'sync' | 'async';

export function summarizeSeams(exitPoints: ExitPoint[]): { sync: number; async: number; total: number } {
  let sync = 0;
  let async = 0;
  for (const ep of exitPoints) {
    if (ep.type === 'file') continue;
    if (ep.operation?.async) async += 1;
    else sync += 1;
  }
  return { sync, async, total: sync + async };
}

export function CommunicationSeamsSummary({ exitPoints }: { exitPoints: ExitPoint[] }) {
  const seams = useMemo(() => summarizeSeams(exitPoints), [exitPoints]);

  if (seams.total === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No outbound calls to classify yet.
      </Typography>
    );
  }

  const syncPct = Math.round((seams.sync / seams.total) * 100);

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
        <Chip size="small" label={`${seams.sync} synchronous`} />
        <Chip size="small" variant="outlined" label={`${seams.async} asynchronous`} />
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {syncPct}% of this codebase's outbound calls wait for a response before continuing; the rest fire and
        move on.
      </Typography>
    </Box>
  );
}
