import { Box, Chip, IconButton, Stack, Typography } from '@mui/material';
import ArrowOutwardIcon from '@mui/icons-material/ArrowOutward';
import { Link as RouterLink } from 'react-router-dom';
import type { Project } from '../../api';

export interface JumpBackInTarget {
  project: Project;
  workspaceId: string;
  workspaceName: string;
}

/**
 * Figma "Home" (node 1698-13626): "Jump Back In" section — one card for the
 * most recently touched project. The design's stat row (Lines / Capabilities
 * / Contributors) and "Last Opened" timestamp all depend on data this page
 * doesn't have yet (no lines-of-code metric, no per-user view history, no
 * contributor count in the API surface — see apps/app/docs/DESIGN-NOTES.md).
 * Built with the exact shape from Figma; unavailable stats render an honest
 * "—" rather than a fabricated number.
 */
export function JumpBackInCard({ target }: { target: JumpBackInTarget }) {
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
        <Stack spacing={1.5}>
          <Chip label="Repo" size="small" variant="outlined" sx={{ alignSelf: 'flex-start' }} />
          <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
            <Typography variant="h6" component="span">
              {target.project.name}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {target.workspaceName}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={4}>
            <JumpBackInStat label="Lines" value="—" />
            <JumpBackInStat label="Capabilities" value="—" />
            <JumpBackInStat label="Contributors" value="—" />
          </Stack>
          <Typography variant="caption" color="text.disabled">
            Last Opened —
          </Typography>
        </Stack>
        <IconButton
          component={RouterLink}
          to={`/codebases/${target.project.id}`}
          size="small"
          sx={{ border: 1, borderColor: 'divider' }}
          aria-label={`Open ${target.project.name}`}
        >
          <ArrowOutwardIcon fontSize="small" />
        </IconButton>
      </Stack>
    </Box>
  );
}

function JumpBackInStat({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
      <Typography variant="caption" sx={{ fontWeight: 600 }}>
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Stack>
  );
}
