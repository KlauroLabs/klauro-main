import { Box, Chip, List, ListItemButton, ListItemText, Paper, Stack, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';

export interface RelationshipRow {
  key: string;
  label: string;
  sublabel?: string;
  chip?: string;
  onClick?: () => void;
}

/**
 * A bordered card of named rows, each linking onward — the shared shape
 * behind callers, callees, and "other nodes in this file". Mirrors the
 * card pattern DESIGN-NOTES.md documents for the entry-points lane's
 * input/output and capabilities lists (Flow Overview's "Entry Points" /
 * "System Effects" card shape): title + count badge, bordered list,
 * per-row chevron when the row links onward. This is the mechanism behind
 * "infinite drilldown" — every row here is itself a node this same card
 * shape can be rendered for.
 */
export function RelationshipList({ title, rows, emptyLabel }: { title: string; rows: RelationshipRow[]; emptyLabel: string }) {
  return (
    <Paper variant="outlined">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 2, py: 1.5, borderBottom: rows.length ? '1px solid' : 'none', borderColor: 'divider' }}>
        <Typography variant="subtitle2">{title}</Typography>
        <Chip size="small" label={rows.length} />
      </Stack>
      {rows.length === 0 ? (
        <Box sx={{ px: 2, py: 2 }}>
          <Typography variant="body2" color="text.secondary">{emptyLabel}</Typography>
        </Box>
      ) : (
        <List dense disablePadding>
          {rows.map(row => (
            <ListItemButton key={row.key} onClick={row.onClick} disabled={!row.onClick} divider sx={{ py: 1 }}>
              <ListItemText
                primary={
                  <Typography variant="body2" component="code" sx={{ fontFamily: 'monospace' }}>
                    {row.label}
                  </Typography>
                }
                secondary={row.sublabel}
              />
              {row.chip ? <Chip size="small" variant="outlined" label={row.chip} sx={{ mr: row.onClick ? 1 : 0 }} /> : null}
              {row.onClick ? <ChevronRightIcon fontSize="small" color="disabled" /> : null}
            </ListItemButton>
          ))}
        </List>
      )}
    </Paper>
  );
}
