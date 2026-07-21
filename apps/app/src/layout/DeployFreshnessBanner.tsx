import { Button, Fade, Snackbar, Typography } from '@mui/material';
import { useDeployFreshness } from '../hooks/useDeployFreshness';

/**
 * Quiet "New version available — Refresh" affordance (LANE-COMMON item 5) —
 * a snackbar rather than a modal/banner that pushes content, since this is
 * informational, not blocking: the current tab still works fine on the old
 * build, this just offers to pick up the new one. See useDeployFreshness.ts
 * for the polling/comparison mechanism.
 */
export function DeployFreshnessBanner() {
  const { updateAvailable, refresh } = useDeployFreshness();
  return (
    <Snackbar
      open={updateAvailable}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      slots={{ transition: Fade }}
      message={<Typography variant="body2">New version available</Typography>}
      action={
        <Button color="inherit" size="small" onClick={refresh}>
          Refresh
        </Button>
      }
    />
  );
}
