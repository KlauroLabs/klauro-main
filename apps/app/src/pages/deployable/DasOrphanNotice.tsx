import { Alert, Typography } from '@mui/material';

/**
 * Orphan honesty (LANE-COMMON.md: "orphan_node_count surfaced") — now wired
 * to the real das_index (GET /api/projects/:id/das, e9490b69), the same
 * reachability-closure accounting the MCP get_summary tool's das_index
 * computes (deployable-analysis.ts's buildDeployableAnalyses). Zero orphans
 * is a real, common, GOOD outcome (every node is claimed by at least one
 * unit) — rendered as a plain confirmation, not hidden.
 */
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
