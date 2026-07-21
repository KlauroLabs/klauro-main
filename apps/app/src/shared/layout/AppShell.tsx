import type { ReactNode } from 'react';
import { Box } from '@mui/material';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { DeployFreshnessBanner } from './DeployFreshnessBanner';
import { encodeSlug } from '@/shared/lib/slugs';

export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const workspacesQuery = useWorkspaces();

  const workspaces = workspacesQuery.data?.workspaces ?? [];
  const activeWorkspaceSlug = location.pathname.match(/^\/workspaces\/([^/]+)/)?.[1];
  const initials = (user?.name || user?.email || 'K').trim().charAt(0).toUpperCase();

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <Sidebar
        workspaces={workspaces}
        projectsByWorkspace={workspacesQuery.data?.projectsByWorkspace}
        activeWorkspaceSlug={activeWorkspaceSlug}
      />
      <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Topbar
          workspaces={workspaces}
          projectsByWorkspace={workspacesQuery.data?.projectsByWorkspace}
          initials={initials}
          onSignOut={signOut}
        />
        <Box component="main" sx={{ flexGrow: 1, p: 4, maxWidth: 1600, width: '100%', mx: 'auto' }}>
          {children}
        </Box>
      </Box>
      <DeployFreshnessBanner />
    </Box>
  );
}
