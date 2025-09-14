import React, { useState, useEffect } from 'react';
import { Box, Container } from '@mui/material';
import { SystemSchematic } from './SystemSchematic';
import { SchematicNavigation } from './SchematicNavigation';
import { IssuesPanel } from './IssuesPanel';
import { ComponentDetailsPanel } from './ComponentDetailsPanel';

// Sample system data structure - this would come from your API
const generateSystemData = () => ({
  id: 'root',
  name: 'System Overview',
  type: 'section' as const,
  status: 'warning' as const,
  position: { x: 0, y: 0 },
  size: { width: 800, height: 600 },
  connections: [],
  metrics: {
    cpu: 45,
    memory: 67,
    requests: 1250,
    errors: 3,
    activeUsers: 847
  },
  issues: [
    {
      id: 'db-connection',
      severity: 'critical' as const,
      message: 'Database connection pool exhausted',
      component: 'database-service'
    },
    {
      id: 'api-latency',
      severity: 'high' as const,
      message: 'API response time > 2s',
      component: 'user-api'
    }
  ],
  children: [
    {
      id: 'frontend',
      name: 'Frontend Layer',
      type: 'section' as const,
      status: 'healthy' as const,
      position: { x: 50, y: 50 },
      size: { width: 200, height: 120 },
      connections: ['backend'],
      metrics: { activeUsers: 847, requests: 450 },
      issues: [],
      children: [
        {
          id: 'react-app',
          name: 'React Application',
          type: 'subsystem' as const,
          status: 'healthy' as const,
          position: { x: 60, y: 80 },
          size: { width: 180, height: 80 },
          connections: ['user-api'],
          metrics: { activeUsers: 847 },
          issues: [],
          children: [
            {
              id: 'login-component',
              name: 'Login Component',
              type: 'component' as const,
              status: 'healthy' as const,
              position: { x: 70, y: 90 },
              size: { width: 80, height: 40 },
              connections: ['auth-service'],
              metrics: { requests: 123 },
              issues: []
            },
            {
              id: 'dashboard-component',
              name: 'Dashboard',
              type: 'component' as const,
              status: 'healthy' as const,
              position: { x: 160, y: 90 },
              size: { width: 80, height: 40 },
              connections: ['user-api'],
              metrics: { requests: 327, activeUsers: 847 },
              issues: []
            }
          ]
        }
      ]
    },
    {
      id: 'backend',
      name: 'Backend Services',
      type: 'section' as const,
      status: 'warning' as const,
      position: { x: 300, y: 50 },
      size: { width: 200, height: 120 },
      connections: ['database'],
      metrics: { cpu: 78, memory: 65, requests: 800, errors: 2 },
      issues: [
        {
          id: 'api-latency',
          severity: 'high' as const,
          message: 'API response time > 2s',
          component: 'user-api'
        }
      ],
      children: [
        {
          id: 'user-api',
          name: 'User API',
          type: 'subsystem' as const,
          status: 'warning' as const,
          position: { x: 310, y: 80 },
          size: { width: 85, height: 80 },
          connections: ['auth-service', 'database-service'],
          metrics: { cpu: 82, requests: 400, errors: 1 },
          issues: [
            {
              id: 'api-latency',
              severity: 'high' as const,
              message: 'Response time > 2s',
              component: 'user-api'
            }
          ]
        },
        {
          id: 'auth-service',
          name: 'Auth Service',
          type: 'subsystem' as const,
          status: 'healthy' as const,
          position: { x: 405, y: 80 },
          size: { width: 85, height: 80 },
          connections: ['database-service'],
          metrics: { requests: 250 },
          issues: []
        }
      ]
    },
    {
      id: 'database',
      name: 'Database Layer',
      type: 'section' as const,
      status: 'critical' as const,
      position: { x: 550, y: 50 },
      size: { width: 200, height: 120 },
      connections: [],
      metrics: { cpu: 95, memory: 89, errors: 1 },
      issues: [
        {
          id: 'db-connection',
          severity: 'critical' as const,
          message: 'Connection pool exhausted',
          component: 'database-service'
        }
      ],
      children: [
        {
          id: 'database-service',
          name: 'PostgreSQL',
          type: 'subsystem' as const,
          status: 'critical' as const,
          position: { x: 560, y: 80 },
          size: { width: 180, height: 80 },
          connections: [],
          metrics: { cpu: 95, memory: 89 },
          issues: [
            {
              id: 'db-connection',
              severity: 'critical' as const,
              message: 'Connection pool exhausted',
              component: 'database-service'
            }
          ]
        }
      ]
    }
  ]
});

interface SystemViewerProps {
  projectId: string;
}

