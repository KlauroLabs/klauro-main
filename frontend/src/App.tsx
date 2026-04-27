import React, { useState, useEffect } from 'react';
import InteractiveCardSystem from './components/InteractiveCardSystem';
import { getApiUrl } from './config/api';
import './App.css';

interface AppProps {}

const App: React.FC<AppProps> = () => {
  const [nodes, setNodes] = useState<any[]>([]);
  const [connections, setConnections] = useState<any[]>([]);
  const [telemetry, setTelemetry] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadArchitectureData();
    return setupTelemetryStream();
  }, []);

  const loadArchitectureData = async () => {
    try {
      setLoading(true);

      const nodesResponse = await fetch(getApiUrl('/api/architecture/nodes'));
      const nodesData = await nodesResponse.json();

      const connectionsResponse = await fetch(getApiUrl('/api/architecture/connections'));
      const connectionsData = await connectionsResponse.json();
      
      setNodes(nodesData.nodes || []);
      setConnections(connectionsData.connections || []);
      
      setLoading(false);
    } catch (err) {
      console.error('Failed to load architecture data:', err);
      setError('Failed to load architecture data');
      setLoading(false);
    }
  };

  const setupTelemetryStream = () => {
    const eventSource = new EventSource(getApiUrl('/api/architecture/telemetry/stream'));
    
    eventSource.addEventListener('telemetry', (event) => {
      const data = JSON.parse(event.data);
      setTelemetry(prev => [...prev.slice(-99), data]); // Keep last 100 telemetry items
    });

    eventSource.onerror = (error) => {
      console.error('Telemetry stream error:', error);
    };

    return () => {
      eventSource.close();
    };
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
        <button onClick={loadArchitectureData}>Retry</button>
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
