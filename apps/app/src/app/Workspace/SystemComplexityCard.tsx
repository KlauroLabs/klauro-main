import { Box, LinearProgress, Stack, Typography } from '@mui/material';
import { EmptyState } from '@/shared/layout/EmptyState';
import { SystemComplexityGlyph } from '@/shared/components/icons/SystemComplexityGlyph';
import type { WorkspaceComplexity } from '@/shared/api/index';

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
