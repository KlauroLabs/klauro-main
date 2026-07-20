import { useMemo } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import { useAuth } from '../../auth/AuthProvider';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { LoadingState } from '../../layout/LoadingState';
import { EmptyState } from '../../layout/EmptyState';
import { ErrorState } from '../../layout/ErrorState';
import { GreetingHeader } from './GreetingHeader';
import { GlobalSearchBar } from './GlobalSearchBar';
import { JumpBackInCard, type JumpBackInTarget } from './JumpBackInCard';
import { WorkspaceCard } from './WorkspaceCard';
import { ChangeActivityPanel } from './ChangeActivityPanel';
import { formatRelativeTime, latestTimestamp } from './formatRelativeTime';

/**
 * Workspaces overview — route / (Figma "Home", file Ux2aXXgq4jzD9T4TZaDAw8,
 * node 1698-13626; apps/app/docs/DESIGN-NOTES.md has the element-coverage
 * checklist and data-gap notes). Sidebar/topbar chrome is the ui-scaffold
 * lane's AppShell; this component is the content region only.
 */
export function DashboardPage() {
  const { user } = useAuth();
  const workspacesQuery = useWorkspaces();

  const jumpBackIn = useMemo<JumpBackInTarget | null>(() => {
    const data = workspacesQuery.data;
    if (!data) return null;
    let best: JumpBackInTarget | null = null;
    let bestAt = '';
    for (const workspace of data.workspaces) {
      for (const project of data.projectsByWorkspace[workspace.id] ?? []) {
        const latest = latestTimestamp((data.revisionsByProject[project.id] ?? []).map(r => r.generated_at));
        if (latest && latest > bestAt) {
          bestAt = latest;
          best = { project, workspaceId: workspace.id, workspaceName: workspace.name };
        }
      }
    }
    return best;
  }, [workspacesQuery.data]);

  const freshnessLabel = useMemo(() => {
    const data = workspacesQuery.data;
    if (!data) return null;
    const allTimestamps = Object.values(data.revisionsByProject).flatMap(revisions => revisions.map(r => r.generated_at));
    return formatRelativeTime(latestTimestamp(allTimestamps));
  }, [workspacesQuery.data]);

  if (workspacesQuery.isLoading) {
    return <LoadingState label="Loading your workspaces…" />;
  }

  if (workspacesQuery.isError) {
    return <ErrorState message="Could not load your workspaces. Try refreshing the page." />;
  }

  const data = workspacesQuery.data;
  if (!data || data.workspaces.length === 0) {
    return (
      <EmptyState
        title="No workspaces yet"
        description="Create or attach a workspace to see it here."
      />
    );
  }

  const name = user?.name?.split(' ')[0] || user?.email?.split('@')[0] || 'there';

  return (
    <Stack spacing={4} sx={{ flexDirection: { xs: 'column', lg: 'row' }, alignItems: 'flex-start' }}>
      <Stack spacing={4} sx={{ flex: '1 1 0', minWidth: 0, width: '100%' }}>
        <Stack spacing={3}>
          <GreetingHeader name={name} freshnessLabel={freshnessLabel} />
          <GlobalSearchBar />
        </Stack>

        <Stack spacing={2}>
          <Typography variant="h6" component="h2">
            Jump Back In
          </Typography>
          {jumpBackIn ? (
            <JumpBackInCard target={jumpBackIn} />
          ) : (
            <EmptyState title="Nothing analyzed yet" description="Once a codebase finishes analyzing, it will show up here." />
          )}
        </Stack>

        <Stack spacing={2}>
          <Typography variant="h6" component="h2">
            Workspace
          </Typography>
          <Stack spacing={1.5}>
            {data.workspaces.map(workspace => (
              <WorkspaceCard key={workspace.id} workspace={workspace} />
            ))}
          </Stack>
        </Stack>
      </Stack>

      <Box sx={{ flex: '0 0 auto', width: { xs: '100%', lg: 400 } }}>
        <ChangeActivityPanel />
      </Box>
    </Stack>
  );
}
