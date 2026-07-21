import { Stack, Typography } from '@mui/material';

export function Stub({ area }: { area: string }) {
  return (
    <Stack spacing={2}>
      <Typography variant="h4" component="h1">
        {area}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        This section is still being built. Check back shortly.
      </Typography>
    </Stack>
  );
}
