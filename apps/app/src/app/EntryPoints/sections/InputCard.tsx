import { Box, Chip, List, ListItem, ListItemText, Typography } from '@mui/material';
import type { EntryPoint } from '@/shared/hooks/useEntryPoints';

export function InputCard({ entryPoint }: { entryPoint: EntryPoint }) {
  const fields = entryPoint.input?.fields ?? [];
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        What it expects
      </Typography>
      {fields.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Nothing. It takes no input — this is the common, real case for scheduled jobs and most
          async or passive entry points.
        </Typography>
      ) : (
        <List dense disablePadding>
          {fields.map((f, i) => (
            <ListItem key={`${f.name ?? i}-${i}`} disableGutters sx={{ py: 0.5 }}>
              <ListItemText
                primary={
                  <>
                    <Typography component="code" variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
                      {f.name ?? '(positional)'}
                    </Typography>{' '}
                    <Typography component="span" variant="body2" color="text.secondary">
                      {f.type}
                    </Typography>
                  </>
                }
              />
            </ListItem>
          ))}
        </List>
      )}
      {entryPoint.input?.is_positional_only ? (
        <Chip size="small" variant="outlined" label="Positional only" sx={{ mt: 1 }} />
      ) : null}
    </Box>
  );
}
