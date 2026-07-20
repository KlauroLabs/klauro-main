import { Box, Stack, Typography } from '@mui/material';
import { EmptyState } from '../../layout/EmptyState';

/**
 * Figma "Home" (node 1698-13626): "Change Activity" panel — a timeline of
 * recent changes across workspaces (title, author, impacted-service count,
 * relative timestamp). No backend surface serves this to the web app yet:
 * `apps/mcp-server` has get_changes_since/get_changes_between as MCP tools,
 * but nothing is exposed over REST for this page to call, and there is no
 * author/attribution data in the served analyses. Built with the panel's
 * exact shell (title + subtitle) and an honest empty state in place of the
 * timeline — see apps/app/docs/DESIGN-NOTES.md for the full data-gap entry.
 */
export function ChangeActivityPanel() {
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 4 }}>
      <Stack spacing={3}>
        <Stack spacing={1}>
          <Typography variant="h6" component="h2">
            Change Activity
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Recent changes across your system
          </Typography>
        </Stack>
        <EmptyState
          title="No recent changes yet"
          description="Change history for your workspaces will appear here once it's wired up."
        />
      </Stack>
    </Box>
  );
}
