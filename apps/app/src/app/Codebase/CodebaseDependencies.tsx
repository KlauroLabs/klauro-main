import { Stack, Paper, Typography } from '@mui/material';
import { useParams } from 'react-router-dom';
import { LoadingState } from '@/shared/layout/LoadingState';
import { ErrorState } from '@/shared/layout/ErrorState';
import { EmptyState } from '@/shared/layout/EmptyState';
import { useResolvedProjectId } from '@/shared/hooks/useResolvedProjectId';
import { useExternalServices } from '@/shared/hooks/useExternalServices';
import { useLibraries } from '@/shared/hooks/useLibraries';
import { ExternalServicesList } from '@/app/Integrations/ExternalServicesList';
import { LibrariesList } from '@/app/Integrations/LibrariesList';

export function CodebaseDependencies() {
  const { projectId: routeParam } = useParams<{ projectId: string }>();
  const projectId = useResolvedProjectId(routeParam) ?? routeParam;
  const servicesQuery = useExternalServices(projectId);
  const librariesQuery = useLibraries(projectId);

  if (!projectId) return null;

  if (servicesQuery.isLoading || librariesQuery.isLoading) {
    return <LoadingState label="Loading dependencies…" />;
  }
  if (servicesQuery.isError || librariesQuery.isError) {
    return <ErrorState message="Could not load this codebase's dependencies." />;
  }

  const hasNothing =
    servicesQuery.externalServices.length === 0 &&
    librariesQuery.libraries.length === 0 &&
    !librariesQuery.dependencyManifest?.dependencies.length;

  if (hasNothing) {
    return (
      <Stack spacing={2}>
        <Typography variant="body2" color="text.secondary">
          External services this system relies on.
        </Typography>
        <EmptyState
          title="No dependencies found"
          description="This codebase's analysis found nothing it relies on or exits to — a real case for a
            self-contained library, or a still-analyzing repository."
        />
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        External services this system relies on.
      </Typography>

      <Stack spacing={3}>
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
    </Stack>
  );
}
