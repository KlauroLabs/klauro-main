import { Box, Typography } from '@mui/material';
import type { EntryPoint } from '@/shared/hooks/useEntryPoints';

export function HandlerCard({ entryPoint }: { entryPoint: EntryPoint }) {
  const handler = entryPoint.handler;
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        Where it lives in code
      </Typography>
      {handler?.file ? (
        <Typography component="code" variant="body2" sx={{ fontFamily: 'monospace' }}>
          {handler.file}
          {handler.line ? `:${handler.line}` : ''}
        </Typography>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Not resolved to a file location.
        </Typography>
      )}
      {handler?.method_name ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          {handler.method_name}
        </Typography>
      ) : null}
    </Box>
  );
}
