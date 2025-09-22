import React, { useState, useMemo } from 'react';
import {
  Box,
  Typography,
  Button,
  Grid,
  Card,
  CardContent,
  Avatar,
  Chip,
  LinearProgress,
  IconButton,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  TextField,
  InputAdornment,
  Fab,
  Alert,
  Skeleton,
} from '@mui/material';
import {
  Add as AddIcon,
  Search as SearchIcon,
  FilterList as FilterIcon,
  Business as BusinessIcon,
  Person as PersonIcon,
  Code as CodeIcon,
  Analytics as AnalyticsIcon,
  Storage as StorageIcon,
  People as PeopleIcon,
  TrendingUp as TrendingUpIcon,
  Settings as SettingsIcon,
  MoreVert as MoreVertIcon,
} from '@mui/icons-material';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useWorkspaceDetails } from '../hooks/useWorkspaces';
import { useCodebases } from '../hooks/useCodebases';
import { WorkspaceSelector } from '../components/workspace/WorkspaceSelector';
import { WorkspaceCreate } from '../components/workspace/WorkspaceCreate';
import { CodebaseCard } from '../components/codebase/CodebaseCard';
import { CodebaseCreate } from '../components/codebase/CodebaseCreate';
import { formatStorageSize } from '../types/billing.types';
import { Codebase } from '../types/workspace.types';

