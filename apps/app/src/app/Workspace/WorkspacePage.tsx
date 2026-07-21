import { useEffect } from 'react';
import { Grid, Stack } from '@mui/material';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useWorkspaceAnalysis } from '@/shared/hooks/useWorkspaceAnalysis';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import { useResolvedWorkspaceId } from '@/shared/hooks/useResolvedWorkspaceId';
import { encodeSlug } from '@/shared/lib/slugs';
import { LoadingState } from '@/shared/layout/LoadingState';
import { EmptyState } from '@/shared/layout/EmptyState';
import { ErrorState } from '@/shared/layout/ErrorState';
import { WorkspaceHeader } from './WorkspaceHeader';
import { SystemMapCard } from './SystemMapCard';
import { SystemComplexityCard } from './SystemComplexityCard';
import { ChangeActivityPanel } from '@/app/Dashboard/ChangeActivityPanel';
import { RepositoriesSection } from './RepositoriesSection';
import { getGraphExtras } from './workspaceHelpers';

export function WorkspacePage() {
  const { workspaceId: routeParam } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const workspacesQuery = useWorkspaces();
  const resolvedId = useResolvedWorkspaceId(routeParam);
  const workspaceId = resolvedId ?? routeParam;
  const query = useWorkspaceAnalysis(workspaceId);

  useEffect(() => {
    const workspace = workspacesQuery.data?.workspaces.find(w => w.id === resolvedId);
    if (!workspace || !routeParam) return;
    const canonical = encodeSlug(workspace);
    if (routeParam !== canonical) navigate(`/workspaces/${canonical}`, { replace: true });
  }, [workspacesQuery.data, resolvedId, routeParam, navigate, location.pathname]);

  if (query.isLoading) {
    return <LoadingState label="Loading this workspace…" />;
  }

  if (query.isError) {
    return <ErrorState message="Could not load this workspace. Try refreshing the page." onRetry={() => query.refetch()} />;
  }

  const data = query.data;
  if (!data || data.status === 'none') {
    return (
      <EmptyState
        title="No analysis yet"
        description="This workspace hasn't produced a system-level analysis yet — attach a project to get started."
      />
    );
  }

  const graph = data.analysis;
  const extras = getGraphExtras(graph);
  const codebases = graph?.codebases ?? [];
  const runtimeComponents = graph?.runtime_components ?? [];
  const runtimeLinks = graph?.runtime_links ?? [];

  return (
    <Stack spacing={4}>
      <WorkspaceHeader
        name={data.workspace_name ?? graph?.workspace_narrative?.title ?? 'Workspace'}
        narrative={graph?.workspace_narrative}
        generatedAt={data.generated_at}
        enrichmentStatus={data.enrichment}
        lastAttempt={data.last_attempt}
        stats={{
          repositories: graph?.summary?.codebases ?? codebases.length,
          capabilities: graph?.summary?.capabilities,
          flows: extras.workflowCount,
          entities: graph?.summary?.entities,
          contributors: extras.contributors.length || undefined,
        }}
      />

      {query.data?.status === 'pending' ? (
        <EmptyState title="Rebuilding…" description="A newer analysis is being generated for this workspace." />
      ) : null}

      <Grid container spacing={3} sx={{ alignItems: 'stretch' }}>
        <Grid size={{ xs: 12, md: 7 }}>
          {/* SystemMapCard builds a same-subtree /workspaces/:id/map link — pass the
             URL's OWN (already-canonical) slug, not the resolved real id, so the
             emitted link stays slug-form. */}
          <SystemMapCard workspaceId={routeParam ?? ''} components={runtimeComponents} links={runtimeLinks} />
        </Grid>
        <Grid size={{ xs: 12, md: 5 }}>
          <Stack spacing={3}>
            <SystemComplexityCard complexity={graph?.workspace_complexity} />
            <ChangeActivityPanel workspaceId={workspaceId} />
          </Stack>
        </Grid>
      </Grid>

      <RepositoriesSection
        workspaceId={workspaceId ?? ''}
        codebases={codebases}
        inputs={extras.inputs}
        contributors={extras.contributors}
        memberProjectIds={data.member_project_ids ?? []}
      />
    </Stack>
  );
}
