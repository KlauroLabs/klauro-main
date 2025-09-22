import React from 'react';
import {
  Card,
  CardContent,
  CardActions,
  Typography,
  Box,
  Chip,
  IconButton,
  LinearProgress,
  Tooltip,
  Button,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Avatar,
} from '@mui/material';
import {
  MoreVert as MoreVertIcon,
  Code as CodeIcon,
  Analytics as AnalyticsIcon,
  BugReport as BugReportIcon,
  Schedule as ScheduleIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Pause as PauseIcon,
  PlayArrow as PlayArrowIcon,
  Settings as SettingsIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Launch as LaunchIcon,
  GitHub as GitHubIcon,
  Link as LinkIcon,
} from '@mui/icons-material';
import { Codebase } from '../../types/workspace.types';
import { formatStorageSize } from '../../types/billing.types';

interface CodebaseCardProps {
  codebase: Codebase;
  onSelect?: (codebase: Codebase) => void;
  onEdit?: (codebase: Codebase) => void;
  onDelete?: (codebase: Codebase) => void;
  onSettings?: (codebase: Codebase) => void;
  onStartAnalysis?: (codebase: Codebase) => void;
  isSelected?: boolean;
  showActions?: boolean;
  variant?: 'default' | 'compact' | 'detailed';
}

