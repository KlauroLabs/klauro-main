import { List, ListItem, ListItemText, Typography, Chip, Stack } from '@mui/material';
import type { ExternalService } from '@/shared/hooks/useExternalServices';

const PURPOSE_LABEL: Record<NonNullable<ExternalService['purpose']>, string> = {
  consumption: 'Calls out to it',
  production: 'Feeds data to it',
  bidirectional: 'Two-way',
};

export function ExternalServicesList({ services }: { services: ExternalService[] }) {
  if (services.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No named external services detected — calls that don't resolve to a recognized service still
        show up under Exit Points, just without a service identity attached.
      </Typography>
    );
  }

  return (
    <List dense disablePadding>
      {services.map(service => {
        const evidenceCount = service.exit_points?.length ?? service.connected_nodes?.length ?? 0;
        return (
          <ListItem key={service.id} disableGutters sx={{ py: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
            <ListItemText
              primary={service.name}
              secondary={
                <Stack component="span" direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  {service.endpoint ? (
                    <Typography component="span" variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                      {service.endpoint}
                    </Typography>
                  ) : null}
                  <Typography component="span" variant="caption" color="text.secondary">
                    {evidenceCount} touching call{evidenceCount === 1 ? '' : 's'}
                  </Typography>
                </Stack>
              }
            />
            <Stack direction="row" spacing={1}>
              {service.purpose ? <Chip size="small" variant="outlined" label={PURPOSE_LABEL[service.purpose]} /> : null}
              <Chip size="small" label={service.type} />
            </Stack>
          </ListItem>
        );
      })}
    </List>
  );
}
