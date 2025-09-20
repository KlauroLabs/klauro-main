import React, { useState, useEffect } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Grid,
  Chip,
  Button,
  CircularProgress,
  AppBar,
  Toolbar,
  Drawer,
  List,
  ListItem,
  ListItemText,
  ListItemButton,
  ListItemIcon,
  Divider,
  IconButton,
  useTheme,
  useMediaQuery,
  Paper,
  Stack,
  Fade,
  Zoom,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  CardMedia,
  Container,
  Breadcrumbs,
  Link
} from '@mui/material';
import {
  Menu as MenuIcon,
  Dashboard,
  Code,
  Storage,
  Settings,
  Analytics,
  Folder,
  Architecture,
  Hub,
  Api,
  ChevronRight,
  ViewModule,
  Category,
  DataObject,
  Functions,
  Class,
  IntegrationInstructions,
  AccountTree,
  Layers,
  Assessment,
  Launch,
  Info,
  Build,
  Speed,
  Storage as StorageIcon,
  Cloud
} from '@mui/icons-material';
import { useRouter } from 'next/router';
import InteractiveArchitectureDiagram from '../../components/InteractiveArchitectureDiagram';
import { AnalysisInfoPanel } from '../../components/AnalysisInfoPanel';
import { CASOutput } from '../../types/cas.types';

const DRAWER_WIDTH = 280;

interface Project {
  id: string;
  name: string;
  repository: string;
  lastAnalyzed: string;
  status: 'active' | 'pending' | 'error';
  components?: number;
  connections?: number;
  language?: string;
}

