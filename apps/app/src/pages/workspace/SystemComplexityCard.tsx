// "System Complexity" card (Figma node 1748:6595, frame "Frame 1597881800":
// title+subtitle, a radial icon, "Complexity Score X/100", "Trend Y% vs last
// 30 days", "View Analysis ->" link). Wired to WorkspaceAnalysisResponse.
// analysis.workspace_complexity (cross-codebase-analysis.ts) shipped in
// e9490b69 — composite is a real 0-100 blend of member-codebase complexity
// and cross-repo integration factors. The Figma's "Trend Y% vs last 30 days"
// has no backend counterpart (the WAS record keeps only the LATEST
// complexity, not a history to diff against) — that trend line is honestly
// omitted rather than invented; see DESIGN-NOTES.md.
import { Box, LinearProgress, Stack, Typography } from '@mui/material';
import { EmptyState } from '../../layout/EmptyState';
import { SystemComplexityGlyph } from '../../components/icons/SystemComplexityGlyph';
import type { WorkspaceComplexity } from '../../api';

export function SystemComplexityCard({ complexity }: { complexity?: WorkspaceComplexity }) {
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 4 }}>
      <Stack spacing={3}>
        <Stack spacing={0.5}>
          <Typography variant="h6" component="h2">
            System Complexity
          </Typography>
          <Typography variant="body2" color="text.secondary">
            How complex is your System
          </Typography>
        </Stack>
        <Stack direction="row" spacing={3} sx={{ alignItems: 'center' }}>
          <SystemComplexityGlyph size={72} />
          {complexity ? (
            <Stack spacing={1} sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="h5" component="div">
                {Math.round(complexity.composite)}/100
              </Typography>
              <LinearProgress
                variant="determinate"
                value={Math.min(100, Math.max(0, complexity.composite))}
                sx={{ height: 6, borderRadius: 3 }}
              />
              <Typography variant="caption" color="text.secondary">
                {complexity.members.length} member codebase{complexity.members.length === 1 ? '' : 's'} blended
                &middot; no trend history yet
              </Typography>
            </Stack>
          ) : (
            <EmptyState title="Not computed yet" description="A workspace-level complexity score isn't produced by the current analysis." />
          )}
        </Stack>
      </Stack>
    </Box>
  );
}
