import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Box, Grid, Stack } from '@mui/material';
import { LoadingState } from '../../layout/LoadingState';
import { EmptyState } from '../../layout/EmptyState';
import { ErrorState } from '../../layout/ErrorState';
import { useFlow } from '../../hooks/useFlow';
import { useProjectSummary } from '../../hooks/useProjectSummary';
import { asExtendedSummary } from '../codebase/casSummary';
import { formatRelativeTime } from '../dashboard/formatRelativeTime';
import { FlowDetailHeader } from './FlowDetailHeader';
import { StepChain } from './StepChain';
import { StepDetailPanel } from './StepDetailPanel';
import { FlowConnectionMap } from './FlowConnectionMap';
import { FlowDataSection } from './FlowDataSection';
import { FlowSystemEffectsSection } from './FlowSystemEffectsSection';
import { FlowEntryPointSection } from './FlowEntryPointSection';

/**
 * One flow in full — route /codebases/:projectId/flows/:flowId (Figma
 * "Flow Overview", node 1982:5977, DESIGNED — see SCREEN-MAP.md). Section
 * order mirrors the frame top to bottom: step chain, connection map, data
 * (flow-level ILSO), system effects, entry points. The right-hand sticky
 * panel is the currently-selected step's own narrower contract.
 */
export function FlowDetailPage() {
  const { projectId, flowId } = useParams<{ projectId: string; flowId: string }>();
  const flowQuery = useFlow(projectId, flowId);
  const summaryQuery = useProjectSummary(projectId);
  const [selectedStepId, setSelectedStepId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (flowQuery.flow && !selectedStepId) {
      setSelectedStepId(flowQuery.flow.steps[0]?.step_id);
    }
  }, [flowQuery.flow, selectedStepId]);

  if (!projectId || !flowId) return null;
  if (flowQuery.isLoading) return <LoadingState label="Loading flow…" />;
  if (flowQuery.isError) return <ErrorState message="Could not load this flow." />;
  if (!flowQuery.flow) {
    return <EmptyState title="Flow not found" description="It may have been removed by a newer analysis, or the flows list was truncated before reaching it — try narrowing the flows list search." />;
  }

  const flow = flowQuery.flow;
  const selectedStep = flow.steps.find(s => s.step_id === selectedStepId) ?? flow.steps[0];
  const selectedIndex = flow.steps.findIndex(s => s.step_id === selectedStep?.step_id);
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
            <FlowEntryPointSection projectId={projectId} entryPointId={flow.entry_point} />
          </Stack>
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          {selectedStep ? <StepDetailPanel step={selectedStep} index={selectedIndex} total={flow.steps.length} /> : null}
        </Grid>
      </Grid>
    </Box>
  );
}
