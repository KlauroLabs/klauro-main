import { useNavigate, useParams } from 'react-router-dom';
import { Box, Button, Stack } from '@mui/material';
import { PageHeader } from '@/shared/layout/PageHeader';
import { LoadingState } from '@/shared/layout/LoadingState';
import { EmptyState } from '@/shared/layout/EmptyState';
import { ErrorState } from '@/shared/layout/ErrorState';
import { useNode } from '@/shared/hooks/useNode';
import { useCallers } from '@/shared/hooks/useCallers';
import { useCallees } from '@/shared/hooks/useCallees';
import { NodeSummaryCard } from './NodeSummaryCard';
import { RiskStabilityCard } from './RiskStabilityCard';
import { RelationshipList, type RelationshipRow } from './RelationshipList';
import type { RelatedNode } from '@/shared/hooks/useCallers';

function toRows(related: RelatedNode[], projectId: string, navigate: (path: string) => void): RelationshipRow[] {
  return related.map(r => ({
    key: r.id,
    label: r.node?.name ?? r.id,
    sublabel: r.node?.source?.file ? `${r.node.source.file}${r.line ? `:${r.line}` : ''}` : r.methodName,
    chip: r.node?.type,
    onClick: r.node ? () => navigate(`/codebases/${projectId}/functions/${encodeURIComponent(r.node!.id)}`) : undefined,
  }));
}

export function FunctionDetailPage() {
  const { projectId, nodeId } = useParams<{ projectId: string; nodeId: string }>();
  const navigate = useNavigate();
  const decodedNodeId = nodeId ? decodeURIComponent(nodeId) : undefined;

  const query = useNode(projectId, decodedNodeId);
  const callersQuery = useCallers(projectId, decodedNodeId);
  const calleesQuery = useCallees(projectId, decodedNodeId);

  if (!projectId) return null;
  if (query.isLoading) return <LoadingState label="Loading node…" />;
  if (query.isError) return <ErrorState message="Could not load this node." />;

  if (!query.node) {
    return (
      <EmptyState
        title="Node not found"
        description="This node isn't in the current analysis — it may have been removed or renamed since the last analysis ran."
      />
    );
  }

  const { node } = query;
  const SIBLING_LIMIT = 25;
  const fileSiblingRows: RelationshipRow[] = query.fileSiblings.slice(0, SIBLING_LIMIT).map(n => ({
    key: n.id,
    label: n.name,
    chip: n.type,
    onClick: () => navigate(`/codebases/${projectId}/functions/${encodeURIComponent(n.id)}`),
  }));
  const siblingsTruncated = query.fileSiblings.length > SIBLING_LIMIT;
  const siblingsTitle = siblingsTruncated
    ? `Other nodes in ${node.source?.file ?? 'this file'} — showing ${SIBLING_LIMIT} of ${query.fileSiblings.length}`
    : `Other nodes in ${node.source?.file ?? 'this file'}`;

  return (
    <Box>
      <PageHeader
        title={node.name}
        subtitle={node.source?.file}
        actions={
          node.source?.file ? (
            <Button
              size="small"
              variant="outlined"
              onClick={() => navigate(`/codebases/${projectId}/functions/file/${node.source!.file!.split('/').map(encodeURIComponent).join('/')}`)}
            >
              View file
            </Button>
          ) : undefined
        }
      />

      <Stack spacing={3} sx={{ mt: 3 }}>
        <NodeSummaryCard node={node} />
        <RiskStabilityCard risk={query.risk} stability={query.stability} />

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={3}>
          <Box sx={{ flex: 1 }}>
            <RelationshipList
              title="Callers"
              rows={toRows(callersQuery.callers, projectId, navigate)}
              emptyLabel="Nothing in this analysis calls this node."
            />
          </Box>
          <Box sx={{ flex: 1 }}>
            <RelationshipList
              title="Callees"
              rows={toRows(calleesQuery.callees, projectId, navigate)}
              emptyLabel="This node doesn't call anything else this analysis traced."
            />
          </Box>
        </Stack>

        <RelationshipList
          title={siblingsTitle}
          rows={fileSiblingRows}
          emptyLabel="No other nodes are recorded in this file."
        />
      </Stack>
    </Box>
  );
}
