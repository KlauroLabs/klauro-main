import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import {
  Box,
  Container,
  Paper,
  Typography,
  Button,
  Alert,
  Skeleton,
  Breadcrumbs,
  Link,
  Chip,
  Tooltip
} from '@mui/material';
import { ArrowBack, Refresh, Analytics, Info } from '@mui/icons-material';
import { VisualizationCanvas } from '@/components/visualization/VisualizationCanvas';
import { ArchitectureBlueprint, VisualizationOptions } from '@/types/visualization';
import axios from 'axios';

const VisualizationPage: React.FC = () => {
  const router = useRouter();
  const { projectId } = router.query;
  
  const [blueprint, setBlueprint] = useState<ArchitectureBlueprint | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRealData, setIsRealData] = useState(false);
  const [options, setOptions] = useState<VisualizationOptions>({
    layout: 'force',
    theme: 'light',
    filters: {
      showOrphaned: true,
      showCritical: true,
      minConnections: 0
    },
    performance: {
      enableGPU: true,
      maxNodes: 1000,
      updateInterval: 100
    }
  });

  useEffect(() => {
    if (projectId) {
      fetchBlueprint(projectId as string);
    }
  }, [projectId]);

  const fetchBlueprint = async (id: string) => {
    try {
      setLoading(true);
      setError(null);
      
      // Check if we have real analysis data from localStorage (from the projects page)
      const storedAnalysisResult = localStorage.getItem('unravl-analysis-result');
      
      if (storedAnalysisResult) {
        // Use the real analysis data
        const realBlueprint = JSON.parse(storedAnalysisResult);
        
        // Transform the backend data structure to match frontend expectations
        const transformedBlueprint: ArchitectureBlueprint = {
          id: realBlueprint.id || 'real-analysis',
          projectId: id,
          components: realBlueprint.components || [],
          connections: realBlueprint.connections || [],
          orphanedComponents: realBlueprint.orphanedComponents || [],
          metadata: {
            timestamp: new Date(realBlueprint.metadata?.analysisDate || Date.now()),
            version: realBlueprint.metadata?.version || '1.0.0',
            analyzer: realBlueprint.metadata?.analyzer || 'SystemTopologyAnalyzer',
            repository: realBlueprint.metadata?.repositoryPath || '/Users/michaelshattuck/dev/unravl/proof-of-concept'
          },
          statistics: realBlueprint.statistics || {
            totalComponents: 0,
            totalConnections: 0,
            averageComplexity: 0,
            criticalPaths: 0,
            orphanedCount: 0,
            cyclomaticComplexity: 0,
            technicalDebt: 0
          }
        };
        
        setBlueprint(transformedBlueprint);
        setIsRealData(true);
        return;
      }
      
      // Fallback to mock data if no real analysis is available
      const mockBlueprint: ArchitectureBlueprint = {
        id: 'demo-blueprint',
        projectId: id,
        components: [
          {
            id: 'auth-service',
            name: 'Authentication Service',
            type: 'service',
            path: '/src/auth',
            dependencies: ['jwt-lib', 'bcrypt'],
            metadata: { layer: 'business', complexity: 7 },
            metrics: {
              complexity: 7,
              linesOfCode: 450,
              dependencies: 2,
              dependents: 3,
              coupling: 0.6,
              cohesion: 0.8
            }
          },
          {
            id: 'user-controller',
            name: 'User Controller',
            type: 'controller',
            path: '/src/controllers/user',
            dependencies: ['auth-service', 'user-model'],
            metadata: { layer: 'presentation', complexity: 5 },
            metrics: {
              complexity: 5,
              linesOfCode: 320,
              dependencies: 2,
              dependents: 1,
              coupling: 0.4,
              cohesion: 0.9
            }
          },
          {
            id: 'user-model',
            name: 'User Model',
            type: 'model',
            path: '/src/models/user',
            dependencies: ['database'],
            metadata: { layer: 'data', complexity: 4 },
            metrics: {
              complexity: 4,
              linesOfCode: 280,
              dependencies: 1,
              dependents: 2,
              coupling: 0.3,
              cohesion: 0.95
            }
          },
          {
            id: 'database',
            name: 'Database Service',
            type: 'database',
            path: '/src/database',
            dependencies: [],
            metadata: { layer: 'infrastructure', complexity: 3 },
            metrics: {
              complexity: 3,
              linesOfCode: 150,
              dependencies: 0,
              dependents: 3,
              coupling: 0.2,
              cohesion: 0.85
            }
          },
          {
            id: 'visualization-engine',
            name: 'Visualization Engine',
            type: 'service',
            path: '/src/visualization',
            dependencies: ['d3', 'canvas'],
            metadata: { layer: 'business', complexity: 9 },
            metrics: {
              complexity: 9,
              linesOfCode: 850,
              dependencies: 2,
              dependents: 1,
              coupling: 0.5,
              cohesion: 0.7
            }
          },
          {
            id: 'frontend-app',
            name: 'Next.js Frontend',
            type: 'frontend',
            path: '/frontend',
            dependencies: ['react', 'mui'],
            metadata: { layer: 'presentation', complexity: 6 },
            metrics: {
              complexity: 6,
              linesOfCode: 1200,
              dependencies: 2,
              dependents: 0,
              coupling: 0.4,
              cohesion: 0.75
            }
          }
        ],
        connections: [
          {
            id: 'conn-1',
            sourceId: 'user-controller',
            targetId: 'auth-service',
            type: 'function_call',
            weight: 8,
            metadata: { callSites: 12, relationship: 'depends-on' }
          },
          {
            id: 'conn-2',
            sourceId: 'user-controller',
            targetId: 'user-model',
            type: 'function_call',
            weight: 10,
            metadata: { callSites: 15, relationship: 'uses' }
          },
          {
            id: 'conn-3',
            sourceId: 'auth-service',
            targetId: 'user-model',
            type: 'function_call',
            weight: 5,
            metadata: { callSites: 8, relationship: 'queries' }
          },
          {
            id: 'conn-4',
            sourceId: 'user-model',
            targetId: 'database',
            type: 'database',
            weight: 9,
            metadata: { callSites: 20, relationship: 'queries' }
          },
          {
            id: 'conn-5',
            sourceId: 'visualization-engine',
            targetId: 'database',
            type: 'database',
            weight: 3,
            metadata: { callSites: 5, relationship: 'reads-from' }
          },
          {
            id: 'conn-6',
            sourceId: 'frontend-app',
            targetId: 'user-controller',
            type: 'http_call',
            weight: 7,
            metadata: { callSites: 10, relationship: 'api-calls' }
          }
        ],
        orphanedComponents: [],
        metadata: {
          timestamp: new Date(),
          version: '1.0.0',
          analyzer: 'SystemTopologyAnalyzer',
          repository: 'https://github.com/unravl/demo'
        },
        statistics: {
          totalComponents: 6,
          totalConnections: 6,
          averageComplexity: 5.7,
          criticalPaths: 2,
          orphanedCount: 0,
          cyclomaticComplexity: 34,
          technicalDebt: 0.3
        }
      };
      
      setBlueprint(mockBlueprint);
      
      // Show a notice that this is mock data
      console.info('Using mock data - run analysis from Projects page to see real data');
      setIsRealData(false);
    } catch (err) {
      setError(
        err instanceof Error 
          ? err.message 
          : 'Failed to load visualization data'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleNodeClick = (nodeId: string) => {
    console.log('Node clicked:', nodeId);
    router.push(`/projects/${projectId}/components/${nodeId}`);
  };

  const handleEdgeClick = (edgeId: string) => {
    console.log('Edge clicked:', edgeId);
  };

  const handleRefresh = () => {
    // Clear stored analysis data to force refresh
    localStorage.removeItem('unravl-analysis-result');
    if (projectId) {
      fetchBlueprint(projectId as string);
    }
  };

  return (
    <Container maxWidth={false} sx={{ height: '100vh', display: 'flex', flexDirection: 'column', py: 2 }}>
      <Box sx={{ mb: 2 }}>
        <Breadcrumbs aria-label="breadcrumb" sx={{ mb: 1 }}>
          <Link
            underline="hover"
            color="inherit"
            href="/projects"
            onClick={(e) => {
              e.preventDefault();
              router.push('/projects');
            }}
          >
            Projects
          </Link>
          <Link
            underline="hover"
            color="inherit"
            href={`/projects/${projectId}`}
            onClick={(e) => {
              e.preventDefault();
              router.push(`/projects/${projectId}`);
            }}
          >
            {projectId}
          </Link>
          <Typography color="text.primary">Visualization</Typography>
        </Breadcrumbs>
        
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Button
              startIcon={<ArrowBack />}
              onClick={() => router.back()}
              variant="outlined"
              size="small"
            >
              Back
            </Button>
            
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Typography variant="h4" component="h1">
                Architecture Visualization
              </Typography>
              
              {!loading && (
                <Tooltip title={isRealData ? "Live data from analyzer" : "Sample data - run analysis from Projects page for real data"}>
                  <Chip 
                    icon={isRealData ? <Analytics /> : <Info />}
                    label={isRealData ? "Live Analysis" : "Demo Data"}
                    color={isRealData ? "success" : "default"}
                    variant={isRealData ? "filled" : "outlined"}
                    size="small"
                  />
                </Tooltip>
              )}
            </Box>
          </Box>
          
          <Button
            startIcon={<Refresh />}
            onClick={handleRefresh}
            variant="contained"
            disabled={loading}
          >
            Refresh
          </Button>
        </Box>
      </Box>
      
      {/* Show notice for demo data */}
      {!loading && !isRealData && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <Typography variant="body1">
            <strong>Demo Mode:</strong> This visualization shows sample data. 
            Go to <Link href="/projects" onClick={(e) => { e.preventDefault(); router.push('/projects'); }}>Projects</Link> and click "Analyze Current Codebase" to see the real Unravl architecture.
          </Typography>
        </Alert>
      )}
      
      <Paper elevation={3} sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {loading ? (
          <Box sx={{ p: 3, height: '100%' }}>
            <Skeleton variant="rectangular" width="100%" height="60px" sx={{ mb: 2 }} />
            <Skeleton variant="rectangular" width="100%" height="calc(100% - 76px)" />
          </Box>
        ) : error ? (
          <Box sx={{ p: 3, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Alert severity="error" sx={{ maxWidth: 500 }}>
              <Typography variant="h6" gutterBottom>
                Error Loading Visualization
              </Typography>
              {error}
            </Alert>
          </Box>
        ) : blueprint ? (
          <VisualizationCanvas
            blueprint={blueprint}
            options={options}
            projectId={projectId as string}
            onNodeClick={handleNodeClick}
            onEdgeClick={handleEdgeClick}
          />
        ) : (
          <Box sx={{ p: 3, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography variant="h6" color="text.secondary">
              No visualization data available
            </Typography>
          </Box>
        )}
      </Paper>
    </Container>
  );
};

export default VisualizationPage;