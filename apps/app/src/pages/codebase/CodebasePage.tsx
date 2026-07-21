// CAS home SHELL — route /codebases/:projectId (router.tsx nests every
// section route as a child here: index=Overview, capabilities, flows,
// entities, architecture, dependencies, plus entry-points/functions/
// integrations/deployables owned by other lanes). Lets react-query's
// per-projectId query keys (useProjectSummary/useProjectConceptual) dedupe
// fetches across whichever child route is active — no data fetching here
// beyond the slug resolution below.
//
// No section tab bar here: the Figma "Repo overview" frame (1647:37709) has
// no tab strip — it's one page with inline numbered sections (01
// Capabilities .. 05 Dependencies), each with its own "See all ->" link to
// the full route (see CodebaseOverview.tsx + sections/). Full section pages
// are reached via those See-all links and direct/deep links, not a
// persistent tab bar (see docs/DESIGN-NOTES.md, "CodebaseSectionNav removed").
//
// SLUG RESOLUTION (LANE-COMMON item 6 + its scope addition): `:projectId` in
// the URL is a `name~suffix` slug (src/lib/slugs.ts), not the real backend
// project id. This shell is the one place that redirects a legacy raw-id
// link (or a stale slug whose display name changed) to the canonical slug
// URL, preserving whatever sub-path follows the projectId segment. Every
// child route resolves the SAME param to the real id itself via
// useResolvedProjectId (backed by the same cached useWorkspaces() fetch),
// rather than depending on Outlet context, so each page stays correct
// whether mounted under this shell or in isolation (tests).
//
// Also records this project as "opened" (localStorage, see
// useRecentProjectViews.ts) — this shell mounts for every child route under
// /codebases/:projectId, so it's the one place that reliably fires once per
// real visit to this codebase, feeding the dashboard's "Jump Back In" card.
import { useEffect } from 'react';
import { Box } from '@mui/material';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { recordProjectOpened } from '../../hooks/useRecentProjectViews';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { useResolvedProjectId } from '../../hooks/useResolvedProjectId';
import { encodeSlug } from '../../lib/slugs';

export function CodebasePage() {
  const { projectId: routeParam } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const workspacesQuery = useWorkspaces();
  const resolvedId = useResolvedProjectId(routeParam);

  const resolvedProject = resolvedId
    ? Object.values(workspacesQuery.data?.projectsByWorkspace ?? {}).flat().find(p => p.id === resolvedId)
    : undefined;

  useEffect(() => {
    if (!resolvedProject || !routeParam) return;
    const canonical = encodeSlug(resolvedProject);
    if (routeParam !== canonical) {
      const restOfPath = location.pathname.slice(location.pathname.indexOf(routeParam) + routeParam.length);
      navigate(`/codebases/${canonical}${restOfPath}${location.search}`, { replace: true });
    }
  }, [resolvedProject, routeParam, location.pathname, location.search, navigate]);

  useEffect(() => {
    if (resolvedId) recordProjectOpened(resolvedId);
  }, [resolvedId]);

  if (!routeParam) return null;
  return (
    <Box>
      <Outlet />
    </Box>
  );
}
