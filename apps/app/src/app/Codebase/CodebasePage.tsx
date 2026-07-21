import { useEffect } from 'react';
import { Box } from '@mui/material';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { recordProjectOpened } from '@/shared/hooks/useRecentProjectViews';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import { useResolvedProjectId } from '@/shared/hooks/useResolvedProjectId';
import { encodeSlug } from '@/shared/lib/slugs';

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
