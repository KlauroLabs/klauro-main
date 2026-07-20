import { Box, CircularProgress, Typography } from '@mui/material';

export function LoadingState({ label }: { label?: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 6, justifyContent: 'center' }}>
      <CircularProgress size={20} />
      <Typography variant="body2" color="text.secondary">
        {label ?? 'Loading…'}
      </Typography>
    </Box>
  );
}
