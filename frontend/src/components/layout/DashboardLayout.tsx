import React, { useState } from 'react';
import {
  Box,
  AppBar,
  Toolbar,
  IconButton,
  Typography,
  Avatar,
  Menu,
  MenuItem,
  Divider,
  ListItemIcon,
  Chip,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  Menu as MenuIcon,
  AccountCircle as AccountCircleIcon,
  Settings as SettingsIcon,
  Logout as LogoutIcon,
  Notifications as NotificationsIcon,
} from '@mui/icons-material';
import { useAuth } from '../../contexts/AuthContext';
import { Sidebar } from './Sidebar';

interface DashboardLayoutProps {
  children: React.ReactNode;
  pageTitle?: string;
  actions?: React.ReactNode;
}

export const DashboardLayout: React.FC<DashboardLayoutProps> = ({
  children,
  pageTitle,
  actions,
}) => {
  const theme = useTheme();
  const { user, logout } = useAuth();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  const handleDrawerToggle = () => {
    setMobileOpen(!mobileOpen);
  };

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleMenuClose = () => {
    setAnchorEl(null);
  };

  const handleLogout = () => {
    handleMenuClose();
    logout();
  };

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: '#0a0a0a' }}>
      {/* Sidebar */}
      <Sidebar
        open={mobileOpen}
        onClose={handleDrawerToggle}
        variant={isMobile ? 'temporary' : 'permanent'}
      />

      {/* Main Content */}
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: '100vh',
          overflow: 'auto',
        }}
      >
        {/* Top AppBar */}
        <AppBar
          position="sticky"
          elevation={0}
          sx={{
            bgcolor: 'rgba(10, 10, 10, 0.8)',
            backdropFilter: 'blur(10px)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          }}
        >
          <Toolbar>
            {isMobile && (
              <IconButton
                color="inherit"
                edge="start"
                onClick={handleDrawerToggle}
                sx={{ mr: 2 }}
              >
                <MenuIcon />
              </IconButton>
            )}

            {pageTitle && (
              <Typography variant="h6" component="h1" sx={{ flexGrow: 1, fontWeight: 600 }}>
                {pageTitle}
              </Typography>
            )}

            <Box sx={{ flexGrow: 1 }} />

            {/* Action Buttons */}
            {actions && <Box sx={{ mr: 2 }}>{actions}</Box>}

            {/* Notifications */}
            <IconButton
              color="inherit"
              sx={{
                mr: 1,
                '&:hover': {
                  bgcolor: 'rgba(255, 255, 255, 0.1)',
                },
              }}
            >
              <NotificationsIcon />
            </IconButton>

            {/* User Menu */}
            {user && (
              <>
                <IconButton
                  onClick={handleMenuOpen}
                  sx={{
                    p: 0.5,
                    '&:hover': {
                      bgcolor: 'rgba(255, 255, 255, 0.1)',
                    },
                  }}
                >
                  {user.avatarUrl ? (
                    <Avatar
                      alt={user.name}
                      src={user.avatarUrl}
                      sx={{ width: 36, height: 36 }}
                    />
                  ) : (
                    <Avatar
                      sx={{
                        width: 36,
                        height: 36,
                        bgcolor: 'primary.main',
                        fontWeight: 600,
                      }}
                    >
                      {user.name.charAt(0).toUpperCase()}
                    </Avatar>
                  )}
                </IconButton>

                <Menu
                  anchorEl={anchorEl}
                  open={Boolean(anchorEl)}
                  onClose={handleMenuClose}
                  anchorOrigin={{
                    vertical: 'bottom',
                    horizontal: 'right',
                  }}
                  transformOrigin={{
                    vertical: 'top',
                    horizontal: 'right',
                  }}
                  sx={{
                    mt: 1.5,
                    '& .MuiPaper-root': {
                      backgroundColor: 'rgba(30, 30, 30, 0.95)',
                      backdropFilter: 'blur(10px)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      minWidth: 220,
                    },
                  }}
                >
                  <Box sx={{ px: 2, py: 1.5 }}>
                    <Typography
                      variant="body2"
                      sx={{ fontWeight: 600, color: '#fff' }}
                    >
                      {user.name}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{ color: 'rgba(255, 255, 255, 0.6)' }}
                    >
                      {user.email}
                    </Typography>
                    <Chip
                      label="Pro"
                      size="small"
                      sx={{
                        mt: 1,
                        height: 20,
                        fontSize: '0.7rem',
                        bgcolor: 'primary.main',
                        color: '#fff',
                      }}
                    />
                  </Box>

                  <Divider sx={{ borderColor: 'rgba(255, 255, 255, 0.1)' }} />

                  <MenuItem onClick={handleMenuClose}>
                    <ListItemIcon>
                      <AccountCircleIcon
                        fontSize="small"
                        sx={{ color: 'rgba(255, 255, 255, 0.7)' }}
                      />
                    </ListItemIcon>
                    <Typography variant="body2">Profile</Typography>
                  </MenuItem>

                  <MenuItem onClick={handleMenuClose}>
                    <ListItemIcon>
                      <SettingsIcon
                        fontSize="small"
                        sx={{ color: 'rgba(255, 255, 255, 0.7)' }}
                      />
                    </ListItemIcon>
                    <Typography variant="body2">Settings</Typography>
                  </MenuItem>

                  <Divider sx={{ borderColor: 'rgba(255, 255, 255, 0.1)' }} />

                  <MenuItem onClick={handleLogout}>
                    <ListItemIcon>
                      <LogoutIcon
                        fontSize="small"
                        sx={{ color: 'rgba(255, 255, 255, 0.7)' }}
                      />
                    </ListItemIcon>
                    <Typography variant="body2">Logout</Typography>
                  </MenuItem>
                </Menu>
              </>
            )}
          </Toolbar>
        </AppBar>

        {/* Page Content */}
        <Box
          sx={{
            flexGrow: 1,
            p: { xs: 2, sm: 3, md: 4 },
            overflow: 'auto',
          }}
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
};
