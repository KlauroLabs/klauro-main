import { Box, Button, Paper, Stack, Typography } from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { useNavigate } from 'react-router-dom';
import { EntryKindIcon } from '@/shared/components/EntryKindIcon';
import { KIND_META, isKnownKind } from '@/shared/components/entryPointKinds';
import { useEntryPoint } from '@/shared/hooks/useEntryPoints';
import { encodeSlug } from '@/shared/lib/slugs';
import { formatTrigger } from '@/app/EntryPoints/formatEntryPoint';

export function FlowEntryPointSection({
  projectId,
  projectSlug,
  entryPointId,
}: {

  projectId: string;

  projectSlug?: string;
  entryPointId: string;
}) {
  const navigate = useNavigate();
  const { entryPoint, isLoading } = useEntryPoint(projectId, entryPointId);

  return (
    <Paper variant="outlined">
      <Box sx={{ px: 3, py: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="subtitle2">Entry Points</Typography>
        <Typography variant="caption" color="text.secondary">Where this flow starts.</Typography>
      </Box>
      <Box sx={{ p: 3 }}>
        {isLoading ? (
          <Typography variant="body2" color="text.secondary">Loading…</Typography>
        ) : entryPoint ? (
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              {isKnownKind(entryPoint.type) ? <EntryKindIcon kind={entryPoint.type} size={20} /> : null}
              <Box>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{entryPoint.name}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {isKnownKind(entryPoint.type) ? KIND_META[entryPoint.type].label : entryPoint.type}
                  {formatTrigger(entryPoint) ? ` · ${formatTrigger(entryPoint)}` : ''}
                </Typography>
              </Box>
            </Stack>
            <Button
              size="small"
              endIcon={<ArrowForwardIcon />}
              onClick={() => navigate(`/codebases/${projectSlug ?? projectId}/entry-points/${encodeSlug({ id: entryPoint.id, name: entryPoint.name })}`)}
            >
              View entry point
            </Button>
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No entry point record matched this flow's id yet — see apps/app/docs/DESIGN-NOTES.md.
          </Typography>
        )}
      </Box>
    </Paper>
  );
}
