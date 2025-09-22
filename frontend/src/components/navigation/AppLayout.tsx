import React, { useState } from 'react';
import {
  Box,
  Container,
  CssBaseline,
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Divider,
  useTheme,
  useMediaQuery,
  Alert,
  Snackbar,
} from '@mui/material';
import {
  Dashboard as DashboardIcon,
  Code as CodeIcon,
  Analytics as AnalyticsIcon,
  Settings as SettingsIcon,
  People as PeopleIcon,
  Storage as StorageIcon,
} from '@mui/icons-material';
import { AppNavigation } from './AppNavigation';
import { AppBreadcrumbs } from './AppBreadcrumbs';
import { WorkspaceProvider } from '../../contexts/WorkspaceContext';
import { BillingTier } from '../../types/billing.types';

const DRAWER_WIDTH = 240;

interface NavigationItem {
  label: string;
  icon: React.ReactNode;
  href: string;
  requiresWorkspace?: boolean;
}

const navigationItems: NavigationItem[] = [
  {
    label: 'Dashboard',
    icon: <DashboardIcon />,
    href: '/',
  },
  {
    label: 'Codebases',
    icon: <CodeIcon />,
    href: '/codebases',
    requiresWorkspace: true,
  },
  {
    label: 'Analytics',
    icon: <AnalyticsIcon />,
    href: '/analytics',
    requiresWorkspace: true,
  },
  {
    label: 'Team',
    icon: <PeopleIcon />,
    href: '/team',
    requiresWorkspace: true,
  },
  {
    label: 'Storage',
    icon: <StorageIcon />,
    href: '/storage',
    requiresWorkspace: true,
  },
  {
    label: 'Settings',
    icon: <SettingsIcon />,
    href: '/settings',
  },
];

interface AppLayoutProps {
  children: React.ReactNode;
  currentPath?: string;
  userEmail?: string;
  userBillingTier?: BillingTier;
  showBreadcrumbs?: boolean;
  breadcrumbItems?: React.ComponentProps<typeof AppBreadcrumbs>['items'];
  currentWorkspace?: React.ComponentProps<typeof AppBreadcrumbs>['currentWorkspace'];
  currentCodebase?: React.ComponentProps<typeof AppBreadcrumbs>['currentCodebase'];
  onUpgrade?: () => void;
  onUserSettings?: () => void;
  onLogout?: () => void;
}

export function AppLayout({
  children,
  currentPath = '/',
  userEmail,
  userBillingTier = 'free',
  showBreadcrumbs = true,
  breadcrumbItems,
  currentWorkspace,
  currentCodebase,
  onUpgrade,
  onUserSettings,
  onLogout,
}: AppLayoutProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);

  const handleDrawerToggle = () => {
    setMobileDrawerOpen(!mobileDrawerOpen);
  };

  const handleNavigate = (href: string) => {
    window.location.href = href;
    if (isMobile) {
      setMobileDrawerOpen(false);
    }
  };

  const isCurrentPath = (href: string) => {
    if (href === '/') {
      return currentPath === '/';
    }
    return currentPath.startsWith(href);
  };

  const drawerContent = (
    <Box sx={{ width: DRAWER_WIDTH }}>
      <Box sx={{ p: 2 }}>
        <Box
          sx={{
            fontWeight: 'bold',
            fontSize: '1.25rem',
            background: 'linear-gradient(45deg, #2196F3 30%, #21CBF3 90%)',
            backgroundClip: 'text',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        >
          Unravl
        </Box>
      </Box>

      <Divider />

      <List>
        {navigationItems.map((item) => (
          <ListItem key={item.label} disablePadding>
            <ListItemButton
              selected={isCurrentPath(item.href)}
              onClick={() => handleNavigate(item.href)}
              disabled={item.requiresWorkspace && !currentWorkspace}
            >
              <ListItemIcon>{item.icon}</ListItemIcon>
              <ListItemText primary={item.label} />
            </ListItemButton>
          </ListItem>
        ))}
      </List>
    </Box>
  );

  return (
    <WorkspaceProvider>
      <Box sx={{ display: 'flex' }}>
        <CssBaseline />

        {/* App Bar */}
        <AppNavigation
          onMenuToggle={isMobile ? handleDrawerToggle : undefined}
          userEmail={userEmail}
          userBillingTier={userBillingTier}
          onUpgrade={onUpgrade}
          onUserSettings={onUserSettings}
          onLogout={onLogout}
        />

        {/* Drawer */}
        <Box
          component="nav"
          sx={{ width: { md: DRAWER_WIDTH }, flexShrink: { md: 0 } }}
        >
          {/* Mobile drawer */}
          <Drawer
            variant="temporary"
            open={mobileDrawerOpen}
            onClose={handleDrawerToggle}
            ModalProps={{
              keepMounted: true, // Better open performance on mobile
            }}
            sx={{
              display: { xs: 'block', md: 'none' },
              '& .MuiDrawer-paper': {
                boxSizing: 'border-box',
                width: DRAWER_WIDTH,
              },
            }}
          >
            {drawerContent}
          </Drawer>

          {/* Desktop drawer */}
          <Drawer
            variant="permanent"
            sx={{
              display: { xs: 'none', md: 'block' },
              '& .MuiDrawer-paper': {
                boxSizing: 'border-box',
                width: DRAWER_WIDTH,
                position: 'relative',
                height: '100vh',
                borderRight: 1,
                borderColor: 'divider',
              },
            }}
            open
          >
            {drawerContent}
          </Drawer>
        </Box>

        {/* Main content */}
        <Box
          component="main"
          sx={{
            flexGrow: 1,
            width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
            minHeight: '100vh',
            backgroundColor: 'background.default',
          }}
        >
          {/* Breadcrumbs */}
          {showBreadcrumbs && (
            <Box
              sx={{
                borderBottom: 1,
                borderColor: 'divider',
                backgroundColor: 'background.paper',
                px: 3,
                py: 2,
              }}
            >
              <AppBreadcrumbs
                items={breadcrumbItems}
                currentWorkspace={currentWorkspace}
                currentCodebase={currentCodebase}
              />
            </Box>
          )}

          {/* Page content */}
          <Container maxWidth={false} sx={{ py: 3 }}>
            {children}
          </Container>
        </Box>

        {/* Notification Snackbar */}
        <Snackbar
          open={Boolean(notification)}
          autoHideDuration={6000}
          onClose={() => setNotification(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        >
          <Alert
            onClose={() => setNotification(null)}
            severity="info"
            sx={{ width: '100%' }}
          >
            {notification}
          </Alert>
        </Snackbar>
      </Box>
    </WorkspaceProvider>
  );
}

// Convenience wrapper for pages that need workspace context
export function WorkspaceLayout(props: AppLayoutProps) {
  return <AppLayout {...props} />;
}