export const SystemViewer: React.FC<SystemViewerProps> = ({ projectId }) => {
  const [systemData, setSystemData] = useState(generateSystemData());
  const [currentPath, setCurrentPath] = useState([
    { id: 'root', name: 'System Overview', level: 0 }
  ]);
  const [currentZoom, setCurrentZoom] = useState(1);
  const [showIssuesPanel, setShowIssuesPanel] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectedComponent, setSelectedComponent] = useState<any>(null);
  const [showDetailsPanel, setShowDetailsPanel] = useState(false);

  // Navigate to a specific level in the hierarchy
  const navigateToLevel = (levelId: string) => {
    if (levelId === 'root') {
      setCurrentPath([{ id: 'root', name: 'System Overview', level: 0 }]);
      setSystemData(generateSystemData());
      return;
    }

    // Find the path to the target level
    const findPath = (node: any, targetId: string, currentPath: any[] = []): any[] | null => {
      const newPath = [...currentPath, { id: node.id, name: node.name, level: currentPath.length }];
      
      if (node.id === targetId) {
        return newPath;
      }
      
      if (node.children) {
        for (const child of node.children) {
          const result = findPath(child, targetId, newPath);
          if (result) return result;
        }
      }
      
      return null;
    };

    const fullSystemData = generateSystemData();
    const path = findPath(fullSystemData, levelId);
    
    if (path) {
      setCurrentPath(path);
      // Find and set the current node data
      let currentNode = fullSystemData;
      for (let i = 1; i < path.length; i++) {
        const nextNode = currentNode.children?.find(child => child.id === path[i].id);
        if (nextNode) currentNode = nextNode;
      }
      setSystemData(currentNode);
    }
  };

  // Handle drilling down into a component
  const handleDrillDown = (nodeId: string) => {
    const targetNode = systemData.children?.find(child => child.id === nodeId);
    if (targetNode && targetNode.children && targetNode.children.length > 0) {
      const newPath = [...currentPath, { id: nodeId, name: targetNode.name, level: currentPath.length }];
      setCurrentPath(newPath);
      setSystemData(targetNode);
    }
  };

  // Collect all issues from current level and children
  const getAllIssues = () => {
    const collectIssues = (node: any): any[] => {
      let issues = [...(node.issues || [])];
      if (node.children) {
        node.children.forEach((child: any) => {
          issues = issues.concat(collectIssues(child));
        });
      }
      return issues;
    };
    
    return collectIssues(systemData).map(issue => ({
      ...issue,
      id: issue.id || Math.random().toString(),
      type: issue.severity === 'critical' ? 'error' : 'warning',
      timestamp: new Date(),
      details: `Issue detected in ${issue.component}. Immediate attention required.`
    }));
  };

  const allIssues = getAllIssues();

  return (
    <Container maxWidth={false} sx={{ py: 2, height: '100vh', overflow: 'hidden' }}>
      {/* Navigation */}
      <SchematicNavigation
        currentPath={currentPath}
        onNavigateToLevel={navigateToLevel}
        onZoomIn={() => setCurrentZoom(Math.min(currentZoom + 0.25, 2))}
        onZoomOut={() => setCurrentZoom(Math.max(currentZoom - 0.25, 0.5))}
        onToggleFullscreen={() => setIsFullscreen(!isFullscreen)}
        onToggleIssuesList={() => setShowIssuesPanel(!showIssuesPanel)}
        issuesCount={allIssues.length}
        currentZoom={currentZoom}
      />

      {/* Main Schematic View */}
      <Box 
        sx={{ 
          transform: `scale(${currentZoom})`,
          transformOrigin: 'top left',
          transition: 'transform 0.3s ease',
          height: isFullscreen ? '100vh' : 'calc(100vh - 120px)'
        }}
      >
        <SystemSchematic
          systemData={systemData}
          onNodeClick={(nodeId) => {
            const componentDetails = getComponentDetails(nodeId);
            setSelectedComponent(componentDetails);
            setShowDetailsPanel(true);
          }}
          onDrillDown={handleDrillDown}
          currentPath={currentPath}
        />
      </Box>

      {/* Issues Panel */}
      <IssuesPanel
        issues={allIssues}
        isOpen={showIssuesPanel}
        onClose={() => setShowIssuesPanel(false)}
        onIssueClick={(issue) => console.log('Selected issue:', issue)}
        onNavigateToComponent={(componentId) => navigateToLevel(componentId)}
      />

      {/* Component Details Panel */}
      <ComponentDetailsPanel
        component={selectedComponent}
        isOpen={showDetailsPanel}
        onClose={() => setShowDetailsPanel(false)}
      />
    </Container>
  );

  // Get detailed technical information for a component
  function getComponentDetails(nodeId: string) {
    const componentMap: { [key: string]: any } = {
      'database-service': {
        id: 'database-service',
        name: 'PostgreSQL Database',
        description: 'Primary application database handling user data, authentication, and system configurations.',
        type: 'Database Service',
        codeDetails: {
          filePath: '/src/database/connection.ts',
          language: 'TypeScript',
          linesOfCode: 150,
          functions: [
            {
              name: 'createConnection',
              parameters: ['config: DatabaseConfig'],
              returnType: 'Promise<Connection>',
              description: 'Establishes database connection with retry logic'
            },
            {
              name: 'executeQuery',
              parameters: ['query: string', 'params: any[]'],
              returnType: 'Promise<QueryResult>',
              description: 'Executes parameterized SQL queries with error handling'
            }
          ],
          variables: [
            { name: 'connectionPool', type: 'Pool', scope: 'global' },
            { name: 'maxConnections', type: 'number', scope: 'global', value: '20' },
            { name: 'queryTimeout', type: 'number', scope: 'global', value: '30000' }
          ],
          classes: []
        },
        databaseDetails: {
          type: 'postgres' as const,
          connectionString: 'postgresql://user:pass@localhost:5432/unravl_db',
          schemas: [
            {
              name: 'public',
              tables: [
                {
                  name: 'users',
                  columns: [
                    { name: 'id', type: 'uuid', nullable: false, primaryKey: true },
                    { name: 'email', type: 'varchar(255)', nullable: false },
                    { name: 'password_hash', type: 'varchar(255)', nullable: false },
                    { name: 'created_at', type: 'timestamp', nullable: false }
                  ]
                },
                {
                  name: 'projects',
                  columns: [
                    { name: 'id', type: 'uuid', nullable: false, primaryKey: true },
                    { name: 'name', type: 'varchar(255)', nullable: false },
                    { name: 'owner_id', type: 'uuid', nullable: false },
                    { name: 'analysis_data', type: 'jsonb', nullable: true }
                  ]
                }
              ]
            }
          ],
          queries: [
            'SELECT * FROM users WHERE email = $1',
            'INSERT INTO projects (name, owner_id) VALUES ($1, $2)',
            'UPDATE projects SET analysis_data = $1 WHERE id = $2'
          ]
        },
        endpoints: {
          entry: [
            {
              type: 'tcp' as const,
              path: 'localhost:5432',
              parameters: ['connection_string'],
              authentication: 'password'
            }
          ],
          exit: [
            {
              type: 'file' as const,
              destination: '/var/log/postgresql',
              protocol: 'filesystem'
            }
          ]
        },
        dataFlow: {
          serializers: ['JSON', 'Binary'],
          validators: ['Schema Validation', 'Type Checking'],
          transformers: ['Row Mapping', 'Result Formatting'],
          middleware: ['Connection Pooling', 'Query Logging', 'Error Handling']
        },
        backgroundOps: [
          {
            name: 'Vacuum Analyzer',
            type: 'cron' as const,
            schedule: '0 2 * * *',
            description: 'Analyzes and vacuums database tables for optimal performance'
          },
          {
            name: 'Backup Process',
            type: 'cron' as const,
            schedule: '0 1 * * *',
            description: 'Creates incremental backups of database'
          }
        ]
      },
      'user-api': {
        id: 'user-api',
        name: 'User API Service',
        description: 'REST API handling user management, authentication, and profile operations.',
        type: 'API Service',
        codeDetails: {
          filePath: '/src/api/user-controller.ts',
          language: 'TypeScript',
          linesOfCode: 420,
          functions: [
            {
              name: 'createUser',
              parameters: ['userData: CreateUserRequest'],
              returnType: 'Promise<UserResponse>',
              description: 'Creates new user account with email verification'
            },
            {
              name: 'authenticateUser',
              parameters: ['email: string', 'password: string'],
              returnType: 'Promise<AuthToken>',
              description: 'Authenticates user credentials and issues JWT token'
            },
            {
              name: 'getUserProfile',
              parameters: ['userId: string'],
              returnType: 'Promise<UserProfile>',
              description: 'Retrieves user profile information'
            }
          ],
          variables: [
            { name: 'jwtSecret', type: 'string', scope: 'global' },
            { name: 'passwordSaltRounds', type: 'number', scope: 'global', value: '12' },
            { name: 'sessionTimeout', type: 'number', scope: 'global', value: '3600000' }
          ],
          classes: [
            {
              name: 'UserController',
              methods: ['create', 'authenticate', 'getProfile', 'updateProfile', 'deleteUser'],
              properties: ['userService', 'authService', 'validator']
            }
          ]
        },
        messagingDetails: {
          type: 'rabbitmq' as const,
          publishers: [
            {
              topic: 'user.created',
              messageType: 'UserCreatedEvent',
              frequency: 'on_demand'
            },
            {
              topic: 'user.login',
              messageType: 'UserLoginEvent', 
              frequency: 'real_time'
            }
          ],
          subscribers: [
            {
              topic: 'email.verification.completed',
              handler: 'handleEmailVerification'
            }
          ]
        },
        endpoints: {
          entry: [
            {
              type: 'http' as const,
              path: '/api/users',
              method: 'POST',
              parameters: ['email', 'password', 'name'],
              authentication: 'none'
            },
            {
              type: 'http' as const,
              path: '/api/auth/login',
              method: 'POST',
              parameters: ['email', 'password'],
              authentication: 'none'
            },
            {
              type: 'http' as const,
              path: '/api/users/:id',
              method: 'GET',
              parameters: ['id'],
              authentication: 'jwt'
            }
          ],
          exit: [
            {
              type: 'database' as const,
              destination: 'postgresql://localhost:5432/unravl_db',
              protocol: 'postgres'
            },
            {
              type: 'message' as const,
              destination: 'rabbitmq://localhost:5672',
              protocol: 'amqp'
            }
          ]
        },
        dataFlow: {
          serializers: ['JSON', 'JWT Token Encoder'],
          validators: ['Joi Schema Validation', 'Email Format Validator', 'Password Strength Validator'],
          transformers: ['DTO Mapper', 'Response Formatter', 'Error Transformer'],
          middleware: ['CORS', 'Rate Limiter', 'Authentication', 'Request Logger', 'Error Handler']
        },
        backgroundOps: [
          {
            name: 'Session Cleanup',
            type: 'cron' as const,
            schedule: '*/15 * * * *',
            description: 'Removes expired user sessions from cache'
          },
          {
            name: 'Failed Login Monitor',
            type: 'event' as const,
            description: 'Monitors failed login attempts and triggers security alerts'
          }
        ]
      },
      'auth-service': {
        id: 'auth-service',
        name: 'Authentication Service',
        description: 'Centralized authentication and authorization service handling JWT tokens, OAuth, and session management.',
        type: 'Security Service',
        codeDetails: {
          filePath: '/src/auth/auth-service.ts',
          language: 'TypeScript',
          linesOfCode: 380,
          functions: [
            {
              name: 'generateJWT',
              parameters: ['payload: TokenPayload', 'expiresIn: string'],
              returnType: 'string',
              description: 'Generates signed JWT token with user claims'
            },
            {
              name: 'verifyToken',
              parameters: ['token: string'],
              returnType: 'Promise<TokenPayload>',
              description: 'Verifies and decodes JWT token'
            },
            {
              name: 'refreshToken',
              parameters: ['refreshToken: string'],
              returnType: 'Promise<AuthTokens>',
              description: 'Issues new access token using refresh token'
            }
          ],
          variables: [
            { name: 'JWT_SECRET', type: 'string', scope: 'global' },
            { name: 'ACCESS_TOKEN_EXPIRY', type: 'string', scope: 'global', value: '15m' },
            { name: 'REFRESH_TOKEN_EXPIRY', type: 'string', scope: 'global', value: '7d' }
          ],
          classes: [
            {
              name: 'AuthService',
              methods: ['generateJWT', 'verifyToken', 'refreshToken', 'revokeToken'],
              properties: ['jwtSecret', 'tokenBlacklist', 'oauthProviders']
            }
          ]
        },
        endpoints: {
          entry: [
            {
              type: 'http' as const,
              path: '/auth/token/verify',
              method: 'POST',
              parameters: ['token'],
              authentication: 'none'
            },
            {
              type: 'http' as const,
              path: '/auth/token/refresh',
              method: 'POST',
              parameters: ['refreshToken'],
              authentication: 'refresh_token'
            }
          ],
          exit: [
            {
              type: 'database' as const,
              destination: 'redis://localhost:6379',
              protocol: 'redis'
            }
          ]
        },
        dataFlow: {
          serializers: ['JWT Encoder', 'Base64 Encoder'],
          validators: ['Token Format Validator', 'Expiry Validator', 'Signature Validator'],
          transformers: ['Claims Extractor', 'Token Refresher'],
          middleware: ['Rate Limiting', 'CSRF Protection', 'Token Blacklist Check']
        },
        backgroundOps: [
          {
            name: 'Token Cleanup',
            type: 'cron' as const,
            schedule: '0 */6 * * *',
            description: 'Removes expired tokens from blacklist'
          }
        ]
      }
    };
    
    return componentMap[nodeId] || null;
  }
};