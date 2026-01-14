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
  TextField,
  InputAdornment,
  Fab,
  Alert,
  Skeleton,
  Paper,
} from '@mui/material';
import {
  Add as AddIcon,
  Search as SearchIcon,
  Code as CodeIcon,
  Analytics as AnalyticsIcon,
  Storage as StorageIcon,
  People as PeopleIcon,
  TrendingUp as TrendingUpIcon,
  Business as BusinessIcon,
  Person as PersonIcon,
  ArrowForward as ArrowForwardIcon,
} from '@mui/icons-material';
import { useRouter } from 'next/router';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useWorkspaceDetails } from '../hooks/useWorkspaces';
import { useCodebases } from '../hooks/useCodebases';
import { WorkspaceCreate } from '../components/workspace/WorkspaceCreate';
import { CodebaseCard } from '../components/codebase/CodebaseCard';
import { CodebaseCreate } from '../components/codebase/CodebaseCreate';
import { formatStorageSize } from '../types/billing.types';
import { Codebase } from '../types/workspace.types';
import { ProtectedRoute } from '../components/auth/ProtectedRoute';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { apiService } from '../services/api';

export function WorkspaceDashboard() {
  const router = useRouter();
  const { currentWorkspace, isLoading: workspaceContextLoading } = useWorkspace();
  const { workspace, stats, isLoading: workspaceLoading } = useWorkspaceDetails(currentWorkspace?.id || null);
  const { codebases, isLoading: codebasesLoading, refreshCodebases } = useCodebases(currentWorkspace?.id || null);

  const [searchTerm, setSearchTerm] = useState('');
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [showCreateCodebase, setShowCreateCodebase] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState<string | null>(null);

  const filteredCodebases = useMemo(() => {
    return codebases.filter(codebase => {
      const matchesSearch = searchTerm === '' ||
        codebase.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (codebase.description && codebase.description.toLowerCase().includes(searchTerm.toLowerCase()));
      return matchesSearch;
    });
  }, [codebases, searchTerm]);

  const handleStartAnalysis = async (codebase: Codebase) => {
    if (!currentWorkspace) return;

    try {
      setAnalysisLoading(codebase.id);
      await apiService.startCodebaseAnalysis(currentWorkspace.id, codebase.id);
      await refreshCodebases();
    } catch (error) {
      console.error('Failed to start analysis:', error);
    } finally {
      setAnalysisLoading(null);
    }
  };

  const handleSelectCodebase = (codebase: Codebase) => {
    if (!currentWorkspace) return;
    router.push(`/workspace/${currentWorkspace.id}?codebase=${codebase.id}`);
  };

  if (workspaceContextLoading) {
    return (
      <ProtectedRoute>
        <DashboardLayout>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: '60vh',
            }}
          >
            <Box textAlign="center">
              <Skeleton variant="rectangular" width={200} height={200} sx={{ mx: 'auto', mb: 3, borderRadius: 2 }} />
              <Skeleton variant="text" width={300} height={40} sx={{ mx: 'auto', mb: 2 }} />
              <Skeleton variant="text" width={400} height={24} sx={{ mx: 'auto' }} />
            </Box>
          </Box>
        </DashboardLayout>
      </ProtectedRoute>
    );
  }

  if (!currentWorkspace) {
    return (
      <ProtectedRoute>
        <DashboardLayout>
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: '60vh',
              textAlign: 'center',
            }}
          >
            <Avatar
              sx={{
                width: 80,
                height: 80,
                bgcolor: 'primary.main',
                mb: 3,
              }}
            >
              <BusinessIcon sx={{ fontSize: 40 }} />
            </Avatar>
            <Typography variant="h4" gutterBottom fontWeight={600}>
              Welcome to Unravl
            </Typography>
            <Typography variant="body1" color="text.secondary" mb={4} maxWidth={500}>
              Create your first workspace to start visualizing and analyzing your codebase architecture
            </Typography>
            <Button
              variant="contained"
              size="large"
              onClick={() => setShowCreateWorkspace(true)}
              startIcon={<AddIcon />}
              sx={{
                px: 4,
                py: 1.5,
                fontSize: '1rem',
              }}
            >
              Create Your First Workspace
            </Button>

            <WorkspaceCreate
              open={showCreateWorkspace}
              onClose={() => setShowCreateWorkspace(false)}
              onSuccess={() => setShowCreateWorkspace(false)}
            />
          </Box>
        </DashboardLayout>
      </ProtectedRoute>
    );
  }

  const actionButtons = (
    <Button
      variant="contained"
      startIcon={<AddIcon />}
      onClick={() => setShowCreateCodebase(true)}
      sx={{ ml: 2 }}
    >
      Add Codebase
    </Button>
  );

  return (
    <ProtectedRoute>
      <DashboardLayout pageTitle="Dashboard" actions={actionButtons}>
        {/* Workspace Header */}
        <Paper
          elevation={0}
          sx={{
            p: 3,
            mb: 4,
            background: 'linear-gradient(135deg, rgba(233, 30, 99, 0.1) 0%, rgba(33, 150, 243, 0.1) 100%)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
          }}
        >
          <Box display="flex" alignItems="center" gap={2}>
            <Avatar
              sx={{
                width: 56,
                height: 56,
                bgcolor: workspace?.ownerType === 'organization' ? 'secondary.main' : 'primary.main',
              }}
            >
              {workspace?.ownerType === 'organization' ? <BusinessIcon /> : <PersonIcon />}
            </Avatar>
            <Box flex={1}>
              <Typography variant="h5" fontWeight={700} gutterBottom>
                {workspace?.name || currentWorkspace.name}
              </Typography>
              {workspace?.description && (
                <Typography variant="body2" color="text.secondary">
                  {workspace.description}
                </Typography>
              )}
            </Box>
            <Chip
              label={workspace?.ownerType || currentWorkspace.ownerType}
              variant="outlined"
              sx={{
                textTransform: 'capitalize',
                borderColor: 'rgba(255, 255, 255, 0.3)',
              }}
            />
          </Box>
        </Paper>

        {/* Stats Grid */}
        <Grid container spacing={3} mb={4}>
          <Grid item xs={12} sm={6} lg={3}>
            <Card
              elevation={0}
              sx={{
                bgcolor: 'rgba(33, 150, 243, 0.1)',
                border: '1px solid rgba(33, 150, 243, 0.3)',
                transition: 'all 0.3s',
                '&:hover': {
                  transform: 'translateY(-4px)',
                  boxShadow: '0 8px 24px rgba(33, 150, 243, 0.3)',
                },
              }}
            >
              <CardContent>
                <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
                  <Avatar sx={{ bgcolor: 'primary.main', width: 48, height: 48 }}>
                    <CodeIcon />
                  </Avatar>
                  <TrendingUpIcon sx={{ color: 'success.main' }} />
                </Box>
                <Typography variant="h3" fontWeight={700} gutterBottom>
                  {workspaceLoading ? <Skeleton width={60} /> : stats?.totalCodebases || 0}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Total Codebases
                </Typography>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} sm={6} lg={3}>
            <Card
              elevation={0}
              sx={{
                bgcolor: 'rgba(76, 175, 80, 0.1)',
                border: '1px solid rgba(76, 175, 80, 0.3)',
                transition: 'all 0.3s',
                '&:hover': {
                  transform: 'translateY(-4px)',
                  boxShadow: '0 8px 24px rgba(76, 175, 80, 0.3)',
                },
              }}
            >
              <CardContent>
                <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
                  <Avatar sx={{ bgcolor: 'success.main', width: 48, height: 48 }}>
                    <AnalyticsIcon />
                  </Avatar>
                  <TrendingUpIcon sx={{ color: 'success.main' }} />
                </Box>
                <Typography variant="h3" fontWeight={700} gutterBottom>
                  {workspaceLoading ? <Skeleton width={60} /> : '0'}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Analyses This Month
                </Typography>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} sm={6} lg={3}>
            <Card
              elevation={0}
              sx={{
                bgcolor: 'rgba(255, 152, 0, 0.1)',
                border: '1px solid rgba(255, 152, 0, 0.3)',
                transition: 'all 0.3s',
                '&:hover': {
                  transform: 'translateY(-4px)',
                  boxShadow: '0 8px 24px rgba(255, 152, 0, 0.3)',
                },
              }}
            >
              <CardContent>
                <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
                  <Avatar sx={{ bgcolor: 'warning.main', width: 48, height: 48 }}>
                    <StorageIcon />
                  </Avatar>
                  <Typography variant="caption" color="success.main" fontWeight={600}>
                    12% used
                  </Typography>
                </Box>
                <Typography variant="h3" fontWeight={700} gutterBottom>
                  {workspaceLoading ? <Skeleton width={80} /> : formatStorageSize(0)}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Storage Used
                </Typography>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} sm={6} lg={3}>
            <Card
              elevation={0}
              sx={{
                bgcolor: 'rgba(233, 30, 99, 0.1)',
                border: '1px solid rgba(233, 30, 99, 0.3)',
                transition: 'all 0.3s',
                '&:hover': {
                  transform: 'translateY(-4px)',
                  boxShadow: '0 8px 24px rgba(233, 30, 99, 0.3)',
                },
              }}
            >
              <CardContent>
                <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
                  <Avatar sx={{ bgcolor: 'primary.main', width: 48, height: 48 }}>
                    <PeopleIcon />
                  </Avatar>
                  <Chip
                    label="+2"
                    size="small"
                    sx={{
                      bgcolor: 'success.main',
                      color: '#fff',
                      fontWeight: 600,
                    }}
                  />
                </Box>
                <Typography variant="h3" fontWeight={700} gutterBottom>
                  {workspaceLoading ? <Skeleton width={60} /> : '1'}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Team Members
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        </Grid>

        {/* Quick Actions */}
        {codebases.length === 0 && !codebasesLoading && (
          <Alert
            severity="info"
            sx={{
              mb: 4,
              bgcolor: 'rgba(33, 150, 243, 0.1)',
              border: '1px solid rgba(33, 150, 243, 0.3)',
            }}
            action={
              <Button
                color="inherit"
                size="small"
                onClick={() => setShowCreateCodebase(true)}
                endIcon={<ArrowForwardIcon />}
              >
                Get Started
              </Button>
            }
          >
            <Typography variant="body2" fontWeight={600}>
              No codebases yet. Add your first codebase to start analyzing your architecture.
            </Typography>
          </Alert>
        )}

        {/* Search Bar */}
        {codebases.length > 0 && (
          <Box mb={3}>
            <TextField
              fullWidth
              placeholder="Search codebases by name or description..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ color: 'rgba(255, 255, 255, 0.5)' }} />
                  </InputAdornment>
                ),
              }}
              sx={{
                '& .MuiOutlinedInput-root': {
                  bgcolor: 'rgba(255, 255, 255, 0.05)',
                  '&:hover': {
                    bgcolor: 'rgba(255, 255, 255, 0.08)',
                  },
                  '&.Mui-focused': {
                    bgcolor: 'rgba(255, 255, 255, 0.1)',
                  },
                },
              }}
            />
          </Box>
        )}

        {/* Codebases Section */}
        <Box mb={2}>
          <Typography variant="h6" fontWeight={600} gutterBottom>
            Codebases
            {filteredCodebases.length > 0 && (
              <Chip
                label={filteredCodebases.length}
                size="small"
                sx={{ ml: 2, bgcolor: 'primary.main', color: '#fff' }}
              />
            )}
          </Typography>
        </Box>

        {codebasesLoading ? (
          <Grid container spacing={3}>
            {[...Array(6)].map((_, index) => (
              <Grid item xs={12} sm={6} lg={4} key={index}>
                <Card elevation={0}>
                  <CardContent>
                    <Skeleton variant="rectangular" height={180} sx={{ mb: 2 }} />
                    <Skeleton variant="text" width="80%" />
                    <Skeleton variant="text" width="60%" />
                  </CardContent>
                </Card>
              </Grid>
            ))}
          </Grid>
        ) : filteredCodebases.length === 0 ? (
          <Box
            sx={{
              textAlign: 'center',
              py: 8,
              bgcolor: 'rgba(255, 255, 255, 0.02)',
              borderRadius: 2,
              border: '1px dashed rgba(255, 255, 255, 0.2)',
            }}
          >
            {codebases.length === 0 ? (
              <>
                <Avatar
                  sx={{
                    width: 64,
                    height: 64,
                    bgcolor: 'primary.main',
                    mx: 'auto',
                    mb: 2,
                  }}
                >
                  <CodeIcon sx={{ fontSize: 32 }} />
                </Avatar>
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
                <SearchIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 2 }} />
                <Typography variant="h6" gutterBottom>
                  No codebases match your search
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Try adjusting your search terms
                </Typography>
              </>
            )}
          </Box>
        ) : (
          <Grid container spacing={3}>
            {filteredCodebases.map((codebase) => (
              <Grid item xs={12} sm={6} lg={4} key={codebase.id}>
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
            sx={{
              position: 'fixed',
              bottom: 32,
              right: 32,
              boxShadow: '0 8px 32px rgba(33, 150, 243, 0.4)',
              '&:hover': {
                transform: 'scale(1.1)',
                boxShadow: '0 12px 48px rgba(33, 150, 243, 0.6)',
              },
            }}
            onClick={() => setShowCreateCodebase(true)}
          >
            <AddIcon />
          </Fab>
        )}

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
      </DashboardLayout>
    </ProtectedRoute>
  );
}

export default WorkspaceDashboard;
