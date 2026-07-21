import { Box, Stack, Tooltip, Typography, Button } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import EditIcon from '@mui/icons-material/EditOutlined';
import { describeFreshness } from '@/shared/lib/freshness';

export interface CodebaseHeaderProps {
  name: string;
  description?: string | null;
  analysisTimestamp?: string | null;

  sourceAt?: string | null;
  onReanalyze?: () => void;
  reanalyzing?: boolean;
}

export function CodebaseHeader({ name, description, analysisTimestamp, sourceAt, onReanalyze, reanalyzing }: CodebaseHeaderProps) {
  const freshness = describeFreshness(analysisTimestamp, sourceAt);
  return (
    <Stack spacing={1.5} sx={{ mb: 3 }}>
      <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Stack spacing={1}>
          {freshness ? (
            <Tooltip title={freshness.staleNotice ?? ''} arrow placement="right" disableHoverListener={!freshness.stale}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', width: 'fit-content', cursor: freshness.stale ? 'default' : undefined }}>
                <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: freshness.stale ? 'warning.main' : 'primary.main' }} />
                <Typography variant="caption" color="text.secondary">
                  {freshness.label}
                </Typography>
              </Stack>
            </Tooltip>
          ) : null}
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <Typography variant="h4" component="h1">{name}</Typography>
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
