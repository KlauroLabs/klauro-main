import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Box, Stack, Typography } from '@mui/material';
import { PageHeader } from '@/shared/layout/PageHeader';
import { LoadingState } from '@/shared/layout/LoadingState';
import { EmptyState } from '@/shared/layout/EmptyState';
import { ErrorState } from '@/shared/layout/ErrorState';
import { useResolvedProjectId } from '@/shared/hooks/useResolvedProjectId';
import { useFlows } from '@/shared/hooks/useFlows';
import { useProjectSummary } from '@/shared/hooks/useProjectSummary';
import { asExtendedSummary } from '@/app/Codebase/casSummary';
import { formatRelativeTime } from '@/app/Dashboard/formatRelativeTime';
import { FlowTable } from './FlowTable';
import { FlowFilters, type FlowFilterState } from './FlowFilters';
import { entryKindFromFlow, linkedCapabilityCount } from './flowFormat';
import type { EntryKind } from '@/shared/components/entryPointKinds';

export function FlowsListPage() {
  const { projectId: routeParam } = useParams<{ projectId: string }>();
  const projectId = useResolvedProjectId(routeParam) ?? routeParam;
  const flowsQuery = useFlows(projectId);
  const summaryQuery = useProjectSummary(projectId);
  const [filters, setFilters] = useState<FlowFilterState>({ search: '', kind: 'all', role: 'all', sort: 'name' });

  const availableKinds = useMemo(() => {
    const seen = new Set<EntryKind>();
    for (const flow of flowsQuery.flows) {
      const kind = entryKindFromFlow(flow);
      if (kind) seen.add(kind);
    }
    return Array.from(seen);
  }, [flowsQuery.flows]);

  const filtered = useMemo(() => {
    let rows = flowsQuery.flows;
    if (filters.kind !== 'all') rows = rows.filter(f => entryKindFromFlow(f) === filters.kind);
    if (filters.role !== 'all') rows = rows.filter(f => (f.role ?? 'unknown') === filters.role);
    const term = filters.search.trim().toLowerCase();
    if (term) rows = rows.filter(f => f.name.toLowerCase().includes(term) || f.intent.toLowerCase().includes(term));

    const sorted = [...rows];
    if (filters.sort === 'steps-desc') sorted.sort((a, b) => b.steps.length - a.steps.length);
    else if (filters.sort === 'capabilities-desc') sorted.sort((a, b) => linkedCapabilityCount(b) - linkedCapabilityCount(a));
    else sorted.sort((a, b) => a.name.localeCompare(b.name));
    return sorted;
  }, [flowsQuery.flows, filters]);

  if (!projectId) return null;
  if (flowsQuery.isLoading) return <LoadingState label="Loading flows…" />;
  if (flowsQuery.isError) return <ErrorState message="Could not load flows for this codebase." />;

  const summary = asExtendedSummary(summaryQuery.data?.summary);
  const updated = formatRelativeTime(summary?.analysis_timestamp);

  if (flowsQuery.flows.length === 0) {
    return (
      <Box>
        <PageHeader title="Flows" subtitle={summary?.description ?? undefined} />
        <EmptyState
          title="No flows found"
          description="This codebase's analysis found no derivable flows yet — a real case for a very small repo, a still-analyzing project, or one whose entry points don't yet resolve into a traceable call chain."
        />
      </Box>
    );
  }

  return (
    <Box>
      {updated ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
          <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'primary.main' }} />
          <Typography variant="caption" color="text.secondary">Updated {updated}</Typography>
        </Stack>
      ) : null}
      <PageHeader title="Flows" subtitle={summary?.description ?? undefined} />

      <Stack spacing={3} sx={{ mt: 3 }}>
        <FlowFilters value={filters} onChange={setFilters} availableKinds={availableKinds} />

        {flowsQuery.totalAvailable !== undefined && flowsQuery.flows.length < flowsQuery.totalAvailable ? (
          <Typography variant="caption" color="text.secondary">
            Showing {flowsQuery.flows.length} of {flowsQuery.totalAvailable} derivable flows — this codebase has more
            flows than fit one fetch. Narrow with search or filters to reach a specific one.
          </Typography>
        ) : null}

        <FlowTable flows={filtered} projectId={routeParam ?? projectId} />
      </Stack>
    </Box>
  );
}
