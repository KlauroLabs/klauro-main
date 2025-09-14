import React, { useState, useEffect } from 'react';
import InteractiveCardSystem from './components/InteractiveCardSystem';
import './App.css';

interface AppProps {}

const App: React.FC<AppProps> = () => {
  const [nodes, setNodes] = useState<any[]>([]);
  const [connections, setConnections] = useState<any[]>([]);
  const [telemetry, setTelemetry] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSpatialData();
    setupTelemetryStream();
  }, []);

  const loadSpatialData = async () => {
    try {
      setLoading(true);
      
      // Fetch nodes
      const nodesResponse = await fetch('http://localhost:3000/api/spatial/nodes');
      const nodesData = await nodesResponse.json();
      
      // Fetch connections
      const connectionsResponse = await fetch('http://localhost:3000/api/spatial/connections');
      const connectionsData = await connectionsResponse.json();
      
      setNodes(nodesData.nodes || []);
      setConnections(connectionsData.connections || []);
      
      setLoading(false);
    } catch (err) {
      console.error('Failed to load spatial data:', err);
      setError('Failed to load architecture data');
      setLoading(false);
      
      // Load sample data as fallback
      loadSampleData();
    }
  };

  const setupTelemetryStream = () => {
    // Set up SSE connection for real-time telemetry
    const eventSource = new EventSource('http://localhost:3000/api/spatial/telemetry/stream');
    
    eventSource.addEventListener('telemetry', (event) => {
      const data = JSON.parse(event.data);
      setTelemetry(prev => [...prev.slice(-99), data]); // Keep last 100 telemetry items
    });

    eventSource.onerror = (error) => {
      console.error('Telemetry stream error:', error);
      // Fallback to simulated telemetry
      simulateTelemetry();
    };

    return () => {
      eventSource.close();
    };
  };

  const simulateTelemetry = () => {
    // Simulate telemetry data for demo purposes
    setInterval(() => {
      const simulatedData = {
        nodeId: `node-${Math.floor(Math.random() * 10)}`,
        metric: ['cpu', 'memory', 'responseTime', 'errorRate'][Math.floor(Math.random() * 4)],
        value: Math.random() * 100,
        timestamp: Date.now(),
        status: Math.random() > 0.8 ? 'warning' : Math.random() > 0.95 ? 'error' : 'healthy'
      };
      setTelemetry(prev => [...prev.slice(-99), simulatedData]);
    }, 2000);
  };

  const loadSampleData = () => {
    // Sample data for demonstration
    const sampleNodes = [
      {
        id: 'system-root',
        type: 'system',
        name: 'Unravl Platform',
        description: 'Interactive architecture visualization platform',
        level: 0,
        position: { x: 400, y: 50 },
        size: { width: 400, height: 250 },
        metrics: {
          complexity: 85,
          dependencies: 42,
          calls: 1250,
          lines: 15000
        },
        children: ['service-backend', 'service-frontend', 'service-analyzer'],
        entryPoints: [
          {
            id: 'ep-1',
            type: 'http',
            path: '/api/analyze',
            method: 'POST',
            description: 'Main analysis endpoint'
          }
        ],
        exitPoints: [
          {
            id: 'ex-1',
            type: 'database',
            target: 'PostgreSQL',
            operation: 'read/write',
            description: 'Main data store'
          }
        ],
        metadata: {
          language: 'TypeScript',
          framework: 'NestJS',
          pattern: 'microservices'
        }
      },
      {
        id: 'service-backend',
        type: 'service',
        name: 'Backend Service',
        description: 'Core API and business logic service',
        level: 1,
        position: { x: 150, y: 350 },
        size: { width: 300, height: 200 },
        metrics: {
          complexity: 65,
          dependencies: 25,
          calls: 850,
          lines: 8000
        },
        children: ['component-auth', 'component-analyzer', 'component-telemetry'],
        parent: 'system-root',
        entryPoints: [
          {
            id: 'ep-2',
            type: 'http',
            path: '/api/*',
            method: 'ALL',
            description: 'REST API endpoints'
          }
        ],
        exitPoints: [
          {
            id: 'ex-2',
            type: 'database',
            target: 'PostgreSQL',
            operation: 'query',
            description: 'Database queries'
          }
        ],
        metadata: {
          port: 3000,
          protocol: 'HTTP/REST'
        }
      },
      {
        id: 'service-frontend',
        type: 'service',
        name: 'Frontend Service',
        description: 'React-based web application',
        level: 1,
        position: { x: 500, y: 350 },
        size: { width: 300, height: 200 },
        metrics: {
          complexity: 45,
          dependencies: 30,
          calls: 400,
          lines: 5000
        },
        children: ['component-ui', 'component-visualization', 'component-state'],
        parent: 'system-root',
        entryPoints: [
          {
            id: 'ep-3',
            type: 'ui',
            description: 'Web browser interface'
          }
        ],
        exitPoints: [
          {
            id: 'ex-3',
            type: 'api',
            target: 'Backend Service',
            operation: 'REST calls',
            description: 'API requests'
          }
        ],
        metadata: {
          framework: 'React',
          port: 3001
        }
      },
      {
        id: 'service-analyzer',
        type: 'service',
        name: 'Code Analyzer',
        description: 'AST-based code analysis engine',
        level: 1,
        position: { x: 850, y: 350 },
        size: { width: 300, height: 200 },
        metrics: {
          complexity: 75,
          dependencies: 15,
          calls: 200,
          lines: 6000
        },
        children: ['component-parser', 'component-patterns', 'component-metrics'],
        parent: 'system-root',
        entryPoints: [],
        exitPoints: [],
        metadata: {
          languages: ['TypeScript', 'Python', 'Java', 'Go']
        }
      },
      {
        id: 'component-auth',
        type: 'component',
        name: 'Authentication',
        description: 'User authentication and authorization',
        level: 2,
        position: { x: 50, y: 600 },
        size: { width: 200, height: 150 },
        metrics: {
          complexity: 25,
          dependencies: 5,
          calls: 150,
          lines: 1200
        },
        children: [],
        parent: 'service-backend',
        entryPoints: [],
        exitPoints: [],
        metadata: {
          methods: [
            { name: 'login', parameters: ['username', 'password'] },
            { name: 'logout', parameters: [] },
            { name: 'validateToken', parameters: ['token'] }
          ]
        }
      },
      {
        id: 'component-ui',
        type: 'component',
        name: 'UI Components',
        description: 'Reusable React components',
        level: 2,
        position: { x: 450, y: 600 },
        size: { width: 200, height: 150 },
        metrics: {
          complexity: 20,
          dependencies: 12,
          calls: 300,
          lines: 2000
        },
        children: [],
        parent: 'service-frontend',
        entryPoints: [],
        exitPoints: [],
        metadata: {
          components: ['InteractiveCardSystem', 'NavigationBar', 'Dashboard']
        }
      }
    ];

    const sampleConnections = [
      {
        id: 'conn-1',
        source: 'service-frontend',
        target: 'service-backend',
        type: 'api-call',
        label: 'REST API',
        strength: 5,
        metadata: {
          frequency: 100,
          latency: 50,
          protocol: 'https'
        }
      },
      {
        id: 'conn-2',
        source: 'service-backend',
        target: 'service-analyzer',
        type: 'dependency',
        label: 'Analysis',
        strength: 3,
        metadata: {
          frequency: 20,
          latency: 200
        }
      },
      {
        id: 'conn-3',
        source: 'component-auth',
        target: 'component-ui',
        type: 'data-flow',
        label: 'User data',
        strength: 2,
        metadata: {
          dataType: 'UserProfile'
        }
      }
    ];

    setNodes(sampleNodes);
    setConnections(sampleConnections);
  };

  const handleNodeClick = (node: any) => {
    console.log('Node clicked:', node);
    // Could open detailed view, trigger analysis, etc.
  };

  const handleConnectionClick = (connection: any) => {
    console.log('Connection clicked:', connection);
    // Could show connection details, traffic patterns, etc.
  };

  if (loading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner"></div>
        <p>Loading architecture visualization...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app-error">
        <h2>Error</h2>
        <p>{error}</p>
        <button onClick={loadSpatialData}>Retry</button>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Unravl - Architecture Visualization</h1>
        <p className="tagline">Your codebase as a living, breathing blueprint</p>
      </header>
      
      <main className="app-main">
        <InteractiveCardSystem
          nodes={nodes}
          connections={connections}
          telemetry={telemetry}
          onNodeClick={handleNodeClick}
          onConnectionClick={handleConnectionClick}
        />
      </main>
      
      <footer className="app-footer">
        <div className="status-bar">
          <span className="status-item">
            Nodes: {nodes.length}
          </span>
          <span className="status-item">
            Connections: {connections.length}
          </span>
          <span className="status-item">
            Telemetry: {telemetry.length} events
          </span>
        </div>
      </footer>
    </div>
  );
};

export default App;