export function CodebaseCard({
  codebase,
  onSelect,
  onEdit,
  onDelete,
  onSettings,
  onStartAnalysis,
  isSelected = false,
  showActions = true,
  variant = 'default',
}: CodebaseCardProps) {
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
      onSelect(codebase);
    }
  };

  const getStatusColor = () => {
    switch (codebase.status) {
      case 'active': return 'success';
      case 'analyzing': return 'info';
      case 'error': return 'error';
      case 'archived': return 'default';
      default: return 'default';
    }
  };

  const getStatusIcon = () => {
    switch (codebase.status) {
      case 'active': return <CheckCircleIcon fontSize="small" />;
      case 'analyzing': return <AnalyticsIcon fontSize="small" />;
      case 'error': return <ErrorIcon fontSize="small" />;
      case 'archived': return <PauseIcon fontSize="small" />;
      default: return <PauseIcon fontSize="small" />;
    }
  };

  const formatAnalysisDate = (dateString?: string) => {
    if (!dateString) return 'Never analyzed';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffHours < 1) return 'Just analyzed';
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString();
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
            <Avatar sx={{ bgcolor: 'primary.main', width: 32, height: 32 }}>
              <CodeIcon fontSize="small" />
            </Avatar>

            <Box flex={1} minWidth={0}>
              <Typography variant="subtitle2" fontWeight="bold" noWrap>
                {codebase.name}
              </Typography>
              <Box display="flex" alignItems="center" gap={1}>
                <Chip
                  label={codebase.status}
                  size="small"
                  color={getStatusColor()}
                  icon={getStatusIcon()}
                />
                {codebase.fileCount !== undefined && (
                  <Typography variant="caption" color="text.secondary">
                    {codebase.fileCount} files
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
              <MenuItem onClick={() => handleMenuAction(() => onSelect(codebase))}>
                <ListItemIcon>
                  <LaunchIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary="Open codebase" />
              </MenuItem>
            )}
            {onStartAnalysis && (
              <MenuItem onClick={() => handleMenuAction(() => onStartAnalysis(codebase))}>
                <ListItemIcon>
                  <PlayArrowIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary="Start analysis" />
              </MenuItem>
            )}
            {onEdit && (
              <MenuItem onClick={() => handleMenuAction(() => onEdit(codebase))}>
                <ListItemIcon>
                  <EditIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary="Edit" />
              </MenuItem>
            )}
            {onSettings && (
              <MenuItem onClick={() => handleMenuAction(() => onSettings(codebase))}>
                <ListItemIcon>
                  <SettingsIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary="Settings" />
              </MenuItem>
            )}
            {onDelete && (
              <MenuItem
                onClick={() => handleMenuAction(() => onDelete(codebase))}
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
            <Avatar sx={{ bgcolor: 'primary.main', width: 48, height: 48 }}>
              <CodeIcon />
            </Avatar>

            <Box flex={1} minWidth={0}>
              <Box display="flex" alignItems="center" gap={1} mb={1}>
                <Typography variant="h6" fontWeight="bold" noWrap>
                  {codebase.name}
                </Typography>
                <Chip
                  label={codebase.status}
                  size="small"
                  color={getStatusColor()}
                  icon={getStatusIcon()}
                />
              </Box>

              {codebase.description && (
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
                  mb={1}
                >
                  {codebase.description}
                </Typography>
              )}

              {codebase.repositoryUrl && (
                <Box display="flex" alignItems="center" gap={1} mb={1}>
                  {codebase.repositoryUrl.includes('github.com') ? (
                    <GitHubIcon fontSize="small" color="action" />
                  ) : (
                    <LinkIcon fontSize="small" color="action" />
                  )}
                  <Typography
                    variant="caption"
                    color="primary"
                    component="a"
                    href={codebase.repositoryUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    sx={{ textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
                  >
                    {codebase.repositoryUrl}
                  </Typography>
                </Box>
              )}

              {/* Tags not available in current backend response */}
            </Box>

            {showActions && (
              <IconButton onClick={handleOpenMenu}>
                <MoreVertIcon />
              </IconButton>
            )}
          </Box>

          <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(120px, 1fr))" gap={2} mb={2}>
            {codebase.fileCount !== undefined && (
              <Box>
                <Typography variant="body2" fontWeight="medium">
                  {codebase.fileCount.toLocaleString()}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Files
                </Typography>
              </Box>
            )}

            {codebase.sizeBytes !== undefined && (
              <Box>
                <Typography variant="body2" fontWeight="medium">
                  {formatStorageSize(codebase.sizeBytes)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Size
                </Typography>
              </Box>
            )}

            {codebase.healthScore !== undefined && (
              <Box>
                <Typography variant="body2" fontWeight="medium">
                  {codebase.healthScore}/100
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Health Score
                </Typography>
              </Box>
            )}

            <Box>
              <Typography variant="body2" fontWeight="medium">
                {formatAnalysisDate(codebase.lastAnalyzedAt)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Last Analysis
              </Typography>
            </Box>
          </Box>

          {codebase.languageBreakdown && Object.keys(codebase.languageBreakdown).length > 0 && (
            <Box>
              <Typography variant="caption" color="text.secondary" mb={1} display="block">
                Languages
              </Typography>
              {Object.entries(codebase.languageBreakdown)
                .sort(([,a], [,b]) => b - a)
                .slice(0, 3)
                .map(([language, percentage]) => (
                  <Box key={language} mb={0.5}>
                    <Box display="flex" justifyContent="space-between" alignItems="center">
                      <Typography variant="caption">{language}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {percentage.toFixed(1)}%
                      </Typography>
                    </Box>
                    <LinearProgress
                      variant="determinate"
                      value={percentage}
                      sx={{ height: 4, borderRadius: 2 }}
                    />
                  </Box>
                ))}
            </Box>
          )}
        </CardContent>

        {showActions && (
          <CardActions>
            {onSelect && (
              <Button
                size="small"
                variant="outlined"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(codebase);
                }}
                startIcon={<LaunchIcon />}
              >
                Analyze
              </Button>
            )}
            {onStartAnalysis && codebase.status !== 'analyzing' && (
              <Button
                size="small"
                variant="contained"
                onClick={(e) => {
                  e.stopPropagation();
                  onStartAnalysis(codebase);
                }}
                startIcon={<PlayArrowIcon />}
              >
                Start Analysis
              </Button>
            )}
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
              <MenuItem onClick={() => handleMenuAction(() => onEdit(codebase))}>
                <ListItemIcon>
                  <EditIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary="Edit codebase" />
              </MenuItem>
            )}
            {onSettings && (
              <MenuItem onClick={() => handleMenuAction(() => onSettings(codebase))}>
                <ListItemIcon>
                  <SettingsIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary="Codebase settings" />
              </MenuItem>
            )}
            {onDelete && (
              <MenuItem
                onClick={() => handleMenuAction(() => onDelete(codebase))}
                sx={{ color: 'error.main' }}
              >
                <ListItemIcon>
                  <DeleteIcon fontSize="small" color="error" />
                </ListItemIcon>
                <ListItemText primary="Delete codebase" />
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
          <Avatar sx={{ bgcolor: 'primary.main' }}>
            <CodeIcon />
          </Avatar>

          <Box flex={1} minWidth={0}>
            <Typography variant="h6" fontWeight="bold" noWrap>
              {codebase.name}
            </Typography>
            <Chip
              label={codebase.status}
              size="small"
              color={getStatusColor()}
              icon={getStatusIcon()}
            />
          </Box>

          {showActions && (
            <IconButton onClick={handleOpenMenu}>
              <MoreVertIcon />
            </IconButton>
          )}
        </Box>

        {codebase.description && (
          <Typography variant="body2" color="text.secondary" mb={2}>
            {codebase.description}
          </Typography>
        )}

        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Typography variant="body2" color="text.secondary">
            {codebase.fileCount ? `${codebase.fileCount} files` : 'No files analyzed'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {formatAnalysisDate(codebase.lastAnalyzedAt)}
          </Typography>
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
            <MenuItem onClick={() => handleMenuAction(() => onSelect(codebase))}>
              <ListItemIcon>
                <LaunchIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary="Open codebase" />
            </MenuItem>
          )}
          {onStartAnalysis && (
            <MenuItem onClick={() => handleMenuAction(() => onStartAnalysis(codebase))}>
              <ListItemIcon>
                <PlayArrowIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary="Start analysis" />
            </MenuItem>
          )}
          {onEdit && (
            <MenuItem onClick={() => handleMenuAction(() => onEdit(codebase))}>
              <ListItemIcon>
                <EditIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary="Edit" />
            </MenuItem>
          )}
          {onSettings && (
            <MenuItem onClick={() => handleMenuAction(() => onSettings(codebase))}>
              <ListItemIcon>
                <SettingsIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary="Settings" />
            </MenuItem>
          )}
          {onDelete && (
            <MenuItem
              onClick={() => handleMenuAction(() => onDelete(codebase))}
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