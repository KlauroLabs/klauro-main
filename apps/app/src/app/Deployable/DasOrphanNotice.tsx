import { Alert, Typography } from '@mui/material';

export function DasOrphanNotice({ orphanNodeCount }: { orphanNodeCount: number | undefined }) {
  if (orphanNodeCount === undefined) {
    return (
      <Alert severity="info" variant="outlined">
        <Typography variant="body2">
          Orphan node count is still loading.
        </Typography>
      </Alert>
    );
  }
  return (
    <Alert severity={orphanNodeCount > 0 ? 'info' : 'success'} variant="outlined">
      <Typography variant="body2">
        {orphanNodeCount > 0
          ? `Orphan node count: ${orphanNodeCount} node${orphanNodeCount === 1 ? '' : 's'} reached by no deployable unit at all.`
          : 'Orphan node count: 0 — every node in this analysis is reached by at least one deployable unit.'}
      </Typography>
    </Alert>
  );
}
