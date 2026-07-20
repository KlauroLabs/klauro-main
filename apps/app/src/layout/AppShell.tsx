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
  Chip,
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
  Users,
} from 'lucide-react';
import { NavItem } from './NavItem';
import { useAuth } from '../auth/AuthProvider';
import { useWorkspaces } from '../hooks/useWorkspaces';

const drawerWidth = 258;

export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const workspacesQuery = useWorkspaces();
  const [openWorkspaceId, setOpenWorkspaceId] = useState<string | null>(null);

  const workspaces = workspacesQuery.data?.workspaces ?? [];
  const activeWorkspaceId = location.pathname.match(/^\/workspaces\/([^/]+)/)?.[1];

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
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Box
                  sx={{
                    width: 24,
                    height: 24,
                    borderRadius: '6px',
                    bgcolor: 'primary.main',
                  }}
                />
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  klauro
                </Typography>
              </Stack>
            </Stack>
            <Divider />
            <List sx={{ px: 1, py: 1 }}>
              <NavItem
                icon={<Grid2x2 size={16} />}
                label="Home"
                selected={location.pathname === '/'}
                onClick={() => navigate('/')}
              />
              <NavItem icon={<Inbox size={16} />} label="Inbox" disabled endAdornment={<ComingSoonChip />} />
              <NavItem icon={<Activity size={16} />} label="Activity" disabled endAdornment={<ComingSoonChip />} />
            </List>
            <Divider />
            <List
              subheader={
                <ListSubheader component="div" sx={{ bgcolor: 'transparent', lineHeight: '22px', px: 3, pt: 1.5 }}>
                  Workspace
                </ListSubheader>
              }
              sx={{ px: 1 }}
            >
              {workspaces.map(workspace => {
                const active = activeWorkspaceId === workspace.id;
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
                        navigate(`/workspaces/${workspace.id}`);
                      }}
                      endAdornment={
                        <Typography variant="caption" color="text.secondary">
                          {workspace.project_count}
                        </Typography>
                      }
                    />
                    {isOpen && projects.length > 0 && (
                      <Stack sx={{ pl: 1 }}>
                        {projects.slice(0, 5).map(project => (
                          <NavItem
                            key={project.id}
                            dense
                            icon={<Layers2 size={14} />}
                            label={project.name}
                            selected={location.pathname.startsWith(`/codebases/${project.id}`)}
                            onClick={() => navigate(`/codebases/${project.id}`)}
                          />
                        ))}
                      </Stack>
                    )}
                  </Box>
                );
              })}
              <NavItem icon={<Plus size={15} />} label="Add Workspace" disabled endAdornment={<ComingSoonChip />} />
            </List>
            <Divider />
            <List
              subheader={
                <ListSubheader component="div" sx={{ bgcolor: 'transparent', lineHeight: '22px', px: 3, pt: 1.5 }}>
                  Organization
                </ListSubheader>
              }
              sx={{ px: 1 }}
            >
              <NavItem icon={<Users size={16} />} label="Members" disabled endAdornment={<ComingSoonChip />} />
              <NavItem icon={<Link2 size={16} />} label="Integrations" disabled endAdornment={<ComingSoonChip />} />
              <NavItem icon={<CreditCard size={16} />} label="Billing" disabled endAdornment={<ComingSoonChip />} />
            </List>
          </Stack>
          <Stack sx={{ px: 1, pb: 2 }}>
            <Divider sx={{ mb: 1 }} />
            <NavItem icon={<HelpCircle size={16} />} label="Help" disabled endAdornment={<ComingSoonChip />} />
            <NavItem icon={<Settings size={16} />} label="Settings" disabled endAdornment={<ComingSoonChip />} />
          </Stack>
        </Stack>
      </Drawer>

      <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <AppBar position="sticky" sx={{ ml: 0 }}>
          <Toolbar sx={{ justifyContent: 'space-between', minHeight: 64 }}>
            <Breadcrumbs />
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              <Tooltip title="Search (coming soon)">
                <span>
                  <IconButton disabled size="small">
                    <Search size={18} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Notifications (coming soon)">
                <span>
                  <IconButton disabled size="small">
                    <Bell size={18} />
                  </IconButton>
                </span>
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
    </Box>
  );
}

function ComingSoonChip() {
  return <Chip size="small" label="Soon" sx={{ height: 20, fontSize: 10 }} />;
}

function Breadcrumbs() {
  const location = useLocation();
  const segments = location.pathname.split('/').filter(Boolean);
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      <RouterLink to="/" style={{ display: 'flex', color: 'inherit' }}>
        <Building2 size={16} />
      </RouterLink>
      {segments.length > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ textTransform: 'capitalize' }}>
          {segments[0].replace(/-/g, ' ')}
        </Typography>
      )}
    </Stack>
  );
}
