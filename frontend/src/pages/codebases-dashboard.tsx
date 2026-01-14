import React, { useState, useMemo } from 'react';
import {
  Box,
  Typography,
  Button,
  Grid,
  Card,
  CardContent,
  TextField,
  InputAdornment,
  Chip,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Fab,
  Alert,
  Skeleton,
  FormControl,
  InputLabel,
  Select,
  ToggleButton,
  ToggleButtonGroup,
  Breadcrumbs,
  Link,
} from '@mui/material';
import {
  Add as AddIcon,
  Search as SearchIcon,
  FilterList as FilterIcon,
  GridView as GridViewIcon,
  ViewList as ListViewIcon,
  Sort as SortIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Schedule as ScheduleIcon,
  PlayArrow as PlayArrowIcon,
  Refresh as RefreshIcon,
  ChevronRight as ChevronRightIcon,
  Home as HomeIcon,
} from '@mui/icons-material';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useCodebases } from '../hooks/useCodebases';
import { CodebaseCard } from '../components/codebase/CodebaseCard';
import { CodebaseCreate } from '../components/codebase/CodebaseCreate';
import { WorkspaceSelector } from '../components/workspace/WorkspaceSelector';
import { Codebase, AnalysisStatus } from '../types/workspace.types';

type ViewMode = 'grid' | 'list';
type SortField = 'name' | 'last_analysis' | 'created_at' | 'file_count' | 'size';
type SortOrder = 'asc' | 'desc';

interface CodebaseFilter {
  search: string;
  status: AnalysisStatus[];
  tags: string[];
  sortField: SortField;
  sortOrder: SortOrder;
}

