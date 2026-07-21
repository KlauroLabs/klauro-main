import { Box, IconButton, Stack, Typography } from '@mui/material';
import ArrowOutwardIcon from '@mui/icons-material/ArrowOutward';
import { Link as RouterLink } from 'react-router-dom';
import type { Workspace } from '../../api';
import { useWorkspaceAnalysis } from '../../hooks/useWorkspaceAnalysis';
import { StatGlyphIcon, type StatGlyph } from '../../components/icons/StatGlyphIcon';
import { encodeSlug } from '../../lib/slugs';

/**
 * One row in the Figma "Home" (node 1698-13626) "Workspace" list: icon,
 * name, a domain subtitle, and a Repositories/Contributors stat pair with a
 * jump-in button. Repositories/Contributors are real (`project_count`,
 * `user_count` on the workspace list response); the domain subtitle comes
 * from the workspace analysis narrative and is honestly omitted (not
 * fabricated) while that analysis is pending or has none.
 */
export function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  const analysis = useWorkspaceAnalysis(workspace.id);
  const domain = analysis.data?.analysis?.workspace_narrative?.domains?.[0];

  return (
    <Box
      sx={{
        bgcolor: 'action.hover',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1.5,
        px: 3,
        py: 2.5,
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Stack direction="row" spacing={3} sx={{ alignItems: 'center' }}>
          <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1, display: 'flex' }}>
            <StatGlyphIcon glyph="workspace" size={20} />
          </Box>
          <Stack spacing={1}>
            <Typography variant="h6" component="span">
              {workspace.name}
            </Typography>
            {domain ? (
              <Typography variant="body2" color="text.secondary">
                {domain}
              </Typography>
            ) : null}
          </Stack>
        </Stack>
        <Stack direction="row" spacing={3} sx={{ alignItems: 'center' }}>
          <Stack direction="row" spacing={3}>
            <WorkspaceStat glyph="repositories" value={workspace.project_count} label="Repositories" />
            <WorkspaceStat glyph="contributors" value={workspace.user_count} label="Contributors" />
          </Stack>
          <IconButton
            component={RouterLink}
            to={`/workspaces/${encodeSlug(workspace)}`}
            size="small"
            sx={{ border: 1, borderColor: 'divider' }}
            aria-label={`Open ${workspace.name}`}
          >
            <ArrowOutwardIcon fontSize="small" />
          </IconButton>
        </Stack>
      </Stack>
    </Box>
  );
}

function WorkspaceStat({ glyph, value, label }: { glyph: StatGlyph; value: number; label: string }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      <StatGlyphIcon glyph={glyph} />
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {value}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
      </Stack>
    </Stack>
  );
}
