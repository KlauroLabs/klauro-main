import { AppBar, Avatar, IconButton, Stack, Toolbar, Tooltip, Typography } from '@mui/material';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { Bell, Building2, Search, Star } from 'lucide-react';
import { resolveSlug } from '@/shared/lib/slugs';
import type { Project, Workspace } from '@/shared/api/index';

export interface TopbarProps {
  workspaces: Workspace[];
  projectsByWorkspace: Record<string, Project[]> | undefined;
  initials: string;
  onSignOut: () => void;
}

export function Topbar({ workspaces, projectsByWorkspace, initials, onSignOut }: TopbarProps) {
  return (
    <AppBar position="sticky" sx={{ ml: 0 }}>
      <Toolbar sx={{ justifyContent: 'space-between', minHeight: 64 }}>
        <Breadcrumbs workspaces={workspaces} projectsByWorkspace={projectsByWorkspace} />
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
          <Tooltip title="Search">
            <IconButton size="small">
              <Search size={18} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Notifications">
            <IconButton size="small">
              <Bell size={18} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Sign out">
            <IconButton onClick={onSignOut} size="small">
              <Avatar sx={{ width: 32, height: 32, fontSize: 14 }}>{initials}</Avatar>
            </IconButton>
          </Tooltip>
        </Stack>
      </Toolbar>
    </AppBar>
  );
}

function Breadcrumbs({
  workspaces,
  projectsByWorkspace,
}: {
  workspaces: Workspace[];
  projectsByWorkspace: Record<string, Project[]> | undefined;
}) {
  const location = useLocation();
  const segments = location.pathname.split('/').filter(Boolean);

  if (segments.length === 0) {
    return (
      <Typography variant="body2" color="text.primary">
        Home
      </Typography>
    );
  }

  let label = segments[0].replace(/-/g, ' ');
  let rest = segments.slice(1);
  if (segments[0] === 'workspaces' && segments[1]) {
    label = resolveSlug(segments[1], workspaces)?.name ?? segments[1];
    rest = segments.slice(2);
  } else if (segments[0] === 'codebases' && segments[1]) {
    const allProjects = Object.values(projectsByWorkspace ?? {}).flat();
    label = resolveSlug(segments[1], allProjects)?.name ?? segments[1];
    rest = segments.slice(2);
  }

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      <RouterLink to="/" style={{ display: 'flex', color: 'inherit' }}>
        <Building2 size={16} />
      </RouterLink>
      <Typography variant="body2" color="text.secondary" sx={{ textTransform: 'capitalize' }}>
        {label}
      </Typography>
      {rest.map(segment => (
        <Typography key={segment} variant="body2" color="text.secondary" sx={{ textTransform: 'capitalize' }}>
          / {segment.replace(/-/g, ' ')}
        </Typography>
      ))}
      <Star size={14} />
    </Stack>
  );
}