export function CodebasesDashboard() {
  const { currentWorkspace } = useWorkspace();
  const { codebases, isLoading, refreshCodebases } = useCodebases(currentWorkspace?.id || null);

  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [showCreateCodebase, setShowCreateCodebase] = useState(false);
  const [filterAnchorEl, setFilterAnchorEl] = useState<null | HTMLElement>(null);
  const [sortAnchorEl, setSortAnchorEl] = useState<null | HTMLElement>(null);

  const [filter, setFilter] = useState<CodebaseFilter>({
    search: '',
    status: [],
    tags: [],
    sortField: 'name',
    sortOrder: 'asc',
  });

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    codebases.forEach(codebase => {
      if (codebase.tags && Array.isArray(codebase.tags)) {
        codebase.tags.forEach(tag => tags.add(tag));
      }
    });
    return Array.from(tags).sort();
  }, [codebases]);

  const statusCounts = useMemo(() => {
    const counts: Record<AnalysisStatus, number> = {
      pending: 0,
      running: 0,
      analyzing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    codebases.forEach(codebase => {
      // For now, mock the analysis status since it's not in the Codebase interface
      const status = 'completed' as AnalysisStatus; // TODO: Get actual analysis status
      counts[status]++;
    });

    return counts;
  }, [codebases]);

  const filteredAndSortedCodebases = useMemo(() => {
    let filtered = codebases.filter(codebase => {
      const matchesSearch = filter.search === '' ||
        codebase.name.toLowerCase().includes(filter.search.toLowerCase()) ||
        (codebase.description && codebase.description.toLowerCase().includes(filter.search.toLowerCase()));

      const matchesStatus = filter.status.length === 0 ||
        filter.status.includes('completed'); // TODO: Use actual analysis status

      const matchesTags = filter.tags.length === 0 ||
        (codebase.tags && codebase.tags.length > 0 && filter.tags.some(tag => codebase.tags!.includes(tag)));

      return matchesSearch && matchesStatus && matchesTags;
    });

    // Sort
    filtered.sort((a, b) => {
      let aValue: any, bValue: any;

      switch (filter.sortField) {
        case 'name':
          aValue = a.name.toLowerCase();
          bValue = b.name.toLowerCase();
          break;
        case 'last_analysis':
          aValue = a.lastAnalyzedAt || '';
          bValue = b.lastAnalyzedAt || '';
          break;
        case 'created_at':
          aValue = a.createdAt;
          bValue = b.createdAt;
          break;
        case 'file_count':
          aValue = a.fileCount || 0;
          bValue = b.fileCount || 0;
          break;
        case 'size':
          aValue = a.sizeBytes || 0;
          bValue = b.sizeBytes || 0;
          break;
        default:
          return 0;
      }

      if (aValue < bValue) return filter.sortOrder === 'asc' ? -1 : 1;
      if (aValue > bValue) return filter.sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    return filtered;
  }, [codebases, filter]);

  const handleFilterChange = (field: keyof CodebaseFilter, value: any) => {
    setFilter(prev => ({ ...prev, [field]: value }));
  };

  const handleStatusFilter = (status: AnalysisStatus) => {
    const newStatus = filter.status.includes(status)
      ? filter.status.filter(s => s !== status)
      : [...filter.status, status];
    handleFilterChange('status', newStatus);
  };

  const handleTagFilter = (tag: string) => {
    const newTags = filter.tags.includes(tag)
      ? filter.tags.filter(t => t !== tag)
      : [...filter.tags, tag];
    handleFilterChange('tags', newTags);
  };

  const handleSortChange = (field: SortField, order: SortOrder) => {
    setFilter(prev => ({ ...prev, sortField: field, sortOrder: order }));
    setSortAnchorEl(null);
  };

  const handleStartAnalysis = async (codebase: Codebase) => {
    // This would integrate with the analysis system
    console.log('Starting analysis for:', codebase.name);
  };

  const handleSelectCodebase = (codebase: Codebase) => {
    // Navigate to codebase analysis view
    window.location.href = `/workspace/${currentWorkspace?.id}/codebase/${codebase.id}`;
  };

  const clearFilters = () => {
    setFilter({
      search: '',
      status: [],
      tags: [],
      sortField: 'name',
      sortOrder: 'asc',
    });
  };

  const activeFilterCount = filter.status.length + filter.tags.length + (filter.search ? 1 : 0);

  if (!currentWorkspace) {
    return (
      <Box p={4} textAlign="center">
        <Typography variant="h5" gutterBottom>
          No Workspace Selected
        </Typography>
        <Typography variant="body1" color="text.secondary" mb={3}>
          Please select a workspace to view codebases
        </Typography>
        <WorkspaceSelector variant="detailed" />
      </Box>
    );
  }

  return (
    <Box p={3}>
      {/* Breadcrumbs */}
      <Breadcrumbs separator={<ChevronRightIcon fontSize="small" />} sx={{ mb: 2 }}>
        <Link
          color="inherit"
          href="/"
          sx={{ display: 'flex', alignItems: 'center' }}
        >
          <HomeIcon sx={{ mr: 0.5 }} fontSize="inherit" />
          Dashboard
        </Link>
        <Typography color="text.primary">
          {currentWorkspace.name}
        </Typography>
        <Typography color="text.primary">
          Codebases
        </Typography>
      </Breadcrumbs>

      {/* Header */}
      <Box display="flex" alignItems="center" justifyContent="space-between" mb={3}>
        <Box>
          <Typography variant="h4" fontWeight="bold" gutterBottom>
            Codebases
          </Typography>
          <Typography variant="body1" color="text.secondary">
            {codebases.length} codebases in {currentWorkspace.name}
          </Typography>
        </Box>

        <Box display="flex" gap={1}>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={refreshCodebases}
            disabled={isLoading}
          >
            Refresh
          </Button>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setShowCreateCodebase(true)}
          >
            Add Codebase
          </Button>
        </Box>
      </Box>

      {/* Status Overview */}
      <Grid container spacing={2} mb={3}>
        <Grid item xs={6} sm={3} md={2}>
          <Card
            sx={{
              cursor: 'pointer',
              bgcolor: filter.status.includes('completed') ? 'success.light' : 'background.paper',
              '&:hover': { bgcolor: 'action.hover' },
            }}
            onClick={() => handleStatusFilter('completed')}
          >
            <CardContent sx={{ textAlign: 'center', py: 2 }}>
              <CheckCircleIcon color="success" sx={{ mb: 1 }} />
              <Typography variant="h6" fontWeight="bold">
                {statusCounts.completed}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Completed
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={6} sm={3} md={2}>
          <Card
            sx={{
              cursor: 'pointer',
              bgcolor: filter.status.includes('analyzing') ? 'info.light' : 'background.paper',
              '&:hover': { bgcolor: 'action.hover' },
            }}
            onClick={() => handleStatusFilter('analyzing')}
          >
            <CardContent sx={{ textAlign: 'center', py: 2 }}>
              <PlayArrowIcon color="info" sx={{ mb: 1 }} />
              <Typography variant="h6" fontWeight="bold">
                {statusCounts.analyzing}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Analyzing
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={6} sm={3} md={2}>
          <Card
            sx={{
              cursor: 'pointer',
              bgcolor: filter.status.includes('pending') ? 'warning.light' : 'background.paper',
              '&:hover': { bgcolor: 'action.hover' },
            }}
            onClick={() => handleStatusFilter('pending')}
          >
            <CardContent sx={{ textAlign: 'center', py: 2 }}>
              <ScheduleIcon color="warning" sx={{ mb: 1 }} />
              <Typography variant="h6" fontWeight="bold">
                {statusCounts.pending}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Pending
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={6} sm={3} md={2}>
          <Card
            sx={{
              cursor: 'pointer',
              bgcolor: filter.status.includes('failed') ? 'error.light' : 'background.paper',
              '&:hover': { bgcolor: 'action.hover' },
            }}
            onClick={() => handleStatusFilter('failed')}
          >
            <CardContent sx={{ textAlign: 'center', py: 2 }}>
              <ErrorIcon color="error" sx={{ mb: 1 }} />
              <Typography variant="h6" fontWeight="bold">
                {statusCounts.failed}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Failed
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Search and Controls */}
      <Box display="flex" gap={2} mb={3} alignItems="center" flexWrap="wrap">
        <TextField
          placeholder="Search codebases..."
          value={filter.search}
          onChange={(e) => handleFilterChange('search', e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon />
              </InputAdornment>
            ),
          }}
          sx={{ flexGrow: 1, minWidth: 200 }}
        />

        <Button
          variant="outlined"
          startIcon={<FilterIcon />}
          onClick={(e) => setFilterAnchorEl(e.currentTarget)}
          color={activeFilterCount > 0 ? 'primary' : 'inherit'}
        >
          Filter {activeFilterCount > 0 && `(${activeFilterCount})`}
        </Button>

        <Button
          variant="outlined"
          startIcon={<SortIcon />}
          onClick={(e) => setSortAnchorEl(e.currentTarget)}
        >
          Sort
        </Button>

        <ToggleButtonGroup
          value={viewMode}
          exclusive
          onChange={(_, value) => value && setViewMode(value)}
          size="small"
        >
          <ToggleButton value="grid">
            <GridViewIcon />
          </ToggleButton>
          <ToggleButton value="list">
            <ListViewIcon />
          </ToggleButton>
        </ToggleButtonGroup>

        {activeFilterCount > 0 && (
          <Button
            variant="text"
            onClick={clearFilters}
            size="small"
          >
            Clear Filters
          </Button>
        )}
      </Box>

      {/* Active Filters */}
      {(filter.status.length > 0 || filter.tags.length > 0) && (
        <Box display="flex" flexWrap="wrap" gap={1} mb={2}>
          {filter.status.map(status => (
            <Chip
              key={status}
              label={`Status: ${status}`}
              onDelete={() => handleStatusFilter(status)}
              size="small"
              color="primary"
              variant="outlined"
            />
          ))}
          {filter.tags.map(tag => (
            <Chip
              key={tag}
              label={`Tag: ${tag}`}
              onDelete={() => handleTagFilter(tag)}
              size="small"
              color="secondary"
              variant="outlined"
            />
          ))}
        </Box>
      )}

      {/* Codebases */}
      {isLoading ? (
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
      ) : filteredAndSortedCodebases.length === 0 ? (
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
                onClick={() => setShowCreateCodebase(true)}
                startIcon={<AddIcon />}
              >
                Add First Codebase
              </Button>
            </>
          ) : (
            <>
              <Typography variant="h6" gutterBottom>
                No codebases match your filters
              </Typography>
              <Typography variant="body2" color="text.secondary" mb={2}>
                Try adjusting your search terms or filters
              </Typography>
              <Button variant="outlined" onClick={clearFilters}>
                Clear All Filters
              </Button>
            </>
          )}
        </Box>
      ) : viewMode === 'grid' ? (
        <Grid container spacing={3}>
          {filteredAndSortedCodebases.map((codebase) => (
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
      ) : (
        <Box display="flex" flexDirection="column" gap={2}>
          {filteredAndSortedCodebases.map((codebase) => (
            <CodebaseCard
              key={codebase.id}
              codebase={codebase}
              variant="compact"
              onSelect={handleSelectCodebase}
              onStartAnalysis={handleStartAnalysis}
            />
          ))}
        </Box>
      )}

      {/* Floating Action Button */}
      <Fab
        color="primary"
        sx={{ position: 'fixed', bottom: 24, right: 24 }}
        onClick={() => setShowCreateCodebase(true)}
      >
        <AddIcon />
      </Fab>

      {/* Filter Menu */}
      <Menu
        anchorEl={filterAnchorEl}
        open={Boolean(filterAnchorEl)}
        onClose={() => setFilterAnchorEl(null)}
        PaperProps={{ sx: { width: 250 } }}
      >
        <Box p={2}>
          <Typography variant="subtitle2" gutterBottom>
            Filter by Tags
          </Typography>
          <Box display="flex" flexWrap="wrap" gap={0.5}>
            {allTags.map(tag => (
              <Chip
                key={tag}
                label={tag}
                size="small"
                clickable
                color={filter.tags.includes(tag) ? 'primary' : 'default'}
                onClick={() => handleTagFilter(tag)}
              />
            ))}
          </Box>
        </Box>
      </Menu>

      {/* Sort Menu */}
      <Menu
        anchorEl={sortAnchorEl}
        open={Boolean(sortAnchorEl)}
        onClose={() => setSortAnchorEl(null)}
      >
        <MenuItem onClick={() => handleSortChange('name', 'asc')}>
          <ListItemText primary="Name (A-Z)" />
        </MenuItem>
        <MenuItem onClick={() => handleSortChange('name', 'desc')}>
          <ListItemText primary="Name (Z-A)" />
        </MenuItem>
        <MenuItem onClick={() => handleSortChange('last_analysis', 'desc')}>
          <ListItemText primary="Recently Analyzed" />
        </MenuItem>
        <MenuItem onClick={() => handleSortChange('created_at', 'desc')}>
          <ListItemText primary="Recently Added" />
        </MenuItem>
        <MenuItem onClick={() => handleSortChange('file_count', 'desc')}>
          <ListItemText primary="Most Files" />
        </MenuItem>
        <MenuItem onClick={() => handleSortChange('size', 'desc')}>
          <ListItemText primary="Largest Size" />
        </MenuItem>
      </Menu>

      {/* Create Codebase Dialog */}
      <CodebaseCreate
        open={showCreateCodebase}
        onClose={() => setShowCreateCodebase(false)}
        onSuccess={refreshCodebases}
        workspaceId={currentWorkspace.id}
      />
    </Box>
  );
}

export default CodebasesDashboard;