// Sidebar navigation + topbar shell — the chrome around EVERY route, built
// once here per LANE-COMMON's file discipline (shared primitives don't get
// per-page copies). Mirrors the Figma "Sidebar navigation" + breadcrumb
// topbar component instances that repeat identically across all 5 designed
// screens (Home 1698-13626, Workspace 1748-6595, Repo overview 1647-37709,
// Flow List 2030-31178, Flow Overview 1982-5977) — see SCREEN-MAP.md.
import { useState, type ReactNode } from 'react';
import {
  AppBar,
  Avatar,
  Box,
  Divider,
  Drawer,
  IconButton,
  List,
  ListSubheader,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  Bell,
  Building2,
  CreditCard,
  Grid2x2,
  HelpCircle,
  Inbox,
  Layers2,
  Layers3,
  Link2,
  Plus,
  Search,
  Settings,
  Star,
  Users,
} from 'lucide-react';
import { NavItem } from './NavItem';
import { useAuth } from '../auth/AuthProvider';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { Logo } from '../components/Logo';
import { DeployFreshnessBanner } from './DeployFreshnessBanner';
import { encodeSlug, resolveSlug } from '../lib/slugs';
import type { Project, Workspace } from '../api';

const drawerWidth = 258;

export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const workspacesQuery = useWorkspaces();
  const [openWorkspaceId, setOpenWorkspaceId] = useState<string | null>(null);

  const workspaces = workspacesQuery.data?.workspaces ?? [];
  // The URL segment is a `name~suffix` slug (src/lib/slugs.ts), not the raw
  // workspace id, so "active" comparisons below match on the SAME encoded
  // slug rather than the id.
  const activeWorkspaceSlug = location.pathname.match(/^\/workspaces\/([^/]+)/)?.[1];

  const initials = (user?.name || user?.email || 'K').trim().charAt(0).toUpperCase();

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <Drawer
        variant="permanent"
        sx={{
          width: drawerWidth,
          flexShrink: 0,
          [`& .MuiDrawer-paper`]: { width: drawerWidth, boxSizing: 'border-box' },
        }}
      >
        <Stack sx={{ height: '100%', justifyContent: 'space-between' }}>
          <Stack>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', px: 2, py: 3 }}>
              <Logo variant="lockup" size={20} />
            </Stack>
            <Divider />
            <List sx={{ px: 1, py: 1 }}>
              <NavItem
                icon={<Grid2x2 size={16} />}
                label="Home"
                selected={location.pathname === '/'}
                onClick={() => navigate('/')}
              />
              <NavItem icon={<Inbox size={16} />} label="Inbox" />
              <NavItem icon={<Activity size={16} />} label="Activity" />
            </List>
            <Divider />
            <List
              subheader={
                <ListSubheader component="div" sx={{ bgcolor: 'transparent', lineHeight: '22px', px: 3, pt: 1.5, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 11 }}>
                  Workspace
                </ListSubheader>
              }
              sx={{ px: 1 }}
            >
              {workspaces.map(workspace => {
                const workspaceSlug = encodeSlug(workspace);
                const active = activeWorkspaceSlug === workspaceSlug;
                const isOpen = openWorkspaceId === workspace.id;
                const projects = workspacesQuery.data?.projectsByWorkspace[workspace.id] ?? [];
                return (
                  <Box key={workspace.id}>
                    <NavItem
                      icon={<Layers3 size={16} />}
                      label={workspace.name}
                      selected={active}
                      onClick={() => {
                        setOpenWorkspaceId(isOpen ? null : workspace.id);
                        navigate(`/workspaces/${workspaceSlug}`);
                      }}
                      endAdornment={
                        <Typography variant="caption" color="text.secondary">
                          {workspace.project_count}
                        </Typography>
                      }
                    />
                    {isOpen && projects.length > 0 && (
                      <Stack sx={{ pl: 1 }}>
                        {projects.slice(0, 5).map(project => {
                          const projectSlug = encodeSlug(project);
                          return (
                            <NavItem
                              key={project.id}
                              dense
                              icon={<Layers2 size={14} />}
                              label={project.name}
                              selected={location.pathname.startsWith(`/codebases/${projectSlug}`)}
                              onClick={() => navigate(`/codebases/${projectSlug}`)}
                            />
                          );
                        })}
                      </Stack>
                    )}
                  </Box>
                );
              })}
              <NavItem icon={<Plus size={15} />} label="Add Workspace" />
            </List>
            <Divider />
            <List
              subheader={
                <ListSubheader component="div" sx={{ bgcolor: 'transparent', lineHeight: '22px', px: 3, pt: 1.5, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 11 }}>
                  Organization
                </ListSubheader>
              }
              sx={{ px: 1 }}
            >
              <NavItem icon={<Users size={16} />} label="Members" />
              <NavItem icon={<Link2 size={16} />} label="Integrations" />
              <NavItem icon={<CreditCard size={16} />} label="Billing" />
            </List>
          </Stack>
          <Stack sx={{ px: 1, pb: 2 }}>
            <Divider sx={{ mb: 1 }} />
            <NavItem icon={<HelpCircle size={16} />} label="Help" />
            <NavItem icon={<Settings size={16} />} label="Settings" />
          </Stack>
        </Stack>
      </Drawer>

      <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <AppBar position="sticky" sx={{ ml: 0 }}>
          <Toolbar sx={{ justifyContent: 'space-between', minHeight: 64 }}>
            <Breadcrumbs workspaces={workspaces} projectsByWorkspace={workspacesQuery.data?.projectsByWorkspace} />
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
                <IconButton onClick={signOut} size="small">
                  <Avatar sx={{ width: 32, height: 32, fontSize: 14 }}>{initials}</Avatar>
                </IconButton>
              </Tooltip>
            </Stack>
          </Toolbar>
        </AppBar>
        <Box component="main" sx={{ flexGrow: 1, p: 4, maxWidth: 1600, width: '100%', mx: 'auto' }}>
          {children}
        </Box>
      </Box>
      <DeployFreshnessBanner />
    </Box>
  );
}

// Figma's topbar breadcrumb (node 1698:13626 "Home" vs. 1748:6595/1647:37709/
// etc): the ROOT screen shows plain text "Home", no icon, no chain — every
// OTHER screen shows a home icon, then the real workspace/codebase NAME (not
// a URL slug), ending in a star/favorite icon. Resolves the name from the
// same `useWorkspaces` aggregate AppShell already fetches for the sidebar —
// no second network call. Deeper section segments (capabilities/flows/...)
// still fall back to a capitalized slug since no further fetch is made here;
// logged in DESIGN-NOTES.md as an honest approximation for those, not the
// two levels this now resolves for real.
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
