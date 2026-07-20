// Full Dependencies page — route /codebases/:projectId/dependencies. DERIVED
// route (see SCREEN-MAP.md). No web-API route exists yet for external-service
// data (see sections/DependenciesSection.tsx and apps/app/docs/DESIGN-NOTES.md)
// so this is an honest, permanent-until-wired empty state rather than a
// fabricated list.
import { Stack, Typography } from '@mui/material';
import { EmptyState } from '../../layout/EmptyState';

export function CodebaseDependencies() {
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        External services this system relies on.
      </Typography>
      <EmptyState
        title="Dependency data isn't available yet"
        description="No web-API route currently serves external-service/dependency data for a codebase (get_external_services and get_dependencies exist as MCP-only tools today). See apps/app/docs/DESIGN-NOTES.md."
      />
    </Stack>
  );
}
