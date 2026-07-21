// Full Capabilities catalog — route /codebases/:projectId/capabilities.
// DERIVED route (no distinct Figma frame — see SCREEN-MAP.md); layout
// derives from the Overview screen's section-01 card, extended with the
// fields that only fit a full-page density: category, criticality, and the
// related-flow roles (the one/many/none shapes: cross-cutting capabilities
// relate to MANY flows, infrastructure-only ones to NONE, a typical
// capability to one primary + a few supporting — see
// apps/app/docs/briefs/capabilities.md).
import { Box, Chip, Paper, Stack, Typography } from '@mui/material';
import { useParams } from 'react-router-dom';
import { LoadingState } from '../../layout/LoadingState';
import { ErrorState } from '../../layout/ErrorState';
import { EmptyState } from '../../layout/EmptyState';
import { useResolvedProjectId } from '../../hooks/useResolvedProjectId';
import { useProjectSummary } from '../../hooks/useProjectSummary';
import { useProjectConceptual } from '../../hooks/useProjectConceptual';
import { mergeCapabilities, type MergedCapability } from './casSummary';

const criticalityColor: Record<string, 'error' | 'warning' | 'default'> = {
  critical: 'error',
  high: 'warning',
};

function CapabilityRow({ capability }: { capability: MergedCapability }) {
  const roleCount = capability.relatedFlows?.length ?? 0;
  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
        <Typography variant="subtitle1">{capability.name}</Typography>
        <Stack direction="row" spacing={1}>
          {capability.category ? <Chip size="small" label={capability.category} /> : null}
          {capability.criticality ? (
            <Chip size="small" label={capability.criticality} color={criticalityColor[capability.criticality] ?? 'default'} />
          ) : null}
        </Stack>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {capability.description || 'No description available yet.'}
      </Typography>
      <Stack direction="row" spacing={3} sx={{ mb: roleCount ? 1.5 : 0 }}>
        <Typography variant="caption" color="text.disabled">
          {capability.flowCount ?? 0} operation{capability.flowCount === 1 ? '' : 's'}
        </Typography>
        <Typography variant="caption" color="text.disabled">
          {capability.entityCount ?? '—'} entities
        </Typography>
      </Stack>
      {/* One/many/none shape: a capability may relate to no flows (pure
          infrastructure), one, or many (cross-cutting, e.g. auth) — all three
          are real, correct shapes, not a data gap. */}
      {roleCount > 0 ? (
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          {capability.relatedFlows!.map(rel => (
            <Chip key={rel.flow_id} size="small" variant="outlined" label={`${rel.role} · ${rel.flow_id}`} />
          ))}
        </Stack>
      ) : (
        <Typography variant="caption" color="text.disabled">No linked flows (infrastructure-only capability).</Typography>
      )}
    </Paper>
  );
}

export function CodebaseCapabilities() {
  const { projectId: routeParam } = useParams<{ projectId: string }>();
  const projectId = useResolvedProjectId(routeParam) ?? routeParam;
  const summaryQuery = useProjectSummary(projectId);
  const conceptualQuery = useProjectConceptual(projectId);

  if (!projectId) return null;
  if (summaryQuery.isLoading || conceptualQuery.isLoading) return <LoadingState label="Loading capabilities…" />;
  if (summaryQuery.isError || conceptualQuery.isError) return <ErrorState message="Could not load capabilities for this codebase." />;

  const conceptual = conceptualQuery.data?.status === 'ready' ? conceptualQuery.data : undefined;
  const capabilities = mergeCapabilities(summaryQuery.data?.product_map?.capabilities, conceptual?.capabilities);

  if (capabilities.length === 0) {
    return (
      <EmptyState
        title="No capabilities found"
        description="This codebase's analysis found no core business capabilities yet."
      />
    );
  }

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Core business functions, not infrastructure — {capabilities.length} total.
      </Typography>
      {capabilities.map(capability => (
        <CapabilityRow key={capability.id ?? capability.name} capability={capability} />
      ))}
    </Stack>
  );
}
