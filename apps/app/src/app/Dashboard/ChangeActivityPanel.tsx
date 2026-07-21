import { Alert, Box, CircularProgress, Stack, Typography } from '@mui/material';
import { EmptyState } from '@/shared/layout/EmptyState';
import { useAccountActivity, useWorkspaceActivity, type ChangeActivityEvent } from '@/shared/hooks/useChangeActivity';
import { formatRelativeTime } from './formatRelativeTime';

export function ChangeActivityPanel({ workspaceId }: { workspaceId?: string }) {
  const accountQuery = useAccountActivity();
  const workspaceQuery = useWorkspaceActivity(workspaceId);
  const query = workspaceId ? workspaceQuery : accountQuery;

  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 4 }}>
      <Stack spacing={3}>
        <Stack spacing={1}>
          <Typography variant="h6" component="h2">
            Change Activity
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {workspaceId ? 'Recent changes in this workspace' : 'Recent changes across your system'}
          </Typography>
        </Stack>

        {query.isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={20} />
          </Box>
        ) : query.isError ? (
          <Alert severity="error" variant="outlined">
            Could not load change activity.
          </Alert>
        ) : !query.data || query.data.events.length === 0 ? (
          <EmptyState
            title="No recent changes yet"
            description="Change history for your workspaces will appear here once something happens."
          />
        ) : (
          <Stack spacing={2} divider={<Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }} />}>
            {query.data.events.map((event, i) => (
              <ActivityRow key={`${event.type}-${event.at}-${i}`} event={event} />
            ))}
          </Stack>
        )}
      </Stack>
    </Box>
  );
}

function ActivityRow({ event }: { event: ChangeActivityEvent }) {
  const relative = formatRelativeTime(event.at);
  return (
    <Stack spacing={0.5}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {event.title}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        {event.detail ? (
          <Typography variant="caption" color="text.secondary">
            {event.detail}
          </Typography>
        ) : null}
        {event.deltas ? (
          <Typography variant="caption" color="text.secondary">
            {formatDelta(event.deltas.nodes)} nodes &middot; {formatDelta(event.deltas.edges)} edges
          </Typography>
        ) : null}
        <Typography variant="caption" color="text.disabled">
          {relative ?? event.at}
        </Typography>
      </Stack>
    </Stack>
  );
}

function formatDelta(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
