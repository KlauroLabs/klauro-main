import { useMemo } from 'react';
import { Box, Typography, Stack, Chip } from '@mui/material';
import type { ExitPoint } from '../../hooks/useExitPoints';

export type SeamModality = 'sync' | 'async';

/**
 * Communication seams — sync/async modality across every exit point.
 * Derived client-side from CASExitPoint.operation.async (a real, present
 * field), not from a dedicated CAS structure: the analyzer computes a
 * richer seam graph (mcp__klauro__get_communication_seams, including a
 * 'passive' shared-state modality) server-side for agent consumption, but
 * that isn't wired into GET /api/projects/:id/cas yet — see DESIGN-NOTES.md.
 * This summary uses the one signal already on every exit point: does the
 * call block the caller (sync) or fire without waiting (async). `file`-type
 * exits (local filesystem I/O) are excluded — they're a device seam, not a
 * seam to another component, and this repo currently has none.
 */
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
