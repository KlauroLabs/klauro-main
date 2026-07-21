import { Box, List, ListItem, ListItemText, Typography, Chip } from '@mui/material';

export interface ExitPointSummary {
  id: string;
  type: 'database' | 'api' | 'file' | 'message' | 'event' | 'cache' | 'sdk' | 'webhook' | 'navigation' | 'client_storage' | 'analytics';
  name: string;
  target?: { service_id?: string; endpoint?: string; resource?: string; sdk?: string };
}

export interface ExitPointListProps {
  exitPoints: ExitPointSummary[];
  maxRows?: number;
}

const TYPE_LABEL: Record<ExitPointSummary['type'], string> = {
  database: 'Database',
  api: 'Outbound API',
  file: 'File',
  message: 'Message',
  event: 'Event',
  cache: 'Cache',
  sdk: 'Library / SDK',
  webhook: 'Webhook',
  navigation: 'Navigation',
  client_storage: 'Client storage',
  analytics: 'Analytics',
};

export function ExitPointList({ exitPoints, maxRows }: ExitPointListProps) {
  if (exitPoints.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No exit points reach outside this deployable.
      </Typography>
    );
  }
  const rows = typeof maxRows === 'number' ? exitPoints.slice(0, maxRows) : exitPoints;
  return (
    <List dense disablePadding>
      {rows.map(exit => (
        <ListItem key={exit.id} disableGutters sx={{ py: 1 }}>
          <ListItemText
            primary={exit.name}
            secondary={exit.target?.endpoint || exit.target?.resource || exit.target?.sdk}
          />
          <Chip size="small" variant="outlined" label={TYPE_LABEL[exit.type]} />
        </ListItem>
      ))}
    </List>
  );
}
