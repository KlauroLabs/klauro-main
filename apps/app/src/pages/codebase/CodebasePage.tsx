// CAS home SHELL — route /codebases/:projectId (router.tsx nests every
// section route as a child here: index=Overview, capabilities, flows,
// entities, architecture, dependencies, plus entry-points/functions/
// integrations owned by other lanes). Renders the section nav once and lets
// react-query's per-projectId query keys (useProjectSummary/
// useProjectConceptual) dedupe fetches across whichever child route is
// active — no data fetching here.
//
// Also records this project as "opened" (localStorage, see
// useRecentProjectViews.ts) — this shell mounts for every child route under
// /codebases/:projectId, so it's the one place that reliably fires once per
// real visit to this codebase, feeding the dashboard's "Jump Back In" card.
import { useEffect } from 'react';
import { Box } from '@mui/material';
import { Outlet, useParams } from 'react-router-dom';
import { CodebaseSectionNav } from './CodebaseSectionNav';
import { recordProjectOpened } from '../../hooks/useRecentProjectViews';

export function CodebasePage() {
  const { projectId } = useParams<{ projectId: string }>();

  useEffect(() => {
    if (projectId) recordProjectOpened(projectId);
  }, [projectId]);

  if (!projectId) return null;
  return (
    <Box>
      <CodebaseSectionNav projectId={projectId} />
      <Outlet />
    </Box>
  );
}
