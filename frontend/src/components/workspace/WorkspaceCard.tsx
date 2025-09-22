import React from 'react';
import {
  Card,
  CardContent,
  CardActions,
  Typography,
  Box,
  Chip,
  IconButton,
  Avatar,
  LinearProgress,
  Tooltip,
  Button,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
} from '@mui/material';
import {
  MoreVert as MoreVertIcon,
  Business as BusinessIcon,
  Person as PersonIcon,
  Code as CodeIcon,
  People as PeopleIcon,
  Storage as StorageIcon,
  Analytics as AnalyticsIcon,
  Settings as SettingsIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Launch as LaunchIcon,
} from '@mui/icons-material';
import { Workspace, WorkspaceStats } from '../../types/workspace.types';
import { formatStorageSize } from '../../types/billing.types';

interface WorkspaceCardProps {
  workspace: Workspace;
  stats?: WorkspaceStats;
  onSelect?: (workspace: Workspace) => void;
  onEdit?: (workspace: Workspace) => void;
  onDelete?: (workspace: Workspace) => void;
  onSettings?: (workspace: Workspace) => void;
  isSelected?: boolean;
  showActions?: boolean;
  variant?: 'default' | 'compact' | 'detailed';
}

export function WorkspaceCard({
  workspace,
  stats,
  onSelect,
  onEdit,
  onDelete,
  onSettings,
  isSelected = false,
  showActions = true,
  variant = 'default',
}: WorkspaceCardProps) {
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const isMenuOpen = Boolean(anchorEl);

  const handleOpenMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    setAnchorEl(event.currentTarget);
  };

  const handleCloseMenu = () => {
    setAnchorEl(null);
  };

  const handleMenuAction = (action: () => void) => {
    action();
    handleCloseMenu();
  };

  const handleCardClick = () => {
    if (onSelect && !isMenuOpen) {
      onSelect(workspace);
    }
  };

  const getWorkspaceIcon = () => {
    return workspace.ownerType === 'organization' ? (
      <BusinessIcon />
    ) : (
      <PersonIcon />
    );
  };

  const getWorkspaceColor = () => {
    return workspace.ownerType === 'organization' ? 'primary.main' : 'secondary.main';
  };

  if (variant === 'compact') {
    return (
      <Card
        sx={{
          cursor: onSelect ? 'pointer' : 'default',
          border: isSelected ? 2 : 1,
          borderColor: isSelected ? 'primary.main' : 'divider',
          '&:hover': onSelect ? { borderColor: 'primary.main', boxShadow: 2 } : {},
          transition: 'all 0.2s ease-in-out',
        }}
        onClick={handleCardClick}
      >
        <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
          <Box display="flex" alignItems="center" gap={2}>
            <Avatar sx={{ bgcolor: getWorkspaceColor(), width: 32, height: 32 }}>
              {getWorkspaceIcon()}
            </Avatar>

            <Box flex={1} minWidth={0}>
              <Typography variant="subtitle2" fontWeight="bold" noWrap>
                {workspace.name}
              </Typography>
              <Box display="flex" alignItems="center" gap={1}>
                <Chip
                  label={workspace.ownerType}
                  size="small"
                  variant="outlined"
                />
                {stats && (
                  <Typography variant="caption" color="text.secondary">
                    {stats.totalCodebases} codebases
                  </Typography>
                )}
              </Box>
            </Box>

            {showActions && (
              <IconButton size="small" onClick={handleOpenMenu}>
                <MoreVertIcon fontSize="small" />
              </IconButton>
            )}
          </Box>
        </CardContent>

        {showActions && (
          <Menu
            anchorEl={anchorEl}
            open={isMenuOpen}
            onClose={handleCloseMenu}
            onClick={(e) => e.stopPropagation()}
          >
            {onSelect && (
              <MenuItem onClick={() => handleMenuAction(() => onSelect(workspace))}>
                <ListItemIcon>
                  <LaunchIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary="Open workspace" />
              </MenuItem>
            )}
            {onEdit && (
              <MenuItem onClick={() => handleMenuAction(() => onEdit(workspace))}>
                <ListItemIcon>
                  <EditIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary="Edit" />
              </MenuItem>
            )}
            {onSettings && (
              <MenuItem onClick={() => handleMenuAction(() => onSettings(workspace))}>
                <ListItemIcon>
                  <SettingsIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary="Settings" />
              </MenuItem>
            )}
            {onDelete && (
              <MenuItem
                onClick={() => handleMenuAction(() => onDelete(workspace))}
                sx={{ color: 'error.main' }}
              >
                <ListItemIcon>
                  <DeleteIcon fontSize="small" color="error" />
                </ListItemIcon>
                <ListItemText primary="Delete" />
              </MenuItem>
            )}
          </Menu>
        )}
      </Card>
    );
  }

  if (variant === 'detailed') {
    return (
      <Card
        sx={{
          cursor: onSelect ? 'pointer' : 'default',
          border: isSelected ? 2 : 1,
          borderColor: isSelected ? 'primary.main' : 'divider',
          '&:hover': onSelect ? { borderColor: 'primary.main', boxShadow: 2 } : {},
          transition: 'all 0.2s ease-in-out',
        }}
        onClick={handleCardClick}
      >
        <CardContent>
          <Box display="flex" alignItems="flex-start" gap={2} mb={2}>
            <Avatar sx={{ bgcolor: getWorkspaceColor(), width: 48, height: 48 }}>
              {getWorkspaceIcon()}
            </Avatar>

            <Box flex={1} minWidth={0}>
              <Box display="flex" alignItems="center" gap={1} mb={1}>
                <Typography variant="h6" fontWeight="bold" noWrap>
                  {workspace.name}
                </Typography>
                <Chip
                  label={workspace.ownerType}
                  size="small"
                  variant="outlined"
                />
              </Box>

              {workspace.description && (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  }}
                >
                  {workspace.description}
                </Typography>
              )}

              {/* Tags not available in current backend response */}
            </Box>

            {showActions && (
              <IconButton onClick={handleOpenMenu}>
                <MoreVertIcon />
              </IconButton>
            )}
          </Box>

          {stats && (
            <Box>
              <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(120px, 1fr))" gap={2} mb={2}>
                <Box display="flex" alignItems="center" gap={1}>
                  <CodeIcon fontSize="small" color="primary" />
                  <Box>
                    <Typography variant="body2" fontWeight="medium">
                      {stats.totalCodebases}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Codebases
                    </Typography>
                  </Box>
                </Box>

                <Box display="flex" alignItems="center" gap={1}>
                  <PeopleIcon fontSize="small" color="primary" />
                  <Box>
                    <Typography variant="body2" fontWeight="medium">
                      {workspace.accessGrantCount || 0}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Users
                    </Typography>
                  </Box>
                </Box>

                <Box display="flex" alignItems="center" gap={1}>
                  <StorageIcon fontSize="small" color="primary" />
                  <Box>
                    <Typography variant="body2" fontWeight="medium">
                      {/* Storage info not available in current backend */}
                      N/A
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Storage
                    </Typography>
                  </Box>
                </Box>

                <Box display="flex" alignItems="center" gap={1}>
                  <AnalyticsIcon fontSize="small" color="primary" />
                  <Box>
                    <Typography variant="body2" fontWeight="medium">
                      {stats.totalAnalysisRuns}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Analyses
                    </Typography>
                  </Box>
                </Box>
              </Box>

              {/* Top languages not available in current backend response */}
            </Box>
          )}
        </CardContent>

        {showActions && onSelect && (
          <CardActions>
            <Button
              size="small"
              variant="outlined"
              onClick={(e) => {
                e.stopPropagation();
                onSelect(workspace);
              }}
              startIcon={<LaunchIcon />}
            >
              Open Workspace
            </Button>
          </CardActions>
        )}

        {showActions && (
          <Menu
            anchorEl={anchorEl}
            open={isMenuOpen}
            onClose={handleCloseMenu}
            onClick={(e) => e.stopPropagation()}
          >
            {onEdit && (
              <MenuItem onClick={() => handleMenuAction(() => onEdit(workspace))}>
                <ListItemIcon>
                  <EditIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary="Edit workspace" />
              </MenuItem>
            )}
            {onSettings && (
              <MenuItem onClick={() => handleMenuAction(() => onSettings(workspace))}>
                <ListItemIcon>
                  <SettingsIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary="Workspace settings" />
              </MenuItem>
            )}
            {onDelete && (
              <MenuItem
                onClick={() => handleMenuAction(() => onDelete(workspace))}
                sx={{ color: 'error.main' }}
              >
                <ListItemIcon>
                  <DeleteIcon fontSize="small" color="error" />
                </ListItemIcon>
                <ListItemText primary="Delete workspace" />
              </MenuItem>
            )}
          </Menu>
        )}
      </Card>
    );
  }

  // Default variant
  return (
    <Card
      sx={{
        cursor: onSelect ? 'pointer' : 'default',
        border: isSelected ? 2 : 1,
        borderColor: isSelected ? 'primary.main' : 'divider',
        '&:hover': onSelect ? { borderColor: 'primary.main', boxShadow: 2 } : {},
        transition: 'all 0.2s ease-in-out',
      }}
      onClick={handleCardClick}
    >
      <CardContent>
        <Box display="flex" alignItems="center" gap={2} mb={2}>
          <Avatar sx={{ bgcolor: getWorkspaceColor() }}>
            {getWorkspaceIcon()}
          </Avatar>

          <Box flex={1} minWidth={0}>
            <Typography variant="h6" fontWeight="bold" noWrap>
              {workspace.name}
            </Typography>
            <Chip
              label={workspace.ownerType}
              size="small"
              variant="outlined"
            />
          </Box>

          {showActions && (
            <IconButton onClick={handleOpenMenu}>
              <MoreVertIcon />
            </IconButton>
          )}
        </Box>

        {workspace.description && (
          <Typography variant="body2" color="text.secondary" mb={2}>
            {workspace.description}
          </Typography>
        )}

        {stats && (
          <Box display="flex" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">
              {stats.totalCodebases} codebases
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {/* Storage size not available in current backend */}\n              N/A
            </Typography>
          </Box>
        )}
      </CardContent>

      {showActions && (
        <Menu
          anchorEl={anchorEl}
          open={isMenuOpen}
          onClose={handleCloseMenu}
          onClick={(e) => e.stopPropagation()}
        >
          {onSelect && (
            <MenuItem onClick={() => handleMenuAction(() => onSelect(workspace))}>
              <ListItemIcon>
                <LaunchIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary="Open workspace" />
            </MenuItem>
          )}
          {onEdit && (
            <MenuItem onClick={() => handleMenuAction(() => onEdit(workspace))}>
              <ListItemIcon>
                <EditIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary="Edit" />
            </MenuItem>
          )}
          {onSettings && (
            <MenuItem onClick={() => handleMenuAction(() => onSettings(workspace))}>
              <ListItemIcon>
                <SettingsIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary="Settings" />
            </MenuItem>
          )}
          {onDelete && (
            <MenuItem
              onClick={() => handleMenuAction(() => onDelete(workspace))}
              sx={{ color: 'error.main' }}
            >
              <ListItemIcon>
                <DeleteIcon fontSize="small" color="error" />
              </ListItemIcon>
              <ListItemText primary="Delete" />
            </MenuItem>
          )}
        </Menu>
      )}
    </Card>
  );
}