export default function ProjectsPage() {
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const router = useRouter();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  // Dynamically generate color from string hash
  const getColorFromString = (str: string) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = hash % 360;
    return `hsl(${hue}, 70%, 50%)`;
  };

  const [projects, setProjects] = useState<Project[]>([
    {
      id: 'backend',
      name: 'Unravl Backend',
      repository: 'github.com/unravl/backend',
      lastAnalyzed: '2 hours ago',
      status: 'active',
      components: 124,
      connections: 487,
      language: 'TypeScript'
    },
    {
      id: 'frontend',
      name: 'Unravl Frontend',
      repository: 'github.com/unravl/frontend',
      lastAnalyzed: '1 day ago',
      status: 'active',
      components: 89,
      connections: 234,
      language: 'React/TypeScript'
    },
    {
      id: 'analyzer',
      name: 'Code Analyzer',
      repository: 'github.com/unravl/analyzer',
      lastAnalyzed: '3 days ago',
      status: 'pending',
      components: 45,
      connections: 123,
      language: 'Python'
    },
    {
      id: 'docs',
      name: 'Documentation Site',
      repository: 'github.com/unravl/docs',
      lastAnalyzed: '1 week ago',
      status: 'active',
      components: 34,
      connections: 89,
      language: 'MDX'
    },
  ]);

  const [projectData, setProjectData] = useState<CASOutput | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [infoPanelOpen, setInfoPanelOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'overview' | 'perspective'>('overview');
  const [selectedPerspectiveGroup, setSelectedPerspectiveGroup] = useState<string | null>(null);
  const [selectedPerspective, setSelectedPerspective] = useState<string>('all');
  const [activeAnalyzers, setActiveAnalyzers] = useState<string[]>([]);

  useEffect(() => {
    const { projectId } = router.query;
    if (projectId && typeof projectId === 'string') {
      const project = projects.find(p => p.id === projectId);
      if (project && !selectedProject) {
        setSelectedProject(project);
        fetchProjectData(project.id);
      }
    }
  }, [router.query]);

  const fetchProjectData = async (projectId: string) => {
    setLoading(true);
    try {
      // Use the real backend CAS analysis endpoint
      const response = await fetch('http://localhost:3001/api/analyze/cas', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectPath: projectId === 'backend' ?
            '/Users/michaelshattuck/dev/unravl/proof-of-concept/backend' :
            '/Users/michaelshattuck/dev/unravl/proof-of-concept/frontend'
        })
      });

      if (response.ok) {
        const casData: CASOutput = await response.json();
        console.log('CAS Data loaded:', casData);
        console.log('Nodes count:', casData.nodes?.length || 0);
        setProjectData(casData);
        // Initialize only analyzers that created nodes as active
        setActiveAnalyzers(
          casData.analyzer_contributions
            ?.filter(c => c.nodes_created > 0)
            ?.map(c => c.analyzer_id) || []
        );
        setInfoPanelOpen(true);
      } else {
        console.error('CAS analysis failed:', response.statusText);
        setProjectData(null);
      }
    } catch (error) {
      console.error('Error fetching CAS analysis:', error);
      setProjectData(null);
    } finally {
      setLoading(false);
    }
  };

  const handleDrawerToggle = () => {
    setMobileOpen(!mobileOpen);
  };

  const handleProjectClick = (project: Project) => {
    setSelectedProject(project);
    router.push(`/projects?projectId=${project.id}`);
    fetchProjectData(project.id);
    if (isMobile) {
      setMobileOpen(false);
    }
  };

  const getStatusColor = (status: Project['status']) => {
    switch (status) {
      case 'active': return 'success';
      case 'pending': return 'warning';
      case 'error': return 'error';
      default: return 'default';
    }
  };

  const drawer = (
    <Box>
      <Toolbar sx={{ bgcolor: 'primary.main', color: 'white' }}>
        <Architecture sx={{ mr: 2 }} />
        <Typography variant="h6" fontWeight={700}>
          Unravl
        </Typography>
      </Toolbar>
      <Divider />

      <List sx={{ p: 2 }}>
        <Typography variant="overline" color="text.secondary" sx={{ px: 2, display: 'block', mb: 1 }}>
          Navigation
        </Typography>
        <ListItemButton selected>
          <ListItemIcon><Dashboard /></ListItemIcon>
          <ListItemText primary="Projects" />
        </ListItemButton>
        <ListItemButton>
          <ListItemIcon><Analytics /></ListItemIcon>
          <ListItemText primary="Analytics" />
        </ListItemButton>
        <ListItemButton>
          <ListItemIcon><Code /></ListItemIcon>
          <ListItemText primary="Code Explorer" />
        </ListItemButton>
        <ListItemButton>
          <ListItemIcon><Storage /></ListItemIcon>
          <ListItemText primary="Telemetry" />
        </ListItemButton>
      </List>

      <Divider />

      <List sx={{ p: 2 }}>
        <Typography variant="overline" color="text.secondary" sx={{ px: 2, display: 'block', mb: 1 }}>
          Projects ({projects.length})
        </Typography>
        {projects.map((project) => (
          <ListItemButton
            key={project.id}
            selected={selectedProject?.id === project.id}
            onClick={() => handleProjectClick(project)}
            sx={{
              borderRadius: 1,
              mb: 1,
              '&.Mui-selected': {
                bgcolor: 'action.selected',
                '&:hover': {
                  bgcolor: 'action.selected',
                }
              }
            }}
          >
            <ListItemIcon>
              <Folder color={selectedProject?.id === project.id ? 'primary' : 'inherit'} />
            </ListItemIcon>
            <ListItemText
              primary={project.name}
              secondary={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Chip
                    label={project.status}
                    size="small"
                    color={getStatusColor(project.status)}
                    sx={{ height: 16, fontSize: '0.65rem' }}
                  />
                  <Typography variant="caption" color="text.secondary">
                    • {project.lastAnalyzed}
                  </Typography>
                </Box>
              }
            />
          </ListItemButton>
        ))}
      </List>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Sidebar */}
      <Box
        component="nav"
        sx={{
          width: { md: DRAWER_WIDTH },
          flexShrink: { md: 0 },
        }}
      >
        {isMobile ? (
          <Drawer
            variant="temporary"
            open={mobileOpen}
            onClose={handleDrawerToggle}
            ModalProps={{ keepMounted: true }}
            sx={{
              '& .MuiDrawer-paper': {
                boxSizing: 'border-box',
                width: DRAWER_WIDTH,
              },
            }}
          >
            {drawer}
          </Drawer>
        ) : (
          <Drawer
            variant="permanent"
            sx={{
              '& .MuiDrawer-paper': {
                boxSizing: 'border-box',
                width: DRAWER_WIDTH,
              },
            }}
            open
          >
            {drawer}
          </Drawer>
        )}
      </Box>

      {/* Main Content */}
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
          height: '100vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: 'background.default'
        }}
      >
        {/* Header */}
        {isMobile && (
          <AppBar position="static">
            <Toolbar>
              <IconButton
                color="inherit"
                edge="start"
                onClick={handleDrawerToggle}
                sx={{ mr: 2 }}
              >
                <MenuIcon />
              </IconButton>
              <Typography variant="h6" noWrap component="div">
                {selectedProject?.name || 'Projects'}
              </Typography>
              {selectedProject && (
                <Box sx={{ ml: 'auto' }}>
                  <IconButton color="inherit" onClick={() => setInfoPanelOpen(!infoPanelOpen)}>
                    <Info />
                  </IconButton>
                </Box>
              )}
            </Toolbar>
          </AppBar>
        )}

        {/* Project Content */}
        <Box sx={{
          flexGrow: 1,
          overflow: 'hidden',
          position: 'relative',
          height: '100%'
        }}>
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
              <CircularProgress size={60} thickness={4} />
            </Box>
          ) : selectedProject && projectData ? (
            <>
              {viewMode === 'overview' ? (
                // Overview mode - show perspective cards
                <Box sx={{ p: 4, height: '100%', overflow: 'auto' }}>
                  <Box sx={{ mb: 4 }}>
                    <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
                      <Box>
                        <Breadcrumbs separator={<ChevronRight fontSize="small" />}>
                          <Link color="inherit" href="/projects" sx={{ cursor: 'pointer', textDecoration: 'none' }}>
                            Projects
                          </Link>
                          <Typography color="text.primary">{selectedProject.name}</Typography>
                        </Breadcrumbs>
                        <Typography variant="h3" fontWeight={700} sx={{ mt: 1 }}>
                          {selectedProject.name}
                        </Typography>
                        <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
                          {projectData.nodes?.length || 0} components • {projectData.edges?.length || 0} connections
                        </Typography>
                      </Box>

                      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                        <Button
                          variant="outlined"
                          startIcon={<Assessment />}
                          onClick={() => setInfoPanelOpen(true)}
                        >
                          Analysis Details
                        </Button>
                        <Button
                          variant="contained"
                          startIcon={<Build />}
                          onClick={() => fetchProjectData(selectedProject.id)}
                        >
                          Re-analyze
                        </Button>
                      </Box>
                    </Stack>
                  </Box>

                  {/* Architecture Components */}
                  <Box sx={{ mb: 3 }}>
                    <Typography variant="h5" fontWeight={600} sx={{ mb: 2 }}>
                      Architecture Components
                    </Typography>

                    {/* Analyzer Filters */}
                    <Box sx={{ mb: 3, p: 2, bgcolor: 'background.paper', borderRadius: 2 }}>
                      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                        Filter by Analyzer:
                      </Typography>
                      <Stack direction="row" spacing={1} flexWrap="wrap" gap={1}>
                        {projectData.analyzer_contributions
                          ?.filter(contribution => contribution.nodes_created > 0) // Only show analyzers that created nodes
                          ?.map((contribution) => (
                          <Chip
                            key={contribution.analyzer_id}
                            label={contribution.analyzer_name}
                            onClick={() => {
                              setActiveAnalyzers(prev =>
                                prev.includes(contribution.analyzer_id)
                                  ? prev.filter(id => id !== contribution.analyzer_id)
                                  : [...prev, contribution.analyzer_id]
                              );
                            }}
                            color={activeAnalyzers.includes(contribution.analyzer_id) ? 'primary' : 'default'}
                            variant={activeAnalyzers.includes(contribution.analyzer_id) ? 'filled' : 'outlined'}
                            icon={
                              contribution.analyzer_type === 'language' ? <Code /> :
                              contribution.analyzer_type === 'framework' ? <Architecture /> :
                              contribution.analyzer_type === 'library' ? <Layers /> :
                              <ViewModule />
                            }
                          />
                        ))}
                      </Stack>
                    </Box>
                  </Box>

                  <Grid container spacing={3}>
                    {(() => {
                      // Filter nodes based on active analyzers
                      const filteredNodes = projectData.nodes.filter(node => {
                        // Check if node was created/tagged by any active analyzer
                        const nodeAnalyzer = node.metadata?.framework ||
                                           node.metadata?.analyzer ||
                                           (node.metadata?.perspective_data && Object.keys(node.metadata.perspective_data)[0]);

                        if (nodeAnalyzer && activeAnalyzers.includes(nodeAnalyzer)) {
                          return true;
                        }

                        // Check tags for framework analyzers
                        if (node.tags?.some(tag =>
                          activeAnalyzers.some(analyzer => tag.includes(analyzer))
                        )) {
                          return true;
                        }

                        // Language analyzers typically don't tag, so check by type patterns
                        if (activeAnalyzers.includes('typescript-javascript') &&
                            ['class', 'function', 'method', 'interface', 'module'].includes(node.type)) {
                          return true;
                        }
                        if (activeAnalyzers.includes('python') &&
                            ['class', 'function', 'method', 'module'].includes(node.type)) {
                          return true;
                        }

                        // Framework-specific types
                        if (activeAnalyzers.includes('nestjs') &&
                            ['controller', 'service', 'module', 'guard', 'provider'].includes(node.type)) {
                          return true;
                        }

                        return false;
                      });

                      // Group filtered nodes by type
                      const typeGroups = new Map<string, { nodes: any[], color: string }>();

                      filteredNodes.forEach(node => {
                        if (!node.type) return;

                        const color = getColorFromString(node.type);
                        if (!typeGroups.has(node.type)) {
                          typeGroups.set(node.type, { nodes: [], color });
                        }
                        typeGroups.get(node.type)!.nodes.push(node);
                      });

                      // Sort by node count and create cards
                      return Array.from(typeGroups.entries())
                        .sort(([, a], [, b]) => b.nodes.length - a.nodes.length)
                        .slice(0, 12) // Show top 12 types
                        .map(([typeName, group], index) => {
                          // Format the type name for display
                          let displayName = typeName.charAt(0).toUpperCase() + typeName.slice(1);
                          if (displayName.includes('_')) {
                            displayName = displayName.split('_').map(part =>
                              part.charAt(0).toUpperCase() + part.slice(1)
                            ).join(' ');
                          }
                          // Pluralize
                          if (!displayName.endsWith('s')) {
                            if (displayName.endsWith('y')) {
                              displayName = displayName.slice(0, -1) + 'ies';
                            } else if (displayName.endsWith('ss') || displayName.endsWith('x')) {
                              displayName = displayName + 'es';
                            } else {
                              displayName = displayName + 's';
                            }
                          }

                          return (
                            <Fade in key={typeName} timeout={300 + index * 100}>
                              <Grid item xs={12} sm={6} md={4}>
                                <Card
                                  onClick={() => {
                                    setViewMode('perspective');
                                    setSelectedPerspectiveGroup(typeName);
                                  }}
                                  sx={{
                                    cursor: 'pointer',
                                    transition: 'all 0.3s ease',
                                    border: '2px solid transparent',
                                    bgcolor: 'rgba(255, 255, 255, 0.05)',
                                    '&:hover': {
                                      transform: 'scale(1.05)',
                                      borderColor: group.color,
                                      bgcolor: 'rgba(255, 255, 255, 0.1)',
                                      boxShadow: 4
                                    }
                                  }}
                                >
                                  <CardContent>
                                    <Stack direction="row" alignItems="center" spacing={2}>
                                      <Box
                                        sx={{
                                          width: 48,
                                          height: 48,
                                          borderRadius: 2,
                                          bgcolor: group.color + '20',
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'center'
                                        }}
                                      >
                                        <ViewModule sx={{ color: group.color }} />
                                      </Box>
                                      <Box sx={{ flexGrow: 1 }}>
                                        <Typography variant="h6" fontWeight={600}>
                                          {displayName}
                                        </Typography>
                                        <Typography variant="body2" color="text.secondary">
                                          {group.nodes.length} {group.nodes.length === 1 ? 'item' : 'items'}
                                        </Typography>
                                      </Box>
                                      <ChevronRight color="action" />
                                    </Stack>
                                  </CardContent>
                                </Card>
                              </Grid>
                            </Fade>
                          );
                        });
                    })()}
                  </Grid>
                </Box>
              ) : (
                // Perspective view - show diagram
                <Box sx={{ height: '100%', position: 'relative' }}>
                  <Box
                    sx={{
                      position: 'absolute',
                      top: 16,
                      left: 16,
                      zIndex: 10
                    }}
                  >
                    <Button
                      variant="outlined"
                      onClick={() => {
                        setViewMode('overview');
                        setSelectedPerspectiveGroup(null);
                      }}
                      sx={{
                        bgcolor: 'rgba(255, 255, 255, 0.1)',
                        color: 'white',
                        borderColor: 'rgba(255, 255, 255, 0.3)',
                        '&:hover': {
                          bgcolor: 'rgba(255, 255, 255, 0.2)',
                          borderColor: 'rgba(255, 255, 255, 0.5)'
                        }
                      }}
                    >
                      ← Back to Overview
                    </Button>
                  </Box>
                  <InteractiveArchitectureDiagram
                    showSelectionView={true}
                    groupName={selectedPerspectiveGroup || undefined}
                    allNodes={projectData.nodes}
                    onInfoPanelOpen={() => setInfoPanelOpen(true)}
                    nodes={(() => {
                      // Filter nodes by the selected type
                      if (!selectedPerspectiveGroup) return [];

                      return projectData.nodes.filter(node =>
                        node.type === selectedPerspectiveGroup
                      );
                    })()}
                    edges={projectData.edges || []}
                  />
                </Box>
              )}
            </>
          ) : !selectedProject ? (
            // No project selected
            <Container maxWidth="md" sx={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <Paper sx={{ p: 6, textAlign: 'center', bgcolor: 'background.paper' }}>
                <Architecture sx={{ fontSize: 80, color: 'primary.main', mb: 3 }} />
                <Typography variant="h4" gutterBottom fontWeight={600}>
                  Welcome to Unravl
                </Typography>
                <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
                  Select a project from the sidebar to begin exploring its architecture
                </Typography>
                <Stack direction="row" spacing={2} justifyContent="center">
                  <Button variant="contained" startIcon={<Folder />} onClick={() => handleProjectClick(projects[0])}>
                    Open a Project
                  </Button>
                  <Button variant="outlined" startIcon={<Settings />}>
                    Settings
                  </Button>
                </Stack>
              </Paper>
            </Container>
          ) : (
            // Project selected but no data
            <Container maxWidth="md" sx={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <Paper sx={{ p: 6, textAlign: 'center', bgcolor: 'background.paper' }}>
                <Storage sx={{ fontSize: 80, color: 'text.secondary', mb: 3 }} />
                <Typography variant="h4" gutterBottom fontWeight={600}>
                  No Analysis Data Available
                </Typography>
                <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
                  This project hasn't been analyzed yet or the analysis data is unavailable
                </Typography>
                <Button
                  variant="contained"
                  startIcon={<Build />}
                  onClick={() => fetchProjectData(selectedProject.id)}
                >
                  Analyze Project
                </Button>
              </Paper>
            </Container>
          )}
        </Box>
      </Box>

      {/* Analysis Info Panel */}
      <AnalysisInfoPanel
        open={infoPanelOpen}
        onClose={() => setInfoPanelOpen(false)}
        analysisData={projectData}
      />
    </Box>
  );
}