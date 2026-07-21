import { useState } from 'react';
import { Box, Divider, Drawer, List, ListSubheader, Stack, Typography } from '@mui/material';
import { useLocation, useNavigate } from 'react-router-dom';
import { Activity, CreditCard, Grid2x2, HelpCircle, Inbox, Layers2, Layers3, Link2, Plus, Settings, Users } from 'lucide-react';
import { NavItem } from './NavItem';
import { Logo } from '@/shared/components/Logo';
import { encodeSlug } from '@/shared/lib/slugs';
import type { Project, Workspace } from '@/shared/api/index';

export const drawerWidth = 258;

export interface SidebarProps {
  workspaces: Workspace[];
  projectsByWorkspace: Record<string, Project[]> | undefined;
  activeWorkspaceSlug: string | undefined;
}

export function Sidebar({ workspaces, projectsByWorkspace, activeWorkspaceSlug }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [openWorkspaceId, setOpenWorkspaceId] = useState<string | null>(null);

  return (
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
              const projects = projectsByWorkspace?.[workspace.id] ?? [];
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
  );
}
