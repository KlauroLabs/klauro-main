import { Box, Stack, Typography, Paper } from '@mui/material';
import { useParams } from 'react-router-dom';
import { PageHeader } from '../../layout/PageHeader';
import { LoadingState } from '../../layout/LoadingState';
import { EmptyState } from '../../layout/EmptyState';
import { ErrorState } from '../../layout/ErrorState';
import { useExitPoints } from '../../hooks/useExitPoints';
import { useExternalServices } from '../../hooks/useExternalServices';
import { useLibraries } from '../../hooks/useLibraries';
import { ExitPointsSection } from './ExitPointsSection';
import { ExternalServicesList } from './ExternalServicesList';
import { LibrariesList } from './LibrariesList';
import { CommunicationSeamsSummary } from './CommunicationSeamsSummary';

/**
 * Dependencies rung — route /codebases/:projectId/integrations. What the
 * system relies on and where it exits: exit points by family, named
 * external services, declared libraries, and the sync/async shape of every
 * outbound seam. No Figma screen exists for this route (see
 * apps/app/docs/DESIGN-NOTES.md) — derived from the design language and the
 * Entry Points screen's catalog pattern, its structural mirror. The full
 * data-shape rationale lives in apps/app/docs/briefs/integrations.md.
 */
export function IntegrationsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const exitPointsQuery = useExitPoints(projectId);
  const servicesQuery = useExternalServices(projectId);
  const librariesQuery = useLibraries(projectId);

  if (!projectId) return null;

  const isLoading = exitPointsQuery.isLoading || servicesQuery.isLoading || librariesQuery.isLoading;
  const isError = exitPointsQuery.isError || servicesQuery.isError || librariesQuery.isError;

  if (isLoading) return <LoadingState label="Loading dependencies…" />;
  if (isError) return <ErrorState message="Could not load this codebase's dependencies." />;

  const hasNothing =
    exitPointsQuery.allExitPoints.length === 0 &&
    servicesQuery.externalServices.length === 0 &&
    librariesQuery.libraries.length === 0 &&
    !librariesQuery.dependencyManifest?.dependencies.length;

  if (hasNothing) {
    return (
      <EmptyState
        title="No dependencies found"
        description="This codebase's analysis found nothing it relies on or exits to — a real case for a self-contained
          library, or a still-analyzing repository."
      />
    );
  }

  return (
    <Box>
      <PageHeader
        title="Dependencies"
        subtitle="What this codebase relies on, and every place it reaches outside itself."
      />

      <Stack spacing={3} sx={{ mt: 3 }}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            Exit points
          </Typography>
          <ExitPointsSection familyGroups={exitPointsQuery.familyGroups} projectId={projectId} />
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            Communication seams
          </Typography>
          <CommunicationSeamsSummary exitPoints={exitPointsQuery.allExitPoints} />
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            External services
          </Typography>
          <ExternalServicesList services={servicesQuery.externalServices} />
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            Libraries
          </Typography>
          <LibrariesList libraries={librariesQuery.libraries} dependencyManifest={librariesQuery.dependencyManifest} />
        </Paper>
      </Stack>
    </Box>
  );
}
