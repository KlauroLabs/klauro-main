import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Card,
  CardContent,
  CardActions,
  Button,
  Grid,
  Chip,
  Fade,
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
  Divider,
  Drawer,
  IconButton,
  Avatar,
  useTheme,
  useMediaQuery,
  Fab,
  Paper,
  ListItemButton
} from '@mui/material';
import {
  Add,
  Code,
  Visibility,
  Settings,
  CheckCircle,
  RadioButtonUnchecked,
  Error as ErrorIcon,
  Menu as MenuIcon,
  Dashboard,
  Analytics,
  Storage,
  AccountTree,
  History,
  Info as InfoIcon,
  Close as CloseIcon,
  Architecture,
  Speed,
  Security,
  BugReport,
  Timeline
} from '@mui/icons-material';
import Link from 'next/link';
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
  status: 'analyzed' | 'analyzing' | 'error';
  components: number;
  issues: number;
}

// Using CAS data directly instead of custom ProjectData

const menuItems = [
  { id: 'projects', label: 'Projects', icon: Dashboard, path: '/projects' },
  { id: 'architecture', label: 'Architecture', icon: Architecture, path: '/architecture' },
  { id: 'performance', label: 'Performance', icon: Speed, path: '/performance' },
  { id: 'security', label: 'Security', icon: Security, path: '/security' },
  { id: 'issues', label: 'Issues', icon: BugReport, path: '/issues' },
  { id: 'database', label: 'Database', icon: Storage, path: '/database' },
  { id: 'analytics', label: 'Analytics', icon: Analytics, path: '/analytics' },
  { id: 'telemetry', label: 'Telemetry', icon: Timeline, path: '/telemetry' },
];

