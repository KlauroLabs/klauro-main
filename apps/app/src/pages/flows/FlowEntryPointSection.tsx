import { Box, Button, Paper, Stack, Typography } from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { useNavigate } from 'react-router-dom';
import { EntryKindIcon } from '../../components/EntryKindIcon';
import { KIND_META, isKnownKind } from '../../components/entryPointKinds';
import { useEntryPoint } from '../../hooks/useEntryPoints';
import { encodeSlug } from '../../lib/slugs';
import { formatTrigger } from '../entry-points/formatEntryPoint';

/**
 * "Entry Points" (Figma node 2095:8307) — the flow's single starting point,
 * the mirror image of the entry-points lane's FlowCard ("the flow it
 * opens"). This is that same entry<->flow pairing read from the other
 * direction: the flow carries the richness (per LANE-COMMON's task brief),
 * this card is the link back to where it started.
 *
 * The card body Figma shows here (a "Constraints" bullet list) is a
 * copy-paste placeholder left over from the component the mock reused —
 * already flagged by the entry-points lane in DESIGN-NOTES.md ("the same
 * placeholder subtitle text... i.e. a copy-paste placeholder in the mock,
 * not real designed copy"). This build honors the card's SHAPE (a bordered
 * section with a titled row) and fills it with the real entry point instead
 * of replaying that placeholder text.
 */
export function FlowEntryPointSection({
  projectId,
  projectSlug,
  entryPointId,
}: {
  /** Resolved backend id — used for the data fetch. */
  projectId: string;
  /** The route's own canonical slug — used for the outbound link so the URL
   *  stays slug-form. Falls back to `projectId` when not supplied. */
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
