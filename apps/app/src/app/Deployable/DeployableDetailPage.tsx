import { useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Box, Stack } from '@mui/material';
import { PageHeader } from '@/shared/layout/PageHeader';
import { LoadingState } from '@/shared/layout/LoadingState';
import { EmptyState } from '@/shared/layout/EmptyState';
import { ErrorState } from '@/shared/layout/ErrorState';
import { useDasUnitIndex, useSubCasNodeSlice } from '@/shared/hooks/useSubCasNodes';
import { encodeSlug, resolveSlug } from '@/shared/lib/slugs';
import { DasUnitPicker } from './DasUnitPicker';
import { DasUnitOverview } from './DasUnitOverview';
import { DasShipEvidence } from './DasShipEvidence';
import { DasBundledMembers } from './DasBundledMembers';
import { DasEntryPoints } from './DasEntryPoints';
import { DasEntities } from './DasEntities';
import { DasOrphanNotice } from './DasOrphanNotice';

export function DeployableDetailPage() {
  const { projectId, dasUnitId } = useParams<{ projectId: string; dasUnitId: string }>();
  const navigate = useNavigate();

  const index = useDasUnitIndex(projectId);
  const selectedUnit = useMemo(
    () => resolveSlug(dasUnitId, index.units) ?? index.units[0],
    [index.units, dasUnitId],
  );
  const scoped = useSubCasNodeSlice(projectId, selectedUnit?.id);

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
    // "1 ship unit found, below the threshold" and "no ship evidence found at
    // all" are different answers: report the qualified count, never a bare
    // "nothing to show" that reads as "we found nothing".
    const found = index.qualifiedUnitCount;
    const threshold = index.promotionThreshold ?? 2;
    return (
      <EmptyState
        title={found === 0
          ? 'No ship evidence found in this codebase'
          : `Single deployable — ${found ?? 'fewer than ' + threshold} tier-qualified ship unit${found === 1 ? '' : 's'} found`}
        description={index.promotionReason
          ?? `This codebase resolves fewer than ${threshold} tier-qualified ship units, so it hasn't promoted to a Deployable Analysis Workspace — a single-deployable codebase is a valid, common, terminal state (see apps/app/docs/briefs/deployables.md).`}
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
