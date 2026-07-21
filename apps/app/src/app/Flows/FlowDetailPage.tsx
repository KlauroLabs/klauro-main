import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Box, Grid, Stack } from '@mui/material';
import { LoadingState } from '@/shared/layout/LoadingState';
import { EmptyState } from '@/shared/layout/EmptyState';
import { ErrorState } from '@/shared/layout/ErrorState';
import { useFlow } from '@/shared/hooks/useFlow';
import { useProjectSummary } from '@/shared/hooks/useProjectSummary';
import { useResolvedProjectId } from '@/shared/hooks/useResolvedProjectId';
import { encodeSlug } from '@/shared/lib/slugs';
import { asExtendedSummary } from '@/app/Codebase/casSummary';
import { formatRelativeTime } from '@/app/Dashboard/formatRelativeTime';
import { FlowDetailHeader } from './FlowDetailHeader';
import { StepChain } from './StepChain';
import { StepDetailPanel } from './StepDetailPanel';
import { FlowConnectionMap } from './FlowConnectionMap';
import { FlowDataSection } from './FlowDataSection';
import { FlowSystemEffectsSection } from './FlowSystemEffectsSection';
import { FlowEntryPointSection } from './FlowEntryPointSection';

export function FlowDetailPage() {
  const { projectId: routeParam, flowId } = useParams<{ projectId: string; flowId: string }>();
  const projectId = useResolvedProjectId(routeParam) ?? routeParam;
  const navigate = useNavigate();
  const flowQuery = useFlow(projectId, flowId);
  const summaryQuery = useProjectSummary(projectId);

  useEffect(() => {
    if (!routeParam || !flowId || !flowQuery.flow) return;
    const canonical = encodeSlug({ id: flowQuery.flow.flow_id, name: flowQuery.flow.name });
    if (flowId !== canonical) navigate(`/codebases/${routeParam}/flows/${canonical}`, { replace: true });
  }, [routeParam, flowId, flowQuery.flow, navigate]);
  const [selectedStepId, setSelectedStepId] = useState<string | undefined>(undefined);

  useEffect(() => {
    setSelectedStepId(undefined);
  }, [flowId]);

  if (!projectId || !flowId) return null;
  if (flowQuery.isLoading) return <LoadingState label="Loading flow…" />;
  if (flowQuery.isError) return <ErrorState message="Could not load this flow." />;
  if (!flowQuery.flow) {
    return <EmptyState title="Flow not found" description="It may have been removed by a newer analysis, or the flows list was truncated before reaching it — try narrowing the flows list search." />;
  }

  const flow = flowQuery.flow;
  const selectedStep = selectedStepId ? flow.steps.find(s => s.step_id === selectedStepId) : undefined;
  const selectedIndex = selectedStep ? flow.steps.findIndex(s => s.step_id === selectedStep.step_id) : -1;
  const summary = asExtendedSummary(summaryQuery.data?.summary);
  const updated = formatRelativeTime(summary?.analysis_timestamp);

  return (
    <Box>
      <FlowDetailHeader flow={flow} updated={updated} />

      <Grid container spacing={3} sx={{ mt: 1 }}>
        <Grid size={{ xs: 12, md: 8 }}>
          <Stack spacing={3}>
            <StepChain steps={flow.steps} selectedStepId={selectedStep?.step_id} onSelect={setSelectedStepId} />
            <FlowConnectionMap flow={flow} />
            <FlowDataSection contract={flow.contract} />
            <FlowSystemEffectsSection sideEffects={flow.contract.side_effects} />
            <FlowEntryPointSection projectId={projectId} projectSlug={routeParam} entryPointId={flow.entry_point} />
          </Stack>
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          {selectedStep ? (
            <StepDetailPanel
              step={selectedStep}
              index={selectedIndex}
              total={flow.steps.length}
              onClose={() => setSelectedStepId(undefined)}
            />
          ) : null}
        </Grid>
      </Grid>
    </Box>
  );
}
