import React, { useState } from 'react';
import {
  Box,
  Container,
  Typography,
  Card,
  CardContent,
  CardActions,
  Button,
  Grid,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  LinearProgress,
  Alert,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Divider
} from '@mui/material';
import { Add, Code, Visibility, Settings, CheckCircle, RadioButtonUnchecked, Error as ErrorIcon } from '@mui/icons-material';
import Link from 'next/link';
import { useRouter } from 'next/router';
import axios from 'axios';

interface Project {
  id: string;
  name: string;
  description: string;
  language: string;
  framework: string;
  status: 'analyzing' | 'ready' | 'error';
  components: number;
  lastAnalyzed: Date;
  repositoryUrl?: string;
}

const ProjectsPage: React.FC = () => {
  const router = useRouter();
  const [projects] = useState<Project[]>([
    {
      id: 'unravl-platform',
      name: 'Unravl Platform',
      description: 'Interactive Architecture Visualization Platform - the current codebase',
      language: 'TypeScript',
      framework: 'Next.js + Express',
      status: 'ready',
      components: 12,
      lastAnalyzed: new Date('2024-01-20'),
      repositoryUrl: '/Users/michaelshattuck/dev/unravl/proof-of-concept'
    },
    {
      id: 'sample-project',
      name: 'Sample Microservice',
      description: 'Demo microservice architecture with authentication and user management',
      language: 'TypeScript',
      framework: 'Express.js',
      status: 'ready',
      components: 6,
      lastAnalyzed: new Date('2024-01-18')
    },
    {
      id: 'legacy-monolith',
      name: 'Legacy E-commerce System',
      description: 'Large monolithic application being decomposed',
      language: 'Java',
      framework: 'Spring Boot',
      status: 'analyzing',
      components: 45,
      lastAnalyzed: new Date('2024-01-15')
    }
  ]);

  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [newProject, setNewProject] = useState({
    name: '',
    repositoryPath: '',
    repositoryUrl: '',
    description: ''
  });

  // Analysis state
  const [analysisInProgress, setAnalysisInProgress] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisProgress, setAnalysisProgress] = useState<{
    analyzersRun: Array<{
      name: string;
      status: 'pending' | 'running' | 'fulfilled' | 'rejected';
      description?: string;
    }>;
  }>({ analyzersRun: [] });

  const getStatusColor = (status: Project['status']) => {
    switch (status) {
      case 'ready': return 'success';
      case 'analyzing': return 'warning';
      case 'error': return 'error';
      default: return 'default';
    }
  };

  const handleAddProject = () => {
    // In a real app, this would trigger the analyzer
    console.log('Adding project:', newProject);
    setAddProjectOpen(false);
    setNewProject({ name: '', repositoryPath: '', repositoryUrl: '', description: '' });
  };

  const handleAnalyzeUnravl = async () => {
    setAnalysisInProgress(true);
    setAnalysisError(null);
    setAnalysisProgress({
      analyzersRun: [
        { name: 'SystemTopologyAnalyzer', status: 'pending', description: 'Analyzing system components and architecture' },
        { name: 'FrameworkDetector', status: 'pending', description: 'Detecting frameworks and technology stack' },
        { name: 'DependencyMapper', status: 'pending', description: 'Mapping dependency relationships' },
        { name: 'EntryExitDetector', status: 'pending', description: 'Finding entry and exit points' }
      ]
    });

    try {
      // Simulate analyzer progress updates
      const updateProgress = (analyzerName: string, status: 'running' | 'fulfilled' | 'rejected') => {
        setAnalysisProgress(prev => ({
          analyzersRun: prev.analyzersRun.map(analyzer => 
            analyzer.name === analyzerName ? { ...analyzer, status } : analyzer
          )
        }));
      };

      // Start first analyzer
      updateProgress('SystemTopologyAnalyzer', 'running');
      
      const response = await axios.post('http://localhost:3001/api/analyzer/analyze', {
        repositoryPath: '/Users/michaelshattuck/dev/unravl/proof-of-concept',
        projectName: 'Unravl Platform'
      }, {
        timeout: 120000 // 2 minute timeout
      });

      if (response.data.success) {
        // Update progress based on actual analyzer results
        response.data.analyzersRun.forEach((analyzer: any) => {
          updateProgress(analyzer.name, analyzer.status);
        });

        // Store the analysis result in localStorage for the visualization page
        localStorage.setItem('unravl-analysis-result', JSON.stringify(response.data.blueprint));
        
        // Redirect to visualization with analysis ID
        router.push(`/visualization?projectId=unravl-platform&analysisId=${response.data.analysisId}`);
      } else {
        throw new Error('Analysis failed: ' + (response.data.message || 'Unknown error'));
      }
    } catch (error) {
      console.error('Analysis failed:', error);
      setAnalysisError(
        error instanceof Error 
          ? error.message 
          : 'Failed to analyze codebase. Please ensure the backend is running.'
      );
      
      // Mark all analyzers as failed
      setAnalysisProgress(prev => ({
        analyzersRun: prev.analyzersRun.map(analyzer => ({ ...analyzer, status: 'rejected' }))
      }));
    } finally {
      setAnalysisInProgress(false);
    }
  };

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      <Box sx={{ mb: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Box>
          <Typography variant="h3" component="h1" gutterBottom>
            🗂️ Projects
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Manage and visualize your codebase architectures
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<Add />}
          onClick={() => setAddProjectOpen(true)}
        >
          Add Project
        </Button>
      </Box>

      <Grid container spacing={3}>
        {projects.map((project) => (
          <Grid item xs={12} md={6} lg={4} key={project.id}>
            <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
              <CardContent sx={{ flex: 1 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
                  <Typography variant="h6" component="h2" gutterBottom>
                    {project.name}
                  </Typography>
                  <Chip
                    label={project.status}
                    color={getStatusColor(project.status)}
                    size="small"
                  />
                </Box>
                
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  {project.description}
                </Typography>

                <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
                  <Chip label={project.language} variant="outlined" size="small" />
                  <Chip label={project.framework} variant="outlined" size="small" />
                </Box>

                <Typography variant="body2" color="text.secondary">
                  <strong>{project.components}</strong> components analyzed
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Last analyzed: {project.lastAnalyzed.toLocaleDateString()}
                </Typography>
              </CardContent>
              
              <CardActions>
                {project.id === 'unravl-platform' ? (
                  <Button
                    size="small"
                    startIcon={<Code />}
                    onClick={handleAnalyzeUnravl}
                    variant="contained"
                    disabled={analysisInProgress}
                  >
                    {analysisInProgress ? 'Analyzing...' : 'Analyze Current Codebase'}
                  </Button>
                ) : (
                  <Link href={`/visualization?projectId=${project.id}`} passHref>
                    <Button size="small" startIcon={<Visibility />}>
                      View Architecture
                    </Button>
                  </Link>
                )}
                <Button size="small" startIcon={<Settings />}>
                  Settings
                </Button>
              </CardActions>
            </Card>
          </Grid>
        ))}
      </Grid>

      {/* Add Project Dialog */}
      <Dialog open={addProjectOpen} onClose={() => setAddProjectOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add New Project</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
            <TextField
              label="Project Name"
              value={newProject.name}
              onChange={(e) => setNewProject(prev => ({ ...prev, name: e.target.value }))}
              fullWidth
            />
            <TextField
              label="Repository Path"
              value={newProject.repositoryPath}
              onChange={(e) => setNewProject(prev => ({ ...prev, repositoryPath: e.target.value }))}
              placeholder="/path/to/your/project"
              fullWidth
            />
            <TextField
              label="Repository URL (optional)"
              value={newProject.repositoryUrl}
              onChange={(e) => setNewProject(prev => ({ ...prev, repositoryUrl: e.target.value }))}
              placeholder="https://github.com/user/repo"
              fullWidth
            />
            <TextField
              label="Description"
              value={newProject.description}
              onChange={(e) => setNewProject(prev => ({ ...prev, description: e.target.value }))}
              multiline
              rows={3}
              fullWidth
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddProjectOpen(false)}>Cancel</Button>
          <Button 
            onClick={handleAddProject} 
            variant="contained"
            disabled={!newProject.name || !newProject.repositoryPath}
          >
            Analyze Project
          </Button>
        </DialogActions>
      </Dialog>

      {/* Analysis Progress Dialog */}
      <Dialog 
        open={analysisInProgress || analysisError !== null} 
        maxWidth="md" 
        fullWidth
        onClose={() => {}} // Prevent closing during analysis
        PaperProps={{
          sx: { minHeight: 400 }
        }}
      >
        <DialogTitle>
          {analysisInProgress ? 'Analyzing Unravl Codebase...' : 'Analysis Complete'}
        </DialogTitle>
        <DialogContent>
          {analysisError ? (
            <Alert severity="error" sx={{ mb: 2 }}>
              <Typography variant="h6" gutterBottom>
                Analysis Failed
              </Typography>
              {analysisError}
            </Alert>
          ) : (
            <Box sx={{ mb: 2 }}>
              <Typography variant="body1" gutterBottom>
                Running sophisticated analyzers on the Unravl codebase at:
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3, fontFamily: 'monospace' }}>
                /Users/michaelshattuck/dev/unravl/proof-of-concept
              </Typography>
              
              {analysisInProgress && (
                <LinearProgress sx={{ mb: 3 }} />
              )}
            </Box>
          )}

          <List>
            {analysisProgress.analyzersRun.map((analyzer, index) => (
              <React.Fragment key={analyzer.name}>
                <ListItem>
                  <ListItemIcon>
                    {analyzer.status === 'pending' ? (
                      <RadioButtonUnchecked color="action" />
                    ) : analyzer.status === 'running' ? (
                      <RadioButtonUnchecked color="primary" />
                    ) : analyzer.status === 'fulfilled' ? (
                      <CheckCircle color="success" />
                    ) : (
                      <ErrorIcon color="error" />
                    )}
                  </ListItemIcon>
                  <ListItemText
                    primary={analyzer.name}
                    secondary={analyzer.description}
                    primaryTypographyProps={{
                      color: analyzer.status === 'running' ? 'primary' : 'inherit'
                    }}
                  />
                </ListItem>
                {index < analysisProgress.analyzersRun.length - 1 && <Divider />}
              </React.Fragment>
            ))}
          </List>
        </DialogContent>
        <DialogActions>
          {analysisError && (
            <>
              <Button onClick={() => setAnalysisError(null)} color="primary">
                Close
              </Button>
              <Button onClick={handleAnalyzeUnravl} variant="contained">
                Retry Analysis
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>
    </Container>
  );
};

export default ProjectsPage;