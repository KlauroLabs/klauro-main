import { useNavigate } from 'react-router-dom';
import { List, ListItemButton, ListItemText, Typography, Chip, Stack } from '@mui/material';
import { EXIT_KIND_META } from './exitPointFamilies';
import type { ExitPoint } from '../../hooks/useExitPoints';

/**
 * The clickable row list for one exit-point family. Distinct from the
 * shared src/components/ExitPointList.tsx (built by the page-entry-points
 * lane for a compact, non-interactive mirror summary — its own docstring
 * invites this lane to reuse it for that narrower purpose, which
 * ExitPointsSection does not need: every row here must drill through to the
 * touching function node, which the shared component doesn't support).
 * Evidence (file:line) renders whenever the analyzer attached metadata —
 * per the brief's data-reality rule, absence is a real, common case, not an
 * error.
 */
export function FamilyExitList({ exitPoints, projectId }: { exitPoints: ExitPoint[]; projectId: string }) {
  const navigate = useNavigate();

  return (
    <List dense disablePadding>
      {exitPoints.map(exit => {
        const meta = EXIT_KIND_META[exit.type];
        const target = exit.target?.endpoint || exit.target?.resource || exit.target?.sdk || exit.target?.service_id;
        const evidence = exit.metadata?.file
          ? `${exit.metadata.file}${exit.metadata.line ? `:${exit.metadata.line}` : ''}`
          : undefined;
        return (
          <ListItemButton
            key={exit.id}
            disableGutters
            sx={{ py: 1, borderBottom: '1px solid', borderColor: 'divider' }}
            onClick={() => navigate(`/codebases/${projectId}/functions/${encodeURIComponent(exit.source_node)}`)}
          >
            <ListItemText
              primary={exit.name}
              secondary={
                <Stack component="span" direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  {target ? (
                    <Typography component="span" variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                      {target}
                    </Typography>
                  ) : null}
                  {evidence ? (
                    <Typography component="span" variant="caption" color="text.secondary">
                      {evidence}
                    </Typography>
                  ) : null}
                </Stack>
              }
            />
            <Chip size="small" variant="outlined" label={meta.label} />
          </ListItemButton>
        );
      })}
    </List>
  );
}
