import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Box, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useWorkspaceAnalysis } from '@/shared/hooks/useWorkspaceAnalysis';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import { useResolvedWorkspaceId } from '@/shared/hooks/useResolvedWorkspaceId';
import { encodeSlug } from '@/shared/lib/slugs';
import { LoadingState } from '@/shared/layout/LoadingState';
import { EmptyState } from '@/shared/layout/EmptyState';
import { ErrorState } from '@/shared/layout/ErrorState';
import { GraphCanvas } from '@/shared/components/diagram/GraphCanvas';
import { computeGraphNodeLayout, filterEdgesToKnownNodes } from '@/shared/components/diagram/graphLayout';
import { buildWorkspaceMapEdges, buildWorkspaceMapNodes, liveApplications, type WorkspaceMapPerspectiveId } from './workspaceMapData';

const PERSPECTIVES: Array<{ id: WorkspaceMapPerspectiveId; label: string; description: string }> = [
  { id: 'structural', label: 'Structural', description: 'Grouped by application kind — the system as it is deployed.' },
  { id: 'domain', label: 'Domain', description: "Grouped by each application's codebase primary_domain." },
  { id: 'exposure', label: 'Exposure', description: 'Grouped by whether the application declares any listening ports.' },
];

export function WorkspaceMapPage() {
  const { workspaceId: routeParam } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const workspacesQuery = useWorkspaces();
  const resolvedId = useResolvedWorkspaceId(routeParam);
  const workspaceId = resolvedId ?? routeParam;
  const query = useWorkspaceAnalysis(workspaceId);
  const [perspective, setPerspective] = useState<WorkspaceMapPerspectiveId>('structural');

  useEffect(() => {
    const workspace = workspacesQuery.data?.workspaces.find(w => w.id === resolvedId);
    if (!workspace || !routeParam) return;
    const canonical = encodeSlug(workspace);
    if (routeParam !== canonical) navigate(`/workspaces/${canonical}/map`, { replace: true });
  }, [workspacesQuery.data, resolvedId, routeParam, navigate, location.pathname]);

  const graph = query.data?.analysis;
  const applications = useMemo(() => liveApplications(graph?.applications ?? []), [graph?.applications]);
  const liveAppIds = useMemo(() => new Set(applications.map(a => a.id)), [applications]);
  const codebaseByAppId = useMemo(() => new Map(applications.map(a => [a.id, a.codebase_id])), [applications]);
  const codebaseNameById = useMemo(() => new Map((graph?.codebases ?? []).map(c => [c.id, c.name ?? c.id])), [graph?.codebases]);

  const nodes = useMemo(
    () => buildWorkspaceMapNodes(applications, graph?.codebases, perspective),
    [applications, graph?.codebases, perspective],
  );
  const edges = useMemo(() => (graph ? buildWorkspaceMapEdges(graph, liveAppIds) : []), [graph, liveAppIds]);

  const layout = useMemo(() => computeGraphNodeLayout(nodes, { nodeWidth: 176, minHeight: 56, maxHeight: 56 }), [nodes]);
  const nodeIds = useMemo(() => new Set(layout.nodes.map(n => n.id)), [layout.nodes]);
  const visibleEdges = useMemo(() => filterEdgesToKnownNodes(edges, nodeIds), [edges, nodeIds]);

  if (query.isLoading) return <LoadingState label="Loading the system map…" />;
  if (query.isError) return <ErrorState message="Could not load this workspace's system map." onRetry={() => query.refetch()} />;
  if (!query.data || query.data.status === 'none') {
    return <EmptyState title="No analysis yet" description="This workspace hasn't produced a system-level analysis yet." />;
  }
  if (applications.length === 0) {
    return (
      <EmptyState
        title="No applications detected"
        description="Runtime topology appears here once member codebases expose deployable applications."
      />
    );
  }

  return (
    <Stack spacing={3} sx={{ height: '100%' }}>
      <Stack spacing={0.5}>
        <Typography variant="h5">System Map</Typography>
        <Typography variant="body2" color="text.secondary">
          {applications.length} application{applications.length === 1 ? '' : 's'} · {visibleEdges.length} relationship{visibleEdges.length === 1 ? '' : 's'} ·
          click a node to open its codebase
        </Typography>
      </Stack>

      <ToggleButtonGroup
        size="small"
        exclusive
        value={perspective}
        onChange={(_, value) => value && setPerspective(value)}
      >
        {PERSPECTIVES.map(p => (
          <ToggleButton key={p.id} value={p.id}>{p.label}</ToggleButton>
        ))}
      </ToggleButtonGroup>
      <Typography variant="caption" color="text.disabled">
        {PERSPECTIVES.find(p => p.id === perspective)?.description}
      </Typography>

      <Box sx={{ flexGrow: 1, minHeight: 480 }}>
        <GraphCanvas
          nodes={layout.nodes}
          edges={visibleEdges}
          clusters={layout.clusters}
          contentWidth={layout.width}
          contentHeight={layout.height}
          ariaLabel="Workspace system map"
          onNodeClick={nodeId => {
            const codebaseId = codebaseByAppId.get(nodeId);
            if (codebaseId) navigate(`/codebases/${encodeSlug({ id: codebaseId, name: codebaseNameById.get(codebaseId) ?? codebaseId })}`);
          }}
        />
      </Box>
    </Stack>
  );
}
