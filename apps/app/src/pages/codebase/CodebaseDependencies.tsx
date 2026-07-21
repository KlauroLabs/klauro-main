// Full Dependencies page — route /codebases/:projectId/dependencies. DERIVED
// route (see SCREEN-MAP.md). CORRECTED: this used to render a permanent
// empty state on the (false) claim that no web-API route serves external-
// service/dependency data. It does — `GET /api/projects/:id/cas` carries
// `external_services` and `libraries`/`dependency_manifest`, the same fields
// the page-integrations lane's `/integrations` route already renders via
// useExternalServices/useLibraries. Rather than fork a second rendering of
// the same facts, this route reuses page-integrations' own list components
// (ExternalServicesList/LibrariesList) directly — one source of truth for
// "what does this codebase depend on", two entry routes into it (this
// Figma-derived "Dependencies" rung of the Repo overview ladder, and the
// undesigned `/integrations` page which also folds in exit points +
// communication seams). See apps/app/docs/DESIGN-NOTES.md.
import { Stack, Paper, Typography } from '@mui/material';
import { useParams } from 'react-router-dom';
import { LoadingState } from '../../layout/LoadingState';
import { ErrorState } from '../../layout/ErrorState';
import { EmptyState } from '../../layout/EmptyState';
import { useResolvedProjectId } from '../../hooks/useResolvedProjectId';
import { useExternalServices } from '../../hooks/useExternalServices';
import { useLibraries } from '../../hooks/useLibraries';
import { ExternalServicesList } from '../integrations/ExternalServicesList';
import { LibrariesList } from '../integrations/LibrariesList';

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
