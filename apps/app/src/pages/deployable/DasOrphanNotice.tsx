import { Alert, Typography } from '@mui/material';

/**
 * Orphan honesty (LANE-COMMON.md: "orphan_node_count surfaced") — but
 * orphan accounting requires the full DAS reachability closure across
 * EVERY unit at once (a node reached by no unit's slice), which is
 * computed only inside apps/mcp-server/src/deployable-analysis.ts's
 * buildDeployableAnalyses and served through the MCP get_summary tool's
 * das_index — not exposed over GET /api/projects/:id/cas today. Rather
 * than approximate a count this page cannot actually verify, this is an
 * honest gap notice. See apps/app/docs/DESIGN-NOTES.md.
 */
export function DasOrphanNotice() {
  return (
    <Alert severity="info" variant="outlined">
      <Typography variant="body2">
        Orphan node count (nodes reached by no unit at all) is part of the das_index the MCP
        get_summary tool computes, not yet exposed over the web API. This page can't show it
        honestly until that route ships — see DESIGN-NOTES.md.
      </Typography>
    </Alert>
  );
}
