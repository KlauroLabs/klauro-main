// CAS home SHELL — route /codebases/:projectId (router.tsx nests every
// section route as a child here: index=Overview, capabilities, flows,
// entities, architecture, dependencies, plus entry-points/functions/
// integrations owned by other lanes). Renders the section nav once and lets
// react-query's per-projectId query keys (useProjectSummary/
// useProjectConceptual) dedupe fetches across whichever child route is
// active — no data fetching here.
import { Box } from '@mui/material';
import { Outlet, useParams } from 'react-router-dom';
import { CodebaseSectionNav } from './CodebaseSectionNav';

export function CodebasePage() {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return null;
  return (
    <Box>
      <CodebaseSectionNav projectId={projectId} />
      <Outlet />
    </Box>
  );
}
