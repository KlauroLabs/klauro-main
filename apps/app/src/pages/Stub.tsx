// Typed placeholder for a route whose real page component hasn't landed yet.
// router.tsx lazy-imports each page lane's declared module; when that module
// doesn't exist on disk yet, the route falls back to this component so the
// app still builds/typechecks/runs while lanes are mid-flight (per
// LANE-COMMON's fabric protocol — in-flight reuse, never a broken build).
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
