import React, { useState } from 'react';
import {
  AppBar,
  Toolbar,
  Typography,
  Box,
  IconButton,
  Menu,
  MenuItem,
  Avatar,
  Divider,
  ListItemIcon,
  ListItemText,
  Button,
  Chip,
  useTheme,
  useMediaQuery,
} from '@mui/material';
import {
  Menu as MenuIcon,
  AccountCircle as AccountCircleIcon,
  Settings as SettingsIcon,
  Logout as LogoutIcon,
  Dashboard as DashboardIcon,
  Business as BusinessIcon,
  Person as PersonIcon,
  Upgrade as UpgradeIcon,
} from '@mui/icons-material';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { WorkspaceSelector } from '../workspace/WorkspaceSelector';
import { BillingTier } from '../../types/billing.types';

interface AppNavigationProps {
  onMenuToggle?: () => void;
  userEmail?: string;
  userBillingTier?: BillingTier;
  onUpgrade?: () => void;
  onUserSettings?: () => void;
  onLogout?: () => void;
}

export function AppNavigation({
  onMenuToggle,
  userEmail,
  userBillingTier = 'free',
  onUpgrade,
  onUserSettings,
  onLogout,
}: AppNavigationProps) {
  const { currentWorkspace } = useWorkspace();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const [userMenuAnchor, setUserMenuAnchor] = useState<null | HTMLElement>(null);

  const handleUserMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setUserMenuAnchor(event.currentTarget);
  };

  const handleUserMenuClose = () => {
    setUserMenuAnchor(null);
  };

  const getBillingColor = (tier: BillingTier) => {
    switch (tier) {
      case 'starter': return 'info';
      case 'professional': return 'primary';
      case 'enterprise': return 'secondary';
      default: return 'default';
    }
  };

  const getBillingLabel = (tier: BillingTier) => {
    switch (tier) {
      case 'starter': return 'Starter';
      case 'professional': return 'Professional';
      case 'enterprise': return 'Enterprise';
      default: return 'Free';
    }
  };

  return (
    <AppBar position="static" elevation={1} sx={{ backgroundColor: 'background.paper', color: 'text.primary' }}>
      <Toolbar>
        {/* Menu Button (Mobile) */}
        {isMobile && onMenuToggle && (
          <IconButton
            edge="start"
            color="inherit"
            aria-label="menu"
            onClick={onMenuToggle}
            sx={{ mr: 2 }}
          >
            <MenuIcon />
          </IconButton>
        )}

        {/* Logo */}
        <Typography
          variant="h6"
          component="div"
          sx={{
            fontWeight: 'bold',
            background: 'linear-gradient(45deg, #2196F3 30%, #21CBF3 90%)',
            backgroundClip: 'text',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            mr: 3,
          }}
        >
          Unravl
        </Typography>

        {/* Workspace Selector */}
        {!isMobile && currentWorkspace && (
          <Box sx={{ mr: 'auto', maxWidth: 300 }}>
            <WorkspaceSelector variant="compact" />
          </Box>
        )}

        {/* Mobile Workspace Indicator */}
        {isMobile && currentWorkspace && (
          <Box sx={{ mr: 'auto', display: 'flex', alignItems: 'center', gap: 1 }}>
            {currentWorkspace.ownerType === 'organization' ? (
              <BusinessIcon fontSize="small" />
            ) : (
              <PersonIcon fontSize="small" />
            )}
            <Typography variant="body2" fontWeight="medium" noWrap>
              {currentWorkspace.name}
            </Typography>
          </Box>
        )}

        {/* Right Side */}
        <Box display="flex" alignItems="center" gap={1}>
          {/* Billing Tier */}
          <Chip
            label={getBillingLabel(userBillingTier)}
            size="small"
            color={getBillingColor(userBillingTier)}
            variant={userBillingTier === 'free' ? 'outlined' : 'filled'}
          />

          {/* Upgrade Button (Free Tier) */}
          {userBillingTier === 'free' && onUpgrade && (
            <Button
              size="small"
              variant="contained"
              color="primary"
              onClick={onUpgrade}
              startIcon={<UpgradeIcon />}
              sx={{ display: { xs: 'none', sm: 'flex' } }}
            >
              Upgrade
            </Button>
          )}

          {/* User Menu */}
          <IconButton
            size="large"
            edge="end"
            aria-label="account of current user"
            aria-controls="user-menu"
            aria-haspopup="true"
            onClick={handleUserMenuOpen}
            color="inherit"
          >
            <AccountCircleIcon />
          </IconButton>

          <Menu
            id="user-menu"
            anchorEl={userMenuAnchor}
            anchorOrigin={{
              vertical: 'bottom',
              horizontal: 'right',
            }}
            keepMounted
            transformOrigin={{
              vertical: 'top',
              horizontal: 'right',
            }}
            open={Boolean(userMenuAnchor)}
            onClose={handleUserMenuClose}
            PaperProps={{
              sx: {
                mt: 1,
                minWidth: 220,
              },
            }}
          >
            {/* User Info */}
            <Box px={2} py={1}>
              <Typography variant="subtitle2" fontWeight="bold">
                {userEmail || 'User'}
              </Typography>
              <Box display="flex" alignItems="center" gap={1} mt={0.5}>
                <Chip
                  label={getBillingLabel(userBillingTier)}
                  size="small"
                  color={getBillingColor(userBillingTier)}
                  variant="outlined"
                />
              </Box>
            </Box>

            <Divider />

            {/* Navigation Items */}
            <MenuItem onClick={() => { handleUserMenuClose(); window.location.href = '/'; }}>
              <ListItemIcon>
                <DashboardIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary="Dashboard" />
            </MenuItem>

            {/* Workspace Selector (Mobile) */}
            {isMobile && (
              <MenuItem onClick={handleUserMenuClose}>
                <Box width="100%">
                  <WorkspaceSelector variant="dropdown" showCreateButton={true} />
                </Box>
              </MenuItem>
            )}

            <Divider />

            {/* Settings */}
            {onUserSettings && (
              <MenuItem
                onClick={() => {
                  handleUserMenuClose();
                  onUserSettings();
                }}
              >
                <ListItemIcon>
                  <SettingsIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary="Settings" />
              </MenuItem>
            )}

            {/* Upgrade (Mobile or Free Tier) */}
            {userBillingTier === 'free' && onUpgrade && (
              <MenuItem
                onClick={() => {
                  handleUserMenuClose();
                  onUpgrade();
                }}
                sx={{ color: 'primary.main' }}
              >
                <ListItemIcon>
                  <UpgradeIcon fontSize="small" color="primary" />
                </ListItemIcon>
                <ListItemText primary="Upgrade Plan" />
              </MenuItem>
            )}

            <Divider />

            {/* Logout */}
            {onLogout && (
              <MenuItem
                onClick={() => {
                  handleUserMenuClose();
                  onLogout();
                }}
              >
                <ListItemIcon>
                  <LogoutIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary="Sign Out" />
              </MenuItem>
            )}
          </Menu>
        </Box>
      </Toolbar>
    </AppBar>
  );
}