import { Box, Stack } from '@mui/material';
import { useParams } from 'react-router-dom';
import { LoadingState } from '@/shared/layout/LoadingState';
import { ErrorState } from '@/shared/layout/ErrorState';
import { EmptyState } from '@/shared/layout/EmptyState';
import { useResolvedProjectId } from '@/shared/hooks/useResolvedProjectId';
import { useProjectSummary } from '@/shared/hooks/useProjectSummary';
import { useProjectConceptual } from '@/shared/hooks/useProjectConceptual';
import { useReanalyzeProject } from '@/shared/hooks/useReanalyze';
import { useSubCasNodeIndex } from '@/shared/hooks/useSubCasNodes';
import { useArchitectureConcepts } from '@/shared/hooks/useArchitectureConcepts';
import { useEntryPoints } from '@/shared/hooks/useEntryPoints';
import { CodebaseHeader } from './CodebaseHeader';
import { CodebaseStats } from './CodebaseStats';
import { CapabilitiesSection } from '@/app/Codebase/sections/CapabilitiesSection';
import { CriticalFlowsSection } from '@/app/Codebase/sections/CriticalFlowsSection';
import { KeyEntitiesSection } from '@/app/Codebase/sections/KeyEntitiesSection';
import { ArchitectureSection } from '@/app/Codebase/sections/ArchitectureSection';
import { DependenciesSection } from '@/app/Codebase/sections/DependenciesSection';
import { asExtendedSummary, mergeCapabilities } from './casSummary';

export function CodebaseOverview() {
  const { projectId: routeParam } = useParams<{ projectId: string }>();
  const projectId = useResolvedProjectId(routeParam) ?? routeParam;
  const summaryQuery = useProjectSummary(projectId);
  const conceptualQuery = useProjectConceptual(projectId);
  const reanalyze = useReanalyzeProject();
  const subCasNodeIndex = useSubCasNodeIndex(projectId);
  const concepts = useArchitectureConcepts(projectId);

  const entryPointsQuery = useEntryPoints(projectId);

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
        sourceAt={summary.repo_facts?.last_commit_at}
        onReanalyze={() => reanalyze.mutate({ id: projectId, name: summary.name || projectId })}
        reanalyzing={reanalyze.isPending}
      />
      <CodebaseStats
        capabilityCount={summary.capabilities}
        entryPointCount={entryPointsQuery.allEntryPoints.length}
        totalFiles={architectureSummary?.total_files}
        contributorCount={summary.repo_facts?.contributor_count}
        firstCommitAt={summary.repo_facts?.first_commit_at}
      />
      <Stack>
        <CapabilitiesSection projectId={routeParam ?? projectId} capabilities={capabilities} />
        <CriticalFlowsSection projectId={routeParam ?? projectId} flows={conceptual?.flows?.flows ?? []} />
        <KeyEntitiesSection projectId={routeParam ?? projectId} entityNames={summary.database_entities ?? []} />
        <ArchitectureSection
          projectId={routeParam ?? projectId}
          systemType={summary.architecture_type}
          patterns={summary.architectural_patterns ?? architectureSummary?.architectural_patterns ?? []}
          deployableEvidence={subCasNodeIndex.evidence}
          conceptInventory={concepts.inventory}
          conceptEdges={concepts.edges}
        />
        <DependenciesSection projectId={projectId} slug={routeParam} />
      </Stack>
    </Box>
  );
}