export function WorkspaceDashboard() {
  const { currentWorkspace } = useWorkspace();
  const { workspace, stats, isLoading: workspaceLoading } = useWorkspaceDetails(currentWorkspace?.id || null);
  const { codebases, isLoading: codebasesLoading, refreshCodebases } = useCodebases(currentWorkspace?.id || null);

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [showCreateCodebase, setShowCreateCodebase] = useState(false);
  const [actionAnchorEl, setActionAnchorEl] = useState<null | HTMLElement>(null);

  const filteredCodebases = useMemo(() => {
    return codebases.filter(codebase => {
      const matchesSearch = searchTerm === '' ||
        codebase.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (codebase.description && codebase.description.toLowerCase().includes(searchTerm.toLowerCase()));

      const matchesTags = selectedTags.length === 0 ||
        selectedTags.some(tag => codebase.tags.includes(tag));

      return matchesSearch && matchesTags;
    });
  }, [codebases, searchTerm, selectedTags]);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    codebases.forEach(codebase => {
      codebase.tags.forEach(tag => tags.add(tag));
    });
    return Array.from(tags).sort();
  }, [codebases]);

  const handleCreateCodebase = () => {
    setShowCreateCodebase(true);
    setActionAnchorEl(null);
  };

  const handleStartAnalysis = async (codebase: Codebase) => {
    // This would integrate with the analysis system
    console.log('Starting analysis for:', codebase.name);
  };

  const handleSelectCodebase = (codebase: Codebase) => {
    // Navigate to codebase analysis view
    window.location.href = `/workspace/${currentWorkspace?.id}/codebase/${codebase.id}`;
  };

  if (!currentWorkspace) {
    return (
      <Box p={4} textAlign="center">
        <Typography variant="h5" gutterBottom>
          Welcome to Unravl
        </Typography>
        <Typography variant="body1" color="text.secondary" mb={3}>
          Create or select a workspace to get started
        </Typography>
        <Button
          variant="contained"
          size="large"
          onClick={() => setShowCreateWorkspace(true)}
          startIcon={<AddIcon />}
        >
          Create Your First Workspace
        </Button>

        <WorkspaceCreate
          open={showCreateWorkspace}
          onClose={() => setShowCreateWorkspace(false)}
          onSuccess={() => setShowCreateWorkspace(false)}
        />
      </Box>
    );
  }

  return (
    <Box p={3}>
      {/* Header */}
      <Box display="flex" alignItems="center" justifyContent="space-between" mb={3}>
        <Box>
          <Typography variant="h4" fontWeight="bold" gutterBottom>
            {workspace?.name || currentWorkspace.name}
          </Typography>
          <Box display="flex" alignItems="center" gap={2}>
            <Chip
              icon={workspace?.ownerType === 'organization' ? <BusinessIcon /> : <PersonIcon />}
              label={workspace?.ownerType || currentWorkspace.ownerType}
              variant="outlined"
            />
            {workspace?.description && (
              <Typography variant="body2" color="text.secondary">
                {workspace.description}
              </Typography>
            )}
          </Box>
        </Box>

        <Box display="flex" gap={1}>
          <WorkspaceSelector variant="compact" />
          <IconButton
            onClick={(e) => setActionAnchorEl(e.currentTarget)}
            sx={{ ml: 1 }}
          >
            <MoreVertIcon />
          </IconButton>
        </Box>
      </Box>

      {/* Stats Cards */}
      <Grid container spacing={3} mb={4}>
        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Box display="flex" alignItems="center" gap={2}>
                <Avatar sx={{ bgcolor: 'primary.main' }}>
                  <CodeIcon />
                </Avatar>
                <Box>
                  <Typography variant="h4" fontWeight="bold">
                    {workspaceLoading ? <Skeleton width={40} /> : stats?.totalCodebases || 0}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Codebases
                  </Typography>
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Box display="flex" alignItems="center" gap={2}>
                <Avatar sx={{ bgcolor: 'success.main' }}>
                  <AnalyticsIcon />
                </Avatar>
                <Box>
                  <Typography variant="h4" fontWeight="bold">
                    {workspaceLoading ? <Skeleton width={40} /> : 0}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Analyses This Month
                  </Typography>
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Box display="flex" alignItems="center" gap={2}>
                <Avatar sx={{ bgcolor: 'info.main' }}>
                  <StorageIcon />
                </Avatar>
                <Box>
                  <Typography variant="h4" fontWeight="bold">
                    {workspaceLoading ? (
                      <Skeleton width={60} />
                    ) : (
                      formatStorageSize(0)
                    )}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Storage Used
                  </Typography>
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Box display="flex" alignItems="center" gap={2}>
                <Avatar sx={{ bgcolor: 'secondary.main' }}>
                  <PeopleIcon />
                </Avatar>
                <Box>
                  <Typography variant="h4" fontWeight="bold">
                    {workspaceLoading ? <Skeleton width={40} /> : 1}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Team Members
                  </Typography>
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Language Breakdown - TODO: Fix after stats interface alignment
      {stats?.top_languages && stats.top_languages.length > 0 && (
        <Card sx={{ mb: 4 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Language Breakdown
            </Typography>
            <Grid container spacing={2}>
              {stats.top_languages.slice(0, 5).map((lang) => (
                <Grid item xs={12} sm={6} md={4} lg={2} key={lang.language}>
                  <Box>
                    <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
                      <Typography variant="body2" fontWeight="medium">
                        {lang.language}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {lang.percentage.toFixed(1)}%
                      </Typography>
                    </Box>
                    <LinearProgress
                      variant="determinate"
                      value={lang.percentage}
                      sx={{ height: 8, borderRadius: 4 }}
                    />
                  </Box>
                </Grid>
              ))}
            </Grid>
          </CardContent>
        </Card>
      )} */}

      {/* Search and Filters */}
      <Box display="flex" gap={2} mb={3}>
        <TextField
          placeholder="Search codebases..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon />
              </InputAdornment>
            ),
          }}
          sx={{ flexGrow: 1 }}
        />

        {allTags.length > 0 && (
          <Button
            variant="outlined"
            startIcon={<FilterIcon />}
            onClick={(e) => setActionAnchorEl(e.currentTarget)}
          >
            Filter by Tags
          </Button>
        )}
      </Box>

      {/* Codebases Grid */}
      {codebasesLoading ? (
        <Grid container spacing={3}>
          {[...Array(6)].map((_, index) => (
            <Grid item xs={12} sm={6} md={4} key={index}>
              <Card>
                <CardContent>
                  <Skeleton variant="rectangular" height={200} />
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      ) : filteredCodebases.length === 0 ? (
        <Box textAlign="center" py={8}>
          {codebases.length === 0 ? (
            <>
              <Typography variant="h6" gutterBottom>
                No codebases yet
              </Typography>
              <Typography variant="body2" color="text.secondary" mb={3}>
                Add your first codebase to start analyzing your code architecture
              </Typography>
              <Button
                variant="contained"
                size="large"
                onClick={handleCreateCodebase}
                startIcon={<AddIcon />}
              >
                Add First Codebase
              </Button>
            </>
          ) : (
            <>
              <Typography variant="h6" gutterBottom>
                No codebases match your search
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Try adjusting your search terms or filters
              </Typography>
            </>
          )}
        </Box>
      ) : (
        <Grid container spacing={3}>
          {filteredCodebases.map((codebase) => (
            <Grid item xs={12} sm={6} md={4} key={codebase.id}>
              <CodebaseCard
                codebase={codebase}
                variant="detailed"
                onSelect={handleSelectCodebase}
                onStartAnalysis={handleStartAnalysis}
              />
            </Grid>
          ))}
        </Grid>
      )}

      {/* Floating Action Button */}
      {codebases.length > 0 && (
        <Fab
          color="primary"
          sx={{ position: 'fixed', bottom: 24, right: 24 }}
          onClick={handleCreateCodebase}
        >
          <AddIcon />
        </Fab>
      )}

      {/* Action Menu */}
      <Menu
        anchorEl={actionAnchorEl}
        open={Boolean(actionAnchorEl)}
        onClose={() => setActionAnchorEl(null)}
      >
        <MenuItem onClick={handleCreateCodebase}>
          <ListItemIcon>
            <AddIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Add Codebase" />
        </MenuItem>
        <MenuItem onClick={() => setActionAnchorEl(null)}>
          <ListItemIcon>
            <SettingsIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Workspace Settings" />
        </MenuItem>
      </Menu>

      {/* Dialogs */}
      <WorkspaceCreate
        open={showCreateWorkspace}
        onClose={() => setShowCreateWorkspace(false)}
      />

      {currentWorkspace && (
        <CodebaseCreate
          open={showCreateCodebase}
          onClose={() => setShowCreateCodebase(false)}
          onSuccess={refreshCodebases}
          workspaceId={currentWorkspace.id}
        />
      )}
    </Box>
  );
}

export default WorkspaceDashboard;