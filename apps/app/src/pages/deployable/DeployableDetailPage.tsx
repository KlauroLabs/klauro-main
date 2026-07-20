import { useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Box, Stack } from '@mui/material';
import { PageHeader } from '../../layout/PageHeader';
import { LoadingState } from '../../layout/LoadingState';
import { EmptyState } from '../../layout/EmptyState';
import { ErrorState } from '../../layout/ErrorState';
import { useDasIndex, useDasUnitSlice } from '../../hooks/useDasUnits';
import { DasUnitPicker } from './DasUnitPicker';
import { DasUnitOverview } from './DasUnitOverview';
import { DasShipEvidence } from './DasShipEvidence';
import { DasBundledMembers } from './DasBundledMembers';
import { DasEntryPoints } from './DasEntryPoints';
import { DasEntities } from './DasEntities';
import { DasOrphanNotice } from './DasOrphanNotice';

/**
 * The DAS drilldown — route /codebases/:projectId/deployables/:dasUnitId
 * (nested under CodebasePage, per router.tsx). das_index is the picker
 * (LANE-COMMON.md); this page is always scoped to ONE unit, same "one at a
 * time, switch to another" shape entry-points uses for repo-level
 * deployables, one rung more specific. Derived layout — no Figma screen
 * covers a DAS unit drilldown (see DESIGN-NOTES.md); mirrors the
 * entry-points catalog page's section-stack structure.
 */
export function DeployableDetailPage() {
  const { projectId, dasUnitId } = useParams<{ projectId: string; dasUnitId: string }>();
  const navigate = useNavigate();

  const index = useDasIndex(projectId);
  const selectedUnit = useMemo(
    () => index.units.find(u => u.id === dasUnitId) ?? index.units[0],
    [index.units, dasUnitId],
  );
  const scoped = useDasUnitSlice(projectId, selectedUnit);

  // Keep the URL in sync once units resolve: an unknown/missing dasUnitId
  // falls back to the first unit and the address bar catches up, so a
  // shared "just /deployables" link still lands somewhere real.
  useEffect(() => {
    if (!projectId || !selectedUnit) return;
    if (dasUnitId !== selectedUnit.id) {
      navigate(`/codebases/${projectId}/deployables/${selectedUnit.id}`, { replace: true });
    }
  }, [projectId, dasUnitId, selectedUnit, navigate]);

  if (!projectId) return null;
  if (index.isLoading) return <LoadingState label="Loading deployable analysis…" />;
  if (index.isError) return <ErrorState message="Could not load this codebase's analysis." />;

  if (!index.promoted) {
    return (
      <EmptyState
        title="No deployable units to show"
        description="This codebase resolves fewer than two tier-qualified ship units, so it hasn't promoted to a Deployable Analysis Workspace — a single-deployable codebase is a valid, common, terminal state (see apps/app/docs/briefs/deployables.md)."
      />
    );
  }

  if (!selectedUnit) {
    return <LoadingState label="Resolving deployable unit…" />;
  }

  return (
    <Box>
      <PageHeader
        title="Deployable"
        subtitle="One independently-shippable unit of this codebase — its entry points, entities, and the evidence that proves it ships on its own."
        actions={<DasUnitPicker units={index.units} value={selectedUnit.id} onChange={id => navigate(`/codebases/${projectId}/deployables/${id}`)} />}
      />

      <Stack spacing={3} sx={{ mt: 3 }}>
        <DasUnitOverview unit={selectedUnit} />
        <DasShipEvidence unit={selectedUnit} />
        <DasBundledMembers unit={selectedUnit} />
        <DasEntryPoints entryPoints={scoped.entryPoints} capabilities={scoped.capabilities} projectId={projectId} />
        <DasEntities entities={scoped.entities} files={scoped.files} />
        <DasOrphanNotice />
      </Stack>
    </Box>
  );
}
