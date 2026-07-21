import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Box, Stack } from '@mui/material';
import { PageHeader } from '@/shared/layout/PageHeader';
import { LoadingState } from '@/shared/layout/LoadingState';
import { EmptyState } from '@/shared/layout/EmptyState';
import { ErrorState } from '@/shared/layout/ErrorState';
import { useNodesForFile } from '@/shared/hooks/useFileNodes';
import { RelationshipList, type RelationshipRow } from './RelationshipList';

export function FileNodesPage() {
  const { projectId, '*': filePath } = useParams<{ projectId: string; '*': string }>();
  const navigate = useNavigate();

  const query = useNodesForFile(projectId, filePath);

  const groups = useMemo(() => {
    const byType = new Map<string, typeof query.nodes>();
    for (const node of query.nodes) {
      const list = byType.get(node.type) ?? [];
      list.push(node);
      byType.set(node.type, list);
    }
    return Array.from(byType, ([type, nodes]) => ({
      type,
      rows: [...nodes]
        .sort((a, b) => (a.source?.line ?? 0) - (b.source?.line ?? 0))
        .map((n): RelationshipRow => ({
          key: n.id,
          label: n.name,
          sublabel: n.source?.line ? `line ${n.source.line}` : undefined,
          onClick: () => navigate(`/codebases/${projectId}/functions/${encodeURIComponent(n.id)}`),
        })),
    })).sort((a, b) => b.rows.length - a.rows.length);
  }, [query.nodes, navigate, projectId]);

  if (!projectId || !filePath) return null;
  if (query.isLoading) return <LoadingState label="Loading file…" />;
  if (query.isError) return <ErrorState message="Could not load this file's nodes." />;

  if (query.nodes.length === 0) {
    return (
      <EmptyState
        title="No nodes found for this file"
        description="Either this file has no browsable nodes (pure config/markup), or its path no longer matches the current analysis."
      />
    );
  }

  return (
    <Box>
      <PageHeader title={filePath} subtitle={`${query.nodes.length.toLocaleString()} nodes across ${groups.length} type(s).`} />
      <Stack spacing={3} sx={{ mt: 3 }}>
        {groups.map(group => (
          <RelationshipList key={group.type} title={group.type} rows={group.rows} emptyLabel="" />
        ))}
      </Stack>
    </Box>
  );
}
