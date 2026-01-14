import React, { useState } from 'react';
import {
  Box,
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  IconButton,
  Typography,
  Divider,
  Chip,
  useMediaQuery,
  useTheme,
  Avatar,
  Collapse,
} from '@mui/material';
import {
  Dashboard as DashboardIcon,
  Code as CodeIcon,
  Analytics as AnalyticsIcon,
  Settings as SettingsIcon,
  People as PeopleIcon,
  ChevronLeft as ChevronLeftIcon,
  Menu as MenuIcon,
  ExpandLess,
  ExpandMore,
  FolderOpen as FolderOpenIcon,
  Storage as StorageIcon,
  Timeline as TimelineIcon,
} from '@mui/icons-material';
import { useRouter } from 'next/router';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { WorkspaceSelector } from '../workspace/WorkspaceSelector';
import { WorkspaceCreate } from '../workspace/WorkspaceCreate';

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
  variant?: 'permanent' | 'temporary';
}

interface NavItem {
  label: string;
  icon: React.ReactNode;
  path: string;
  badge?: string | number;
  children?: NavItem[];
}

const drawerWidth = 280;

export const Sidebar: React.FC<SidebarProps> = ({
  open = true,
  onClose,
  variant = 'permanent'
}) => {
  const theme = useTheme();
  const router = useRouter();
  const { currentWorkspace, refreshWorkspaces } = useWorkspace();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [expandedItems, setExpandedItems] = useState<string[]>([]);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);

  const navItems: NavItem[] = [
    {
      label: 'Dashboard',
      icon: <DashboardIcon />,
      path: '/workspaces',
    },
    {
      label: 'Codebases',
      icon: <CodeIcon />,
      path: '/codebases',
      badge: currentWorkspace ? '3' : undefined,
      children: currentWorkspace ? [
        {
          label: 'All Codebases',
          icon: <FolderOpenIcon />,
          path: '/codebases',
        },
        {
          label: 'Recent',
          icon: <TimelineIcon />,
          path: '/codebases/recent',
        },
      ] : undefined,
    },
    {
      label: 'Analysis',
      icon: <AnalyticsIcon />,
      path: '/analysis',
    },
    {
      label: 'Team',
      icon: <PeopleIcon />,
      path: '/team',
    },
    {
      label: 'Storage',
      icon: <StorageIcon />,
      path: '/storage',
    },
  ];

  const bottomNavItems: NavItem[] = [
    {
      label: 'Settings',
      icon: <SettingsIcon />,
      path: '/settings',
    },
  ];

  const handleItemClick = (item: NavItem) => {
    if (item.children) {
      const isExpanded = expandedItems.includes(item.label);
      setExpandedItems(
        isExpanded
          ? expandedItems.filter(label => label !== item.label)
          : [...expandedItems, item.label]
      );
    } else {
      router.push(item.path);
      if (isMobile && onClose) {
        onClose();
      }
    }
  };

  const isActive = (path: string) => {
    return router.pathname === path || router.pathname.startsWith(path + '/');
  };

  const handleCreateWorkspace = () => {
    setCreateWorkspaceOpen(true);
  };

  const handleWorkspaceCreated = () => {
    setCreateWorkspaceOpen(false);
    refreshWorkspaces();
  };

  const drawerContent = (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'rgba(10, 10, 10, 0.95)',
        backdropFilter: 'blur(10px)',
        borderRight: '1px solid rgba(255, 255, 255, 0.1)',
      }}
    >
      {/* Logo and Header */}
      <Box
        sx={{
          p: 3,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Avatar
            sx={{
              width: 40,
              height: 40,
              bgcolor: 'primary.main',
              fontWeight: 700,
            }}
          >
            U
          </Avatar>
          <Typography
            variant="h6"
            sx={{
              fontWeight: 700,
              background: 'linear-gradient(135deg, #e91e63 0%, #2196f3 100%)',
              backgroundClip: 'text',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            Unravl
          </Typography>
        </Box>
        {isMobile && onClose && (
          <IconButton onClick={onClose} size="small">
            <ChevronLeftIcon />
          </IconButton>
        )}
      </Box>

      <Divider sx={{ borderColor: 'rgba(255, 255, 255, 0.1)' }} />

      {/* Workspace Selector */}
      <Box sx={{ p: 2 }}>
        <WorkspaceSelector
          variant="compact"
          onCreateWorkspace={handleCreateWorkspace}
        />
      </Box>

      <Divider sx={{ borderColor: 'rgba(255, 255, 255, 0.1)' }} />

      {/* Main Navigation */}
      <List sx={{ flexGrow: 1, px: 2, py: 1 }}>
        {navItems.map((item) => (
          <React.Fragment key={item.label}>
            <ListItem disablePadding sx={{ mb: 0.5 }}>
              <ListItemButton
                onClick={() => handleItemClick(item)}
                selected={isActive(item.path)}
                sx={{
                  borderRadius: 1.5,
                  transition: 'all 0.2s',
                  '&.Mui-selected': {
                    bgcolor: 'rgba(33, 150, 243, 0.15)',
                    '&:hover': {
                      bgcolor: 'rgba(33, 150, 243, 0.2)',
                    },
                  },
                  '&:hover': {
                    bgcolor: 'rgba(255, 255, 255, 0.05)',
                  },
                }}
              >
                <ListItemIcon sx={{ color: isActive(item.path) ? 'primary.main' : 'rgba(255, 255, 255, 0.7)', minWidth: 40 }}>
                  {item.icon}
                </ListItemIcon>
                <ListItemText
                  primary={item.label}
                  primaryTypographyProps={{
                    fontSize: '0.9rem',
                    fontWeight: isActive(item.path) ? 600 : 400,
                  }}
                />
                {item.badge && (
                  <Chip
                    label={item.badge}
                    size="small"
                    sx={{
                      height: 20,
                      fontSize: '0.75rem',
                      bgcolor: 'primary.main',
                      color: '#fff',
                    }}
                  />
                )}
                {item.children && (
                  expandedItems.includes(item.label) ? <ExpandLess /> : <ExpandMore />
                )}
              </ListItemButton>
            </ListItem>
            {item.children && (
              <Collapse in={expandedItems.includes(item.label)} timeout="auto" unmountOnExit>
                <List component="div" disablePadding>
                  {item.children.map((child) => (
                    <ListItem key={child.label} disablePadding sx={{ pl: 2, mb: 0.5 }}>
                      <ListItemButton
                        onClick={() => handleItemClick(child)}
                        selected={isActive(child.path)}
                        sx={{
                          borderRadius: 1.5,
                          transition: 'all 0.2s',
                          '&.Mui-selected': {
                            bgcolor: 'rgba(33, 150, 243, 0.15)',
                            '&:hover': {
                              bgcolor: 'rgba(33, 150, 243, 0.2)',
                            },
                          },
                          '&:hover': {
                            bgcolor: 'rgba(255, 255, 255, 0.05)',
                          },
                        }}
                      >
                        <ListItemIcon sx={{ color: isActive(child.path) ? 'primary.main' : 'rgba(255, 255, 255, 0.7)', minWidth: 40 }}>
                          {child.icon}
                        </ListItemIcon>
                        <ListItemText
                          primary={child.label}
                          primaryTypographyProps={{
                            fontSize: '0.85rem',
                            fontWeight: isActive(child.path) ? 600 : 400,
                          }}
                        />
                      </ListItemButton>
                    </ListItem>
                  ))}
                </List>
              </Collapse>
            )}
          </React.Fragment>
        ))}
      </List>

      <Divider sx={{ borderColor: 'rgba(255, 255, 255, 0.1)' }} />

      {/* Bottom Navigation */}
      <List sx={{ px: 2, py: 1 }}>
        {bottomNavItems.map((item) => (
          <ListItem key={item.label} disablePadding sx={{ mb: 0.5 }}>
            <ListItemButton
              onClick={() => handleItemClick(item)}
              selected={isActive(item.path)}
              sx={{
                borderRadius: 1.5,
                transition: 'all 0.2s',
                '&.Mui-selected': {
                  bgcolor: 'rgba(33, 150, 243, 0.15)',
                  '&:hover': {
                    bgcolor: 'rgba(33, 150, 243, 0.2)',
                  },
                },
                '&:hover': {
                  bgcolor: 'rgba(255, 255, 255, 0.05)',
                },
              }}
            >
              <ListItemIcon sx={{ color: isActive(item.path) ? 'primary.main' : 'rgba(255, 255, 255, 0.7)', minWidth: 40 }}>
                {item.icon}
              </ListItemIcon>
              <ListItemText
                primary={item.label}
                primaryTypographyProps={{
                  fontSize: '0.9rem',
                  fontWeight: isActive(item.path) ? 600 : 400,
                }}
              />
            </ListItemButton>
          </ListItem>
        ))}
      </List>

      <WorkspaceCreate
        open={createWorkspaceOpen}
        onClose={() => setCreateWorkspaceOpen(false)}
        onSuccess={handleWorkspaceCreated}
      />
    </Box>
  );

  if (variant === 'temporary' || isMobile) {
    return (
      <Drawer
        variant="temporary"
        open={open}
        onClose={onClose}
        ModalProps={{
          keepMounted: true,
        }}
        sx={{
          display: { xs: 'block', md: variant === 'temporary' ? 'block' : 'none' },
          '& .MuiDrawer-paper': {
            boxSizing: 'border-box',
            width: drawerWidth,
            border: 'none',
          },
        }}
      >
        {drawerContent}
      </Drawer>
    );
  }

  return (
    <Drawer
      variant="permanent"
      sx={{
        width: drawerWidth,
        flexShrink: 0,
        display: { xs: 'none', md: 'block' },
        '& .MuiDrawer-paper': {
          width: drawerWidth,
          boxSizing: 'border-box',
          border: 'none',
        },
      }}
    >
      {drawerContent}
    </Drawer>
  );
};
