import React, { useState, useEffect } from 'react';
import {
  Box,
  Container,
  Paper,
  Typography,
  Button,
  Alert,
  Skeleton,
} from '@mui/material';
import { Refresh } from '@mui/icons-material';
import { VisualizationCanvas } from '@/components/visualization/VisualizationCanvas';
import { ArchitectureBlueprint, VisualizationOptions } from '@/types/visualization';

const DemoPage: React.FC = () => {
  const [blueprint, setBlueprint] = useState<ArchitectureBlueprint | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<VisualizationOptions>({
    layout: 'force',
    theme: 'blueprint', // Start with blueprint theme
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
    generateDemoBlueprint();
  }, []);

  const generateDemoBlueprint = () => {
    try {
      setLoading(true);
      setError(null);
      
      // Create consistent demo blueprint data (no randomization)
      const demoBlueprint: ArchitectureBlueprint = {
        projectName: 'Unravl Platform Demo',
        framework: 'Node.js + Next.js',
        components: [
          {
            id: 'auth-service',
            name: 'Authentication Service',
            type: 'service',
            path: '/src/auth',
            dependencies: ['jwt-lib', 'bcrypt'],
            dependents: ['user-controller', 'api-gateway'],
            metadata: {
              lineCount: 450,
              complexity: 7,
              lastModified: new Date('2024-01-15'),
              exports: ['login', 'logout', 'validateToken'],
              imports: ['express', 'jsonwebtoken'],
              layer: 'business',
              responsibilities: ['User authentication', 'Token management']
            }
          },
          {
            id: 'user-controller',
            name: 'User Controller',
            type: 'controller',
            path: '/src/controllers/user',
            dependencies: ['auth-service', 'user-model'],
            dependents: ['api-routes'],
            metadata: {
              lineCount: 320,
              complexity: 5,
              lastModified: new Date('2024-01-12'),
              exports: ['getUser', 'createUser', 'updateUser'],
              imports: ['express', 'auth-service'],
              layer: 'presentation',
              responsibilities: ['Handle user requests', 'Data validation']
            }
          },
          {
            id: 'user-model',
            name: 'User Model',
            type: 'model',
            path: '/src/models/user',
            dependencies: ['database'],
            dependents: ['user-controller', 'auth-service'],
            metadata: {
              lineCount: 280,
              complexity: 4,
              lastModified: new Date('2024-01-10'),
              exports: ['User', 'findById', 'create'],
              imports: ['sequelize', 'bcrypt'],
              layer: 'data',
              responsibilities: ['User data management', 'Database operations']
            }
          },
          {
            id: 'database',
            name: 'Database Service',
            type: 'database',
            path: '/src/database',
            dependencies: [],
            dependents: ['user-model', 'project-model'],
            metadata: {
              lineCount: 150,
              complexity: 3,
              lastModified: new Date('2024-01-08'),
              exports: ['connection', 'query'],
              imports: ['pg', 'sequelize'],
              layer: 'infrastructure',
              responsibilities: ['Database connection', 'Query execution']
            }
          },
          {
            id: 'visualization-engine',
            name: 'Visualization Engine',
            type: 'service',
            path: '/src/visualization',
            dependencies: ['d3', 'canvas'],
            dependents: ['viz-controller'],
            metadata: {
              lineCount: 850,
              complexity: 9,
              lastModified: new Date('2024-01-18'),
              exports: ['render', 'generateBlueprint'],
              imports: ['d3', 'three.js'],
              layer: 'business',
              responsibilities: ['Generate visualizations', 'Blueprint rendering']
            }
          },
          {
            id: 'frontend-app',
            name: 'Next.js Frontend',
            type: 'external_api',
            path: '/frontend',
            dependencies: ['react', 'mui'],
            dependents: [],
            metadata: {
              lineCount: 1200,
              complexity: 6,
              lastModified: new Date('2024-01-20'),
              exports: ['pages', 'components'],
              imports: ['next', 'react', '@mui/material'],
              layer: 'presentation',
              responsibilities: ['User interface', 'Client-side routing']
            }
          },
          {
            id: 'blueprint-renderer',
            name: 'Blueprint Renderer',
            type: 'service',
            path: '/src/lib/blueprint',
            dependencies: ['d3', 'svg'],
            dependents: ['visualization-canvas'],
            metadata: {
              lineCount: 950,
              complexity: 8,
              lastModified: new Date('2024-01-22'),
              exports: ['BlueprintRenderer', 'render', 'drillDown'],
              imports: ['d3', 'svg'],
              layer: 'business',
              responsibilities: ['Hierarchical rendering', 'Drill-down navigation']
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
          },
          {
            id: 'conn-7',
            sourceId: 'frontend-app',
            targetId: 'blueprint-renderer',
            type: 'function_call',
            weight: 6,
            metadata: { callSites: 8, relationship: 'renders-with' }
          },
          {
            id: 'conn-8',
            sourceId: 'blueprint-renderer',
            targetId: 'visualization-engine',
            type: 'function_call',
            weight: 4,
            metadata: { callSites: 6, relationship: 'uses' }
          }
        ],
        entryPoints: [],
        exitPoints: [],
        orphanedComponents: [],
        riskAreas: [],
        metadata: {
          totalComponents: 7,
          frameworkVersion: '18.2.0',
          analysisDate: new Date(),
          repositoryPath: '/demo',
          entryPointsCount: 1,
          orphanedCount: 0,
          complexityAverage: 6.1,
          primaryLanguage: 'TypeScript',
          languageDistribution: { TypeScript: 0.85, JavaScript: 0.15 },
          codebaseSize: {
            totalLines: 4190,
            codeLines: 2933,
            commentLines: 838,
            blankLines: 419
          }
        },
        technologyStack: {
          primaryFramework: {
            name: 'Express.js',
            version: '4.19.2',
            type: 'api',
            usage: 'primary',
            conventions: [],
            patterns: [],
            detectionConfidence: 0.9
          },
          additionalFrameworks: [],
          languages: [
            {
              name: 'TypeScript',
              fileCount: 18,
              lineCount: 3561,
              percentage: 85
            }
          ],
          buildTools: [],
          testingFrameworks: [],
          databases: [],
          messageQueues: [],
          caching: [],
          authentication: [],
          deployment: []
        },
        dependencies: {
          totalCount: 0,
          directDependencies: [],
          devDependencies: [],
          peerDependencies: [],
          vulnerabilities: [],
          outdated: [],
          unused: [],
          licenseCompliance: []
        },
        apiEndpoints: [],
        securityAnalysis: {
          vulnerabilities: [],
          authenticationMethods: [],
          authorizationPatterns: [],
          dataEncryption: [],
          inputValidation: [],
          securityHeaders: [],
          secrets: []
        },
        testingInfo: {
          frameworks: [],
          coverage: {
            overall: 78,
            lines: { covered: 2287, total: 2933, percentage: 78 },
            branches: { covered: 140, total: 180, percentage: 78 },
            functions: { covered: 54, total: 70, percentage: 77 },
            statements: { covered: 2200, total: 2800, percentage: 79 },
            byComponent: {},
            byType: {},
            uncoveredFiles: []
          },
          testTypes: [],
          testFiles: [],
          totalTests: 0,
          passingTests: 0,
          failingTests: 0,
          skippedTests: 0,
          testSuites: []
        },
        deploymentInfo: {
          platform: 'Docker',
          containerization: { type: 'docker' },
          cicd: {
            platform: 'GitHub Actions',
            configFile: '.github/workflows/ci.yml',
            stages: ['test', 'build', 'deploy'],
            deploymentStrategy: 'rolling',
            automated: true
          },
          monitoring: {
            tools: [],
            metrics: [],
            logging: {
              level: 'info',
              destination: 'console',
              structured: true,
              aggregation: false
            },
            alerting: {
              platform: 'email',
              rules: [],
              channels: []
            }
          },
          scaling: {
            type: 'horizontal',
            automatic: false,
            metrics: [],
            limits: {
              minInstances: 1,
              maxInstances: 3,
              cpu: '500m',
              memory: '256Mi'
            }
          }
        }
      };
      
      setBlueprint(demoBlueprint);
      setTimeout(() => setLoading(false), 800); // Simulate loading
      
    } catch (err) {
      setError('Failed to generate demo blueprint');
      setLoading(false);
    }
  };

  const handleNodeClick = (nodeId: string) => {
    console.log('Demo: Node clicked:', nodeId);
  };

  const handleEdgeClick = (edgeId: string) => {
    console.log('Demo: Edge clicked:', edgeId);
  };

  const handleSectionClick = (sectionId: string) => {
    console.log('Demo: Section clicked:', sectionId);
  };

  const handleComponentClick = (componentId: string) => {
    console.log('Demo: Component clicked:', componentId);
  };

  const handleRefresh = () => {
    generateDemoBlueprint();
  };

  return (
    <Container maxWidth={false} sx={{ height: '100vh', display: 'flex', flexDirection: 'column', py: 2 }}>
      <Box sx={{ mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Typography variant="h4" component="h1">
              🗺️ Blueprint Visualization Demo
            </Typography>
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
        
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Demonstrating the hierarchical blueprint visualization with drill-down navigation and real-time telemetry overlays.
        </Typography>
      </Box>
      
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
                Error Loading Demo
              </Typography>
              {error}
            </Alert>
          </Box>
        ) : blueprint ? (
          <VisualizationCanvas
            blueprint={blueprint}
            options={options}
            projectId="demo"
            onNodeClick={handleNodeClick}
            onEdgeClick={handleEdgeClick}
            onSectionClick={handleSectionClick}
            onComponentClick={handleComponentClick}
          />
        ) : (
          <Box sx={{ p: 3, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography variant="h6" color="text.secondary">
              No demo data available
            </Typography>
          </Box>
        )}
      </Paper>
    </Container>
  );
};

export default DemoPage;