import React, { useState } from 'react';
import { useRouter } from 'next/router';
import {
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Box,
  Typography,
  Avatar,
  Chip,
  IconButton,
  Menu,
  ListItemIcon,
  ListItemText,
  Divider,
  CircularProgress,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  Add as AddIcon,
  Business as BusinessIcon,
  Person as PersonIcon,
  Settings as SettingsIcon,
} from '@mui/icons-material';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { Workspace } from '../../types/workspace.types';

interface WorkspaceSelectorProps {
  onCreateWorkspace?: () => void;
  onWorkspaceSettings?: (workspace: Workspace) => void;
  showCreateButton?: boolean;
  variant?: 'dropdown' | 'compact' | 'detailed';
}

export function WorkspaceSelector({
  onCreateWorkspace,
  onWorkspaceSettings,
  showCreateButton = true,
  variant = 'dropdown',
}: WorkspaceSelectorProps) {
  const router = useRouter();
  const {
    currentWorkspace,
    workspaces,
    isLoading,
    error,
    switchWorkspace,
  } = useWorkspace();

  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const isMenuOpen = Boolean(anchorEl);

  const handleOpenMenu = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleCloseMenu = () => {
    setAnchorEl(null);
  };

  const handleSelectWorkspace = async (workspaceId: string) => {
    if (workspaceId !== currentWorkspace?.id) {
      await switchWorkspace(workspaceId);
      router.push(`/workspace/${workspaceId}`);
    }
    handleCloseMenu();
  };

  const handleCreateWorkspace = () => {
    handleCloseMenu();
    onCreateWorkspace?.();
  };

  const handleWorkspaceSettings = (workspace: Workspace) => {
    handleCloseMenu();
    onWorkspaceSettings?.(workspace);
  };

  if (isLoading && workspaces.length === 0) {
    return (
      <Box display="flex" alignItems="center" gap={1}>
        <CircularProgress size={20} />
        <Typography variant="body2" color="text.secondary">
          Loading workspaces...
        </Typography>
      </Box>
    );
  }

  if (error) {
    return (
      <Typography variant="body2" color="error">
        Failed to load workspaces
      </Typography>
    );
  }

  if (variant === 'compact') {
    return (
      <Box display="flex" alignItems="center" gap={1}>
        <IconButton
          onClick={handleOpenMenu}
          size="small"
          sx={{
            bgcolor: 'background.paper',
            border: 1,
            borderColor: 'divider',
            '&:hover': { bgcolor: 'action.hover' },
          }}
        >
          {currentWorkspace?.ownerType === 'organization' ? (
            <BusinessIcon fontSize="small" />
          ) : (
            <PersonIcon fontSize="small" />
          )}
        </IconButton>

        <Typography variant="body2" fontWeight="medium">
          {currentWorkspace?.name || 'No workspace'}
        </Typography>

        <Menu
          anchorEl={anchorEl}
          open={isMenuOpen}
          onClose={handleCloseMenu}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        >
          {workspaces.map((workspace) => (
            <MenuItem
              key={workspace.id}
              onClick={() => handleSelectWorkspace(workspace.id)}
              selected={workspace.id === currentWorkspace?.id}
            >
              <ListItemIcon>
                {workspace.ownerType === 'organization' ? (
                  <BusinessIcon fontSize="small" />
                ) : (
                  <PersonIcon fontSize="small" />
                )}
              </ListItemIcon>
              <ListItemText primary={workspace.name} />
            </MenuItem>
          ))}

          {showCreateButton && (
            <>
              <Divider />
              <MenuItem onClick={handleCreateWorkspace}>
                <ListItemIcon>
                  <AddIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary="Create workspace" />
              </MenuItem>
            </>
          )}
        </Menu>
      </Box>
    );
  }

  if (variant === 'detailed') {
    return (
      <Box>
        <Box
          display="flex"
          alignItems="center"
          gap={2}
          p={2}
          bgcolor="background.paper"
          borderRadius={1}
          border={1}
          borderColor="divider"
          onClick={handleOpenMenu}
          sx={{ cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
        >
          <Avatar
            sx={{
              width: 40,
              height: 40,
              bgcolor: currentWorkspace?.ownerType === 'organization' ? 'primary.main' : 'secondary.main',
            }}
          >
            {currentWorkspace?.ownerType === 'organization' ? (
              <BusinessIcon />
            ) : (
              <PersonIcon />
            )}
          </Avatar>

          <Box flex={1}>
            <Typography variant="h6" fontWeight="bold">
              {currentWorkspace?.name || 'No workspace selected'}
            </Typography>
            {currentWorkspace && (
              <Box display="flex" alignItems="center" gap={1}>
                <Chip
                  label={currentWorkspace.ownerType}
                  size="small"
                  variant="outlined"
                />
                {currentWorkspace.codebaseCount !== undefined && (
                  <Typography variant="body2" color="text.secondary">
                    {currentWorkspace.codebaseCount} codebases
                  </Typography>
                )}
              </Box>
            )}
          </Box>

          <ExpandMoreIcon />
        </Box>

        <Menu
          anchorEl={anchorEl}
          open={isMenuOpen}
          onClose={handleCloseMenu}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          transformOrigin={{ vertical: 'top', horizontal: 'left' }}
          PaperProps={{ sx: { minWidth: 300 } }}
        >
          {workspaces.map((workspace) => (
            <MenuItem
              key={workspace.id}
              onClick={() => handleSelectWorkspace(workspace.id)}
              selected={workspace.id === currentWorkspace?.id}
              sx={{ py: 1.5 }}
            >
              <ListItemIcon>
                <Avatar
                  sx={{
                    width: 32,
                    height: 32,
                    bgcolor: workspace.ownerType === 'organization' ? 'primary.main' : 'secondary.main',
                  }}
                >
                  {workspace.ownerType === 'organization' ? (
                    <BusinessIcon fontSize="small" />
                  ) : (
                    <PersonIcon fontSize="small" />
                  )}
                </Avatar>
              </ListItemIcon>
              <ListItemText
                primary={workspace.name}
                secondary={
                  <Box display="flex" alignItems="center" gap={1}>
                    <Chip
                      label={workspace.ownerType}
                      size="small"
                      variant="outlined"
                    />
                    {workspace.codebaseCount !== undefined && (
                      <Typography variant="caption" color="text.secondary">
                        {workspace.codebaseCount} codebases
                      </Typography>
                    )}
                  </Box>
                }
              />
              {onWorkspaceSettings && (
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleWorkspaceSettings(workspace);
                  }}
                >
                  <SettingsIcon fontSize="small" />
                </IconButton>
              )}
            </MenuItem>
          ))}

          {showCreateButton && (
            <>
              <Divider />
              <MenuItem onClick={handleCreateWorkspace}>
                <ListItemIcon>
                  <AddIcon />
                </ListItemIcon>
                <ListItemText primary="Create new workspace" />
              </MenuItem>
            </>
          )}
        </Menu>
      </Box>
    );
  }

  // Default dropdown variant
  return (
    <FormControl fullWidth size="small">
      <InputLabel>Workspace</InputLabel>
      <Select
        value={currentWorkspace?.id || ''}
        label="Workspace"
        onChange={(e) => handleSelectWorkspace(e.target.value)}
        disabled={isLoading}
        endAdornment={
          showCreateButton && (
            <IconButton
              size="small"
              onClick={handleCreateWorkspace}
              sx={{ mr: 1 }}
            >
              <AddIcon fontSize="small" />
            </IconButton>
          )
        }
      >
        {workspaces.map((workspace) => (
          <MenuItem key={workspace.id} value={workspace.id}>
            <Box display="flex" alignItems="center" gap={1} width="100%">
              {workspace.ownerType === 'organization' ? (
                <BusinessIcon fontSize="small" />
              ) : (
                <PersonIcon fontSize="small" />
              )}
              <Typography variant="body2" flex={1}>
                {workspace.name}
              </Typography>
              <Chip
                label={workspace.ownerType}
                size="small"
                variant="outlined"
              />
            </Box>
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}