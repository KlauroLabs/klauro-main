// Overview section — route /codebases/:projectId (index) and .../overview.
// This IS the Figma "Repo overview" screen (file Ux2aXXgq4jzD9T4TZaDAw8,
// node 1647:37709): header, 4-card stat row, then the 5 numbered sections in
// their designed order, each a PREVIEW linking to its own full route. Every
// element the Figma frame shows is built (see the per-section files for
// exact node references); nothing beyond it is added. Element-coverage
// checklist lives in this lane's report.
import { Box, Stack } from '@mui/material';
import { useParams } from 'react-router-dom';
import { LoadingState } from '../../layout/LoadingState';
import { ErrorState } from '../../layout/ErrorState';
import { EmptyState } from '../../layout/EmptyState';
import { useProjectSummary } from '../../hooks/useProjectSummary';
import { useProjectConceptual } from '../../hooks/useProjectConceptual';
import { useReanalyzeProject } from '../../hooks/useReanalyze';
import { useDasIndex } from '../../hooks/useDasUnits';
import { CodebaseHeader } from './CodebaseHeader';
import { CodebaseStats } from './CodebaseStats';
import { CapabilitiesSection } from './sections/CapabilitiesSection';
import { CriticalFlowsSection } from './sections/CriticalFlowsSection';
import { KeyEntitiesSection } from './sections/KeyEntitiesSection';
import { ArchitectureSection } from './sections/ArchitectureSection';
import { DependenciesSection } from './sections/DependenciesSection';
import { asExtendedSummary, mergeCapabilities } from './casSummary';

export function CodebaseOverview() {
  const { projectId } = useParams<{ projectId: string }>();
  const summaryQuery = useProjectSummary(projectId);
  const conceptualQuery = useProjectConceptual(projectId);
  const reanalyze = useReanalyzeProject();
  const dasIndex = useDasIndex(projectId);

  if (!projectId) return null;

  if (summaryQuery.isLoading || conceptualQuery.isLoading) {
    return <LoadingState label="Loading codebase overview…" />;
  }
  if (summaryQuery.isError || conceptualQuery.isError) {
    return <ErrorState message="Could not load this codebase's overview." />;
  }
  if (summaryQuery.data?.status === 'no_analysis' || !summaryQuery.data?.summary) {
    return (
      <EmptyState
        title="No analysis yet"
        description="This codebase hasn't been analyzed. Run an analysis to see its overview, capabilities, and architecture."
      />
    );
  }

  const summary = asExtendedSummary(summaryQuery.data.summary)!;
  const conceptual = conceptualQuery.data?.status === 'ready' ? conceptualQuery.data : undefined;
  const capabilities = mergeCapabilities(summaryQuery.data.product_map?.capabilities, conceptual?.capabilities);
  const architectureSummary = summary.architecture_summary;

  return (
    <Box>
      <CodebaseHeader
        name={summary.name || projectId}
        description={summary.description}
        analysisTimestamp={summary.analysis_timestamp}
        onReanalyze={() => reanalyze.mutate({ id: projectId, name: summary.name || projectId })}
        reanalyzing={reanalyze.isPending}
      />
      <CodebaseStats
        capabilityCount={summary.capabilities}
        entryPointCount={summary.entry_points}
        totalFiles={architectureSummary?.total_files}
      />
      <Stack>
        <CapabilitiesSection projectId={projectId} capabilities={capabilities} />
        <CriticalFlowsSection projectId={projectId} flows={conceptual?.flows?.flows ?? []} />
        <KeyEntitiesSection projectId={projectId} entityNames={summary.database_entities ?? []} />
        <ArchitectureSection
          projectId={projectId}
          systemType={summary.architecture_type}
          patterns={summary.architectural_patterns ?? architectureSummary?.architectural_patterns ?? []}
          deployableEvidence={dasIndex.evidence}
        />
        <DependenciesSection projectId={projectId} />
      </Stack>
    </Box>
  );
}
