// Header block for the CAS home (Figma "Repo overview", node 1647:37709,
// frame "Frame 1597881692"): status badge ("Updated X ago") + title + type
// badge on one line, description below, two actions (Edit Summary / Re-
// Analyze) at the far right. Lives above the topbar/breadcrumb chrome, which
// is AppShell's job (ui-scaffold), not this page's.
import { Box, Button, Chip, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import EditIcon from '@mui/icons-material/EditOutlined';
import { formatRelativeTime } from './casSummary';

export interface CodebaseHeaderProps {
  name: string;
  type?: string | null;
  description?: string | null;
  analysisTimestamp?: string | null;
  onReanalyze?: () => void;
  reanalyzing?: boolean;
}

export function CodebaseHeader({ name, type, description, analysisTimestamp, onReanalyze, reanalyzing }: CodebaseHeaderProps) {
  const relative = formatRelativeTime(analysisTimestamp);
  return (
    <Stack spacing={1.5} sx={{ mb: 3 }}>
      <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Stack spacing={1}>
          {relative ? (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'primary.main' }} />
              <Typography variant="caption" color="text.secondary">
                Updated {relative}
              </Typography>
            </Stack>
          ) : null}
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <Typography variant="h4" component="h1">{name}</Typography>
            {type ? <Chip size="small" label={type} /> : null}
          </Stack>
        </Stack>
        <Stack direction="row" spacing={1.5}>
          <Button variant="outlined" startIcon={<EditIcon fontSize="small" />}>Edit Summary</Button>
          <Button variant="contained" startIcon={<RefreshIcon fontSize="small" />} onClick={onReanalyze} disabled={reanalyzing}>
            {reanalyzing ? 'Re-analyzing…' : 'Re-Analyze'}
          </Button>
        </Stack>
      </Stack>
      {description ? (
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 900 }}>
          {description}
        </Typography>
      ) : null}
    </Stack>
  );
}