export default function ProjectsPage() {
  const router = useRouter();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  // Helper function to group nodes based on selected perspective
  const getNodeGroup = (node: any, perspective: string) => {
    switch (perspective) {
      case 'nestjs':
        if (node.type === 'controller' || node.tags?.includes('controller')) return { key: 'Controllers', color: '#8b5cf6' };
        if (node.type === 'service' || node.tags?.includes('service')) return { key: 'Services', color: '#10b981' };
        if (node.type === 'module' || node.tags?.includes('module')) return { key: 'Modules', color: '#f59e0b' };
        if (node.type === 'repository' || node.tags?.includes('repository')) return { key: 'Repositories', color: '#ef4444' };
        if (node.type === 'entity' || node.tags?.includes('entity')) return { key: 'Entities', color: '#06b6d4' };
        if (node.type === 'guard' || node.tags?.includes('guard')) return { key: 'Guards', color: '#f97316' };
        if (node.type === 'middleware' || node.tags?.includes('middleware')) return { key: 'Middleware', color: '#84cc16' };
        break;

      case 'typescript':
        if (node.type === 'class' || node.tags?.includes('class')) return { key: 'Classes', color: '#3b82f6' };
        if (node.type === 'interface' || node.tags?.includes('interface')) return { key: 'Interfaces', color: '#8b5cf6' };
        if (node.type === 'function' || node.tags?.includes('function')) return { key: 'Functions', color: '#10b981' };
        if (node.type === 'type' || node.tags?.includes('type')) return { key: 'Types', color: '#f59e0b' };
        if (node.type === 'enum' || node.tags?.includes('enum')) return { key: 'Enums', color: '#ef4444' };
        break;

      case 'express':
        if (node.type === 'router' || node.tags?.includes('router')) return { key: 'Routers', color: '#10b981' };
        if (node.type === 'middleware' || node.tags?.includes('middleware')) return { key: 'Middleware', color: '#f59e0b' };
        if (node.type === 'controller' || node.tags?.includes('controller')) return { key: 'Controllers', color: '#8b5cf6' };
        if (node.type === 'route' || node.tags?.includes('route')) return { key: 'Routes', color: '#06b6d4' };
        break;

      case 'react':
        if (node.type === 'component' || node.tags?.includes('component')) return { key: 'Components', color: '#06b6d4' };
        if (node.type === 'hook' || node.tags?.includes('hook')) return { key: 'Hooks', color: '#10b981' };
        if (node.type === 'context' || node.tags?.includes('context')) return { key: 'Contexts', color: '#8b5cf6' };
        if (node.type === 'page' || node.tags?.includes('page')) return { key: 'Pages', color: '#f59e0b' };
        break;

      case 'all':
      default:
        // Group by file type or general categories
        if (node.source?.file.endsWith('.controller.ts') || node.type === 'controller') return { key: 'Controllers', color: '#8b5cf6' };
        if (node.source?.file.endsWith('.service.ts') || node.type === 'service') return { key: 'Services', color: '#10b981' };
        if (node.source?.file.endsWith('.module.ts') || node.type === 'module') return { key: 'Modules', color: '#f59e0b' };
        if (node.source?.file.includes('component') || node.type === 'component') return { key: 'Components', color: '#06b6d4' };
        if (node.type === 'function' || node.tags?.includes('function')) return { key: 'Functions', color: '#84cc16' };
        if (node.type === 'class' || node.tags?.includes('class')) return { key: 'Classes', color: '#ef4444' };
        break;
    }
    return { key: 'Other', color: '#6b7280' };
  };

  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [projects] = useState<Project[]>([
    {
      id: 'backend',
      name: 'Unravl Backend',
      repository: 'unravl/backend',
      lastAnalyzed: '2024-01-15T10:30:00Z',
      status: 'analyzed',
      components: 47,
      issues: 3,
    },
    {
      id: 'frontend',
      name: 'Unravl Frontend',
      repository: 'unravl/frontend',
      lastAnalyzed: '2024-01-15T09:15:00Z',
      status: 'analyzed',
      components: 23,
      issues: 1,
    },
  ]);

  const [projectData, setProjectData] = useState<CASOutput | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [infoPanelOpen, setInfoPanelOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'overview' | 'perspective'>('overview');
  const [selectedPerspectiveGroup, setSelectedPerspectiveGroup] = useState<string | null>(null);
  const [selectedPerspective, setSelectedPerspective] = useState<string>('all');

  useEffect(() => {
    const { projectId } = router.query;
    if (projectId && typeof projectId === 'string') {
      const project = projects.find(p => p.id === projectId);
      if (project && !selectedProject) {
        setSelectedProject(project);
        fetchProjectData(project.id);
      }
    }
  }, [router.query, selectedProject]);

  const handleDrawerToggle = () => {
    setMobileOpen(!mobileOpen);
  };

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

  const handleProjectSelect = (project: Project) => {
    setSelectedProject(project);
    fetchProjectData(project.id);

    // Update URL to preserve navigation state
    router.push(`/projects?projectId=${project.id}`, undefined, { shallow: true });

    if (isMobile) {
      setMobileOpen(false);
    }
  };

  const drawer = (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{
        p: 3,
        borderBottom: 1,
        borderColor: 'divider',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        color: 'white'
      }}>
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
          <AccountTree sx={{ fontSize: 32, mr: 2 }} />
          <Typography variant="h5" sx={{ fontWeight: 700, letterSpacing: 1.2 }}>
            UNRAVL
          </Typography>
        </Box>
        <Typography variant="body2" sx={{ opacity: 0.9 }}>
          Architecture Intelligence Platform
        </Typography>
      </Box>

      <List sx={{ flexGrow: 1, py: 1 }}>
        {menuItems.map((item) => (
          <ListItemButton
            key={item.id}
            selected={item.id === 'projects'}
            onClick={() => router.push(item.path)}
            sx={{
              mx: 2,
              my: 0.5,
              borderRadius: 2,
              '&.Mui-selected': {
                backgroundColor: 'primary.main',
                color: 'primary.contrastText',
                '&:hover': {
                  backgroundColor: 'primary.dark',
                },
                '& .MuiListItemIcon-root': {
                  color: 'primary.contrastText',
                },
              },
            }}
          >
            <ListItemIcon>
              <item.icon />
            </ListItemIcon>
            <ListItemText
              primary={item.label}
              primaryTypographyProps={{
                fontWeight: item.id === 'projects' ? 600 : 400
              }}
            />
          </ListItemButton>
        ))}
      </List>

      <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Avatar sx={{ bgcolor: 'primary.main' }}>U</Avatar>
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
              User Name
            </Typography>
            <Typography variant="caption" color="text.secondary">
              user@company.com
            </Typography>
          </Box>
        </Box>
      </Box>
    </Box>
  );

  if (!selectedProject) {
    return (
      <Box sx={{ display: 'flex', height: '100vh' }}>
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
              ModalProps={{
                keepMounted: true,
              }}
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
                  border: 'none',
                  boxShadow: '2px 0 8px rgba(0,0,0,0.1)',
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
            backgroundColor: 'background.default',
            minHeight: '100vh',
          }}
        >
          {/* Mobile Header */}
          {isMobile && (
            <Box sx={{
              display: 'flex',
              alignItems: 'center',
              p: 2,
              borderBottom: 1,
              borderColor: 'divider',
              bgcolor: 'background.paper'
            }}>
              <IconButton onClick={handleDrawerToggle} sx={{ mr: 2 }}>
                <MenuIcon />
              </IconButton>
              <Typography variant="h6">Projects</Typography>
            </Box>
          )}

          {/* Project Selection */}
          <Box sx={{ p: 4 }}>
            <Typography variant="h4" gutterBottom sx={{ fontWeight: 700, mb: 1 }}>
              Select a Project
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
              Choose a project to explore its interactive architecture diagram
            </Typography>

            <Grid container spacing={3}>
              {projects.map((project) => (
                <Grid item xs={12} md={6} lg={4} key={project.id}>
                  <Card
                    sx={{
                      height: '100%',
                      cursor: 'pointer',
                      transition: 'all 0.3s ease',
                      '&:hover': {
                        transform: 'translateY(-4px)',
                        boxShadow: 6,
                      }
                    }}
                    onClick={() => handleProjectSelect(project)}
                  >
                    <CardContent sx={{ pb: 1 }}>
                      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 2 }}>
                        <Box>
                          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                            {project.name}
                          </Typography>
                          <Typography variant="body2" color="text.secondary" gutterBottom>
                            {project.repository}
                          </Typography>
                        </Box>
                        <Chip
                          label={project.status}
                          color={project.status === 'analyzed' ? 'success' : project.status === 'analyzing' ? 'warning' : 'error'}
                          size="small"
                          sx={{ fontWeight: 600 }}
                        />
                      </Box>

                      <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <AccountTree fontSize="small" color="primary" />
                          <Typography variant="body2" color="text.secondary">
                            {project.components} components
                          </Typography>
                        </Box>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <ErrorIcon fontSize="small" color={project.issues > 0 ? 'warning' : 'success'} />
                          <Typography variant="body2" color="text.secondary">
                            {project.issues} issues
                          </Typography>
                        </Box>
                      </Box>

                      <Typography variant="caption" color="text.secondary">
                        Last analyzed: {new Date(project.lastAnalyzed).toLocaleDateString()}
                      </Typography>
                    </CardContent>

                    <CardActions>
                      <Button
                        variant="contained"
                        fullWidth
                        sx={{
                          fontWeight: 600,
                          textTransform: 'none'
                        }}
                      >
                        Explore Architecture
                      </Button>
                    </CardActions>
                  </Card>
                </Grid>
              ))}
            </Grid>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', height: '100vh' }}>
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
            ModalProps={{
              keepMounted: true,
            }}
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
                border: 'none',
                boxShadow: '2px 0 8px rgba(0,0,0,0.1)',
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
          position: 'relative',
          marginRight: infoPanelOpen && !isMobile ? '400px' : 0,
          transition: 'margin-right 0.3s',
        }}
      >
        {/* Mobile Header */}
        {isMobile && (
          <Box sx={{
            display: 'flex',
            alignItems: 'center',
            p: 2,
            borderBottom: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
            zIndex: 10
          }}>
            <IconButton onClick={handleDrawerToggle} sx={{ mr: 2 }}>
              <MenuIcon />
            </IconButton>
            <Typography variant="h6">{selectedProject.name}</Typography>
            <Box sx={{ ml: 'auto' }}>
              <IconButton
                onClick={() => setInfoPanelOpen(!infoPanelOpen)}
                color={infoPanelOpen ? 'primary' : 'default'}
              >
                <InfoIcon />
              </IconButton>
            </Box>
          </Box>
        )}

        {/* Desktop Header */}
        {!isMobile && (
          <Paper
            elevation={1}
            sx={{
              p: 2,
              borderRadius: 0,
              borderBottom: 1,
              borderColor: 'divider',
              zIndex: 10,
              position: 'relative'
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Box>
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  {selectedProject.name}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Interactive Architecture Exploration
                </Typography>
              </Box>

              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {viewMode === 'perspective' && (
                  <Button
                    variant="outlined"
                    onClick={() => {
                      setViewMode('overview');
                      setSelectedPerspectiveGroup(null);
                    }}
                    size="small"
                    sx={{ textTransform: 'none' }}
                  >
                    Back to Overview
                  </Button>
                )}

                <FormControl size="small" sx={{ minWidth: 150 }}>
                  <InputLabel>Framework View</InputLabel>
                  <Select
                    value={selectedPerspective}
                    label="Framework View"
                    onChange={(e) => {
                      setSelectedPerspective(e.target.value);
                      // Reset to overview mode when changing perspectives
                      setViewMode('overview');
                      setSelectedPerspectiveGroup(null);
                    }}
                  >
                    <MenuItem value="nestjs">NestJS</MenuItem>
                    <MenuItem value="typescript">TypeScript</MenuItem>
                    <MenuItem value="express">Express</MenuItem>
                    <MenuItem value="react">React</MenuItem>
                    <MenuItem value="all">All Components</MenuItem>
                  </Select>
                </FormControl>

                <Button
                  variant="outlined"
                  onClick={() => {
                    setSelectedProject(null);
                    router.push('/projects', undefined, { shallow: true });
                  }}
                  size="small"
                  sx={{ textTransform: 'none' }}
                >
                  Back to Projects
                </Button>
                <IconButton
                  onClick={() => setInfoPanelOpen(!infoPanelOpen)}
                  color={infoPanelOpen ? 'primary' : 'default'}
                  sx={{
                    bgcolor: infoPanelOpen ? 'primary.light' : 'transparent',
                    '&:hover': {
                      bgcolor: infoPanelOpen ? 'primary.main' : 'action.hover',
                    }
                  }}
                >
                  <InfoIcon />
                </IconButton>
              </Box>
            </Box>
          </Paper>
        )}

        {/* Diagram Content */}
        <Box sx={{ height: isMobile ? 'calc(100vh - 73px)' : 'calc(100vh - 89px)', overflow: 'hidden' }}>
          {projectData && projectData.nodes && projectData.nodes.length > 0 ? (
            <Box
              sx={{
                flex: 1,
                position: 'relative',
                background: 'radial-gradient(circle at center, #0a1929 0%, #000 100%)',
                overflow: 'hidden',
                cursor: 'grab'
              }}
            >
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  backgroundImage: `
                    linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
                    linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)
                  `,
                  backgroundSize: '50px 50px',
                  opacity: 0.5
                }}
              />

              {viewMode === 'overview' ? (
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                  gap: 3,
                  p: 4,
                  maxWidth: 1200,
                  margin: '0 auto'
                }}
              >
                {(() => {
                  // Group nodes based on selected perspective
                  const groups = new Map<string, { nodes: any[], color: string }>();

                  projectData.nodes.forEach(node => {
                    const { key: groupKey, color } = getNodeGroup(node, selectedPerspective);

                    if (!groups.has(groupKey)) {
                      groups.set(groupKey, { nodes: [], color });
                    }
                    groups.get(groupKey)!.nodes.push(node);
                  });

                  // Create perspective cards
                  return Array.from(groups.entries())
                    .filter(([_, group]) => group.nodes.length > 0)
                    .map(([groupName, group], index) => (
                      <Fade in key={groupName} timeout={300 + index * 100}>
                        <Card
                          onClick={() => {
                            setViewMode('perspective');
                            setSelectedPerspectiveGroup(groupName);
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
                              boxShadow: `0 8px 32px ${group.color}40`
                            }
                          }}
                        >
                          <CardContent sx={{ textAlign: 'center', p: 4 }}>
                            <Typography variant="h5" sx={{ mb: 2, fontWeight: 600, color: 'white' }}>
                              {groupName}
                            </Typography>
                            <Chip
                              label={`${group.nodes.length} items`}
                              sx={{
                                bgcolor: `${group.color}20`,
                                color: group.color,
                                fontWeight: 'bold',
                                mb: 2
                              }}
                            />
                            <Typography variant="body2" color="text.secondary">
                              Click to explore {groupName.toLowerCase()}
                            </Typography>
                          </CardContent>
                        </Card>
                      </Fade>
                    ));
                })()}
              </Box>
              ) : (
                <Box sx={{ position: 'relative', height: '100%' }}>
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
                    nodes={(() => {
                      // Filter nodes for selected perspective group
                      const groups = new Map<string, { nodes: any[], color: string }>();

                      projectData.nodes.forEach(node => {
                        const { key: groupKey, color } = getNodeGroup(node, selectedPerspective);

                        if (!groups.has(groupKey)) {
                          groups.set(groupKey, { nodes: [], color });
                        }
                        groups.get(groupKey)!.nodes.push(node);
                      });

                      const selectedNodes = selectedPerspectiveGroup && groups.has(selectedPerspectiveGroup)
                        ? groups.get(selectedPerspectiveGroup)!.nodes
                        : [];

                      // Include connected nodes to show full context
                      const selectedNodeIds = new Set(selectedNodes.map(n => n.id));
                      const connectedNodeIds = new Set<string>();

                      // Add nodes that are connected to the selected nodes
                      projectData.edges?.forEach(edge => {
                        if (selectedNodeIds.has(edge.source)) {
                          connectedNodeIds.add(edge.target);
                        }
                        if (selectedNodeIds.has(edge.target)) {
                          connectedNodeIds.add(edge.source);
                        }
                      });

                      // Include both selected nodes and their connections
                      const allRelevantNodes = selectedNodes.slice();
                      projectData.nodes.forEach(node => {
                        if (connectedNodeIds.has(node.id) && !selectedNodeIds.has(node.id)) {
                          allRelevantNodes.push(node);
                        }
                      });

                      return allRelevantNodes;
                    })()}
                    edges={(() => {
                      // Filter edges to only show connections involving the visible nodes
                      const visibleNodeIds = new Set(
                        selectedPerspectiveGroup ?
                          (() => {
                            const groups = new Map<string, { nodes: any[], color: string }>();
                            projectData.nodes.forEach(node => {
                              const { key: groupKey, color } = getNodeGroup(node, selectedPerspective);

                              if (!groups.has(groupKey)) groups.set(groupKey, { nodes: [], color });
                              groups.get(groupKey)!.nodes.push(node);
                            });

                            const selectedNodes = groups.get(selectedPerspectiveGroup)?.nodes || [];
                            const selectedIds = new Set(selectedNodes.map(n => n.id));
                            const connectedIds = new Set<string>();

                            projectData.edges?.forEach(edge => {
                              if (selectedIds.has(edge.source)) connectedIds.add(edge.target);
                              if (selectedIds.has(edge.target)) connectedIds.add(edge.source);
                            });

                            return [...selectedIds, ...connectedIds];
                          })() : []
                      );

                      return (projectData.edges || []).filter(edge =>
                        visibleNodeIds.has(edge.source) || visibleNodeIds.has(edge.target)
                      );
                    })()}
                  />
                </Box>
              )}
            </Box>
          ) : (
            <Box sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'white'
            }}>
              <Typography>
                {loading ? 'Loading analysis...' : 'No components found'}
              </Typography>
            </Box>
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