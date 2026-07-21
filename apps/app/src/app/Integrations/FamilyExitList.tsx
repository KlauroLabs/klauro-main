import { useNavigate } from 'react-router-dom';
import { List, ListItemButton, ListItemText, Typography, Chip, Stack } from '@mui/material';
import { EXIT_KIND_META } from './exitPointFamilies';
import type { ExitPoint } from '@/shared/hooks/useExitPoints';

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
