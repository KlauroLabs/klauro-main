import { Button, Fade, Snackbar, Typography } from '@mui/material';
import { useDeployFreshness } from '@/shared/hooks/useDeployFreshness';

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
