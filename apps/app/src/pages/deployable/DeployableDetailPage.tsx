import { useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Box, Stack } from '@mui/material';
import { PageHeader } from '../../layout/PageHeader';
import { LoadingState } from '../../layout/LoadingState';
import { EmptyState } from '../../layout/EmptyState';
import { ErrorState } from '../../layout/ErrorState';
import { useDasUnitIndex, useDasUnitSlice } from '../../hooks/useDasUnits';
import { encodeSlug, resolveSlug } from '../../lib/slugs';
import { DasUnitPicker } from './DasUnitPicker';
import { DasUnitOverview } from './DasUnitOverview';
import { DasShipEvidence } from './DasShipEvidence';
import { DasBundledMembers } from './DasBundledMembers';
import { DasEntryPoints } from './DasEntryPoints';
import { DasEntities } from './DasEntities';
import { DasOrphanNotice } from './DasOrphanNotice';

/**
 * The DAS drilldown — route /codebases/:projectId/deployables/:dasUnitId
 * (nested under CodebasePage, per router.tsx; `dasUnitId` is a
 * `name~suffix` slug — src/lib/slugs.ts — resolved against the real
 * das_index below, with back-compat for an old raw-id link). das_index is
 * the picker (LANE-COMMON.md); this page is always scoped to ONE unit, same
 * "one at a time, switch to another" shape entry-points uses for repo-level
 * deployables, one rung more specific. Wired to the REAL DAS endpoints
 * (GET .../das + .../cas?das_unit_id=, e9490b69) — the true reachability-
 * closure slice, not the earlier client-side directory-prefix
 * approximation. Derived layout — no Figma screen covers a DAS unit
 * drilldown (see DESIGN-NOTES.md); mirrors the entry-points catalog page's
 * section-stack structure.
 */
export function DeployableDetailPage() {
  const { projectId, dasUnitId } = useParams<{ projectId: string; dasUnitId: string }>();
  const navigate = useNavigate();

  const index = useDasUnitIndex(projectId);
  const selectedUnit = useMemo(
    () => resolveSlug(dasUnitId, index.units) ?? index.units[0],
    [index.units, dasUnitId],
  );
  const scoped = useDasUnitSlice(projectId, selectedUnit?.id);

  // Keep the URL in sync once units resolve: an unknown/missing/legacy-raw-id
  // dasUnitId converges onto the canonical `name~suffix` slug for whichever
  // unit resolved (falling back to the first unit for a bare "/deployables"
  // link), so a shared link always lands somewhere real and canonical.
  useEffect(() => {
    if (!projectId || !selectedUnit) return;
    const canonical = encodeSlug(selectedUnit);
    if (dasUnitId !== canonical) {
      navigate(`/codebases/${projectId}/deployables/${canonical}`, { replace: true });
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
        actions={
          <DasUnitPicker
            units={index.units}
            value={selectedUnit.id}
            onChange={id => {
              const unit = index.units.find(u => u.id === id);
              navigate(`/codebases/${projectId}/deployables/${unit ? encodeSlug(unit) : id}`);
            }}
          />
        }
      />

      <Stack spacing={3} sx={{ mt: 3 }}>
        <DasUnitOverview unit={selectedUnit} />
        <DasShipEvidence evidence={scoped.shipEvidence} />
        <DasBundledMembers unit={selectedUnit} />
        <DasEntryPoints entryPoints={scoped.entryPoints} capabilities={scoped.capabilities} projectId={projectId} />
        <DasEntities entities={scoped.entities} files={scoped.files} />
        <DasOrphanNotice orphanNodeCount={index.orphanNodeCount} />
      </Stack>
    </Box>
  );
}
