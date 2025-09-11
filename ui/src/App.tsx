import React, { useState, useEffect } from 'react';
import './App.css';
import ArchitectureView from './ArchitectureView';
import BlueprintView from './BlueprintView';
import FlowMapView from './FlowMapView';
import ExplorerView from './ExplorerView';
import ExplorerRouterView from './ExplorerRouterView';
import AnalysisViewer from './AnalysisViewer';
import AnalysesList from './AnalysesList';
import Graph from './Graph';
import ERD from './ERD';
import { ArchitectureBlueprint, AnalysisRequest, GraphData } from './types';
import { analysisApi } from './api';
import { Route, Routes } from 'react-router';
import { Link, useNavigate } from 'react-router-dom';
import { generateAnalysisId } from './utils/uuid';

const App: React.FC = () => {
  const navigate = useNavigate();
  const [blueprint, setBlueprint] = useState<ArchitectureBlueprint | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repositoryPath, setRepositoryPath] = useState<string>('');
  const [currentAnalysisId, setCurrentAnalysisId] = useState<string | null>(null);
  
  // Legacy graph data for backward compatibility
  const [graphData, setGraphData] = useState<GraphData>({
    nodes: [],
    edges: [],
    metadata: {
      framework: '',
      depth: 0,
      erd: { models: [], relationships: [] }
    }
  });

  // Load legacy data on mount
  useEffect(() => {
    fetch('/code_analysis.json')
      .then(response => response.json())
      .then(data => setGraphData(data))
      .catch(err => console.log('No legacy data found'));
  }, []);

  const handleAnalyzeRepository = async () => {
    if (!repositoryPath.trim()) {
      setError('Please enter a repository path');
      return;
    }

    setIsLoading(true);
    setError(null);
    
    try {
      const request: AnalysisRequest = {
        repositoryPath: repositoryPath.trim(),
        options: {
          includeTests: false,
          maxDepth: 10
        }
      };

      console.log('Analyzing repository:', request);
      const response = await analysisApi.analyzeRepository(request);
      
      if (response.success && response.blueprint) {
        // Generate analysis ID and save to localStorage
        const analysisId = generateAnalysisId(response.blueprint);
        const analysisData = {
          id: analysisId,
          name: extractProjectName(repositoryPath) || `Analysis ${Date.now()}`,
          timestamp: Date.now(),
          blueprint: response.blueprint,
          repositoryPath: repositoryPath.trim()
        };

        // Save to localStorage
        const existingAnalyses = JSON.parse(localStorage.getItem('unravl-analyses') || '[]');
        const updatedAnalyses = [analysisData, ...existingAnalyses.slice(0, 9)]; // Keep last 10
        localStorage.setItem('unravl-analyses', JSON.stringify(updatedAnalyses));

        setBlueprint(response.blueprint);
        setCurrentAnalysisId(analysisId);
        console.log('Analysis successful:', response.blueprint);
        
        // Redirect to analysis page
        navigate(`/analysis/${analysisId}/overview`);
      } else {
        setError(response.error || 'Analysis failed');
      }
    } catch (err) {
      console.error('Analysis error:', err);
      setError(err instanceof Error ? err.message : 'Failed to analyze repository');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearAnalysis = () => {
    setBlueprint(null);
    setError(null);
    setRepositoryPath('');
    setCurrentAnalysisId(null);
  };

  // Helper function to extract project name
  const extractProjectName = (path: string): string => {
    if (!path) return '';
    const parts = path.replace(/\/$/, '').split('/');
    return parts[parts.length - 1] || parts[parts.length - 2] || '';
  };

  return (
    <div className="App">
      <header style={{ 
        background: '#2196F3', 
        color: 'white', 
        padding: '20px',
        marginBottom: '20px'
      }}>
        <h1>🗺️ Unravl Architecture Visualizer</h1>
        <p>Transform your codebase into interactive architecture diagrams</p>
      </header>

      <div style={{ padding: '0 20px' }}>
        <Routes>
          {/* Analysis-specific routes */}
          <Route path="/analysis/:analysisId/*" element={<AnalysisViewer />} />
          <Route path="/analyses" element={<AnalysesList />} />
          
          <Route path="/" element={
            <div>
              {/* Repository Analysis Section */}
              <div style={{ 
                background: '#f5f5f5', 
                padding: '20px', 
                borderRadius: '8px', 
                marginBottom: '20px' 
              }}>
                <h2>🔍 Analyze Repository</h2>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '15px' }}>
                  <input
                    type="text"
                    placeholder="Enter repository path (e.g., /path/to/your/project)"
                    value={repositoryPath}
                    onChange={(e) => setRepositoryPath(e.target.value)}
                    style={{
                      flex: 1,
                      padding: '10px',
                      border: '1px solid #ddd',
                      borderRadius: '4px',
                      fontSize: '14px'
                    }}
                    onKeyPress={(e) => e.key === 'Enter' && handleAnalyzeRepository()}
                  />
                  <button
                    onClick={handleAnalyzeRepository}
                    disabled={isLoading}
                    style={{
                      padding: '10px 20px',
                      backgroundColor: isLoading ? '#ccc' : '#4CAF50',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: isLoading ? 'not-allowed' : 'pointer',
                      fontSize: '14px'
                    }}
                  >
                    {isLoading ? 'Analyzing...' : 'Analyze'}
                  </button>
                  
                  {blueprint && (
                    <button
                      onClick={handleClearAnalysis}
                      style={{
                        padding: '10px 15px',
                        backgroundColor: '#f44336',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '14px'
                      }}
                    >
                      Clear
                    </button>
                  )}
                </div>
                
                {error && (
                  <div style={{ 
                    background: '#ffebee', 
                    color: '#c62828', 
                    padding: '10px', 
                    borderRadius: '4px',
                    border: '1px solid #ffcdd2'
                  }}>
                    ❌ {error}
                  </div>
                )}
                
                {isLoading && (
                  <div style={{ 
                    background: '#e3f2fd', 
                    color: '#1976d2', 
                    padding: '10px', 
                    borderRadius: '4px',
                    border: '1px solid #bbdefb'
                  }}>
                    🔄 Analyzing repository... This may take a few moments.
                  </div>
                )}
              </div>

              {/* Architecture Visualization */}
              {blueprint ? (
                <div>
                  <h2>🏗️ Architecture Blueprint</h2>
                  <div style={{ 
                    background: 'white', 
                    border: '1px solid #ddd', 
                    borderRadius: '8px',
                    marginBottom: '20px'
                  }}>
                    <ExplorerRouterView blueprint={blueprint} />
                  </div>
                  
                  <div style={{ 
                    background: '#f9f9f9', 
                    padding: '15px', 
                    borderRadius: '8px',
                    fontSize: '14px'
                  }}>
                    <strong>Analysis Summary:</strong> Found {blueprint.metadata.totalComponents} components 
                    in {blueprint.framework} project. Processing time: {Date.now() - Date.now()}ms
                  </div>
                </div>
              ) : (
                <div style={{ 
                  textAlign: 'center', 
                  padding: '40px', 
                  color: '#666',
                  background: '#fafafa',
                  borderRadius: '8px'
                }}>
                  <h3>👆 Enter a repository path above to get started</h3>
                  <p>Point to a Node.js/Express project directory to visualize its architecture.</p>
                  <div style={{ marginTop: '20px', fontSize: '12px' }}>
                    <strong>Example paths:</strong><br/>
                    <code>/Users/yourname/projects/my-express-app</code><br/>
                    <code>./my-project</code><br/>
                    <code>/path/to/backend</code>
                  </div>
                </div>
              )}
            </div>
          } />
          
          {/* Explorer routes with deep linking */}
          <Route path="/explorer/:view" element={
            blueprint ? (
              <div style={{ 
                background: 'white', 
                border: '1px solid #ddd', 
                borderRadius: '8px'
              }}>
                <ExplorerRouterView blueprint={blueprint} />
              </div>
            ) : (
              <div>No blueprint data available</div>
            )
          } />
          <Route path="/explorer/category/:category" element={
            blueprint ? (
              <div style={{ 
                background: 'white', 
                border: '1px solid #ddd', 
                borderRadius: '8px'
              }}>
                <ExplorerRouterView blueprint={blueprint} />
              </div>
            ) : (
              <div>No blueprint data available</div>
            )
          } />
          <Route path="/explorer/component/:componentId" element={
            blueprint ? (
              <div style={{ 
                background: 'white', 
                border: '1px solid #ddd', 
                borderRadius: '8px'
              }}>
                <ExplorerRouterView blueprint={blueprint} />
              </div>
            ) : (
              <div>No blueprint data available</div>
            )
          } />

          {/* Legacy routes */}
          <Route path="/legacy" element={<Graph graphData={graphData} />} />
          <Route path="/erd" element={<ERD erdData={graphData.metadata.erd} />} />
          <Route path="/flows" element={
            blueprint ? (
              <div style={{ 
                background: 'white', 
                border: '1px solid #ddd', 
                borderRadius: '8px'
              }}>
                <FlowMapView blueprint={blueprint} />
              </div>
            ) : (
              <div>No blueprint data available</div>
            )
          } />
          <Route path="/blueprint" element={
            blueprint ? (
              <div style={{ 
                background: 'white', 
                border: '1px solid #ddd', 
                borderRadius: '8px'
              }}>
                <BlueprintView blueprint={blueprint} />
              </div>
            ) : (
              <div>No blueprint data available</div>
            )
          } />
          <Route path="/network" element={
            blueprint ? (
              <div style={{ 
                background: 'white', 
                border: '1px solid #ddd', 
                borderRadius: '8px'
              }}>
                <ArchitectureView blueprint={blueprint} />
              </div>
            ) : (
              <div>No blueprint data available</div>
            )
          } />
        </Routes>

        {/* Navigation */}
        <div style={{ 
          marginTop: '30px', 
          padding: '20px', 
          borderTop: '1px solid #ddd',
          display: 'flex',
          gap: '15px',
          justifyContent: 'center'
        }}>
          <Link 
            to="/" 
            style={{ 
              padding: '10px 15px', 
              backgroundColor: '#2196F3', 
              color: 'white', 
              textDecoration: 'none', 
              borderRadius: '4px' 
            }}
          >
            🧭 Code Explorer
          </Link>
          <Link 
            to="/flows" 
            style={{ 
              padding: '10px 15px', 
              backgroundColor: '#FF5722', 
              color: 'white', 
              textDecoration: 'none', 
              borderRadius: '4px' 
            }}
          >
            🗺️ Flow Map
          </Link>
          <Link 
            to="/blueprint" 
            style={{ 
              padding: '10px 15px', 
              backgroundColor: '#4CAF50', 
              color: 'white', 
              textDecoration: 'none', 
              borderRadius: '4px' 
            }}
          >
            🏠 Blueprint View
          </Link>
          <Link 
            to="/network" 
            style={{ 
              padding: '10px 15px', 
              backgroundColor: '#FF9800', 
              color: 'white', 
              textDecoration: 'none', 
              borderRadius: '4px' 
            }}
          >
            🕸️ Network View
          </Link>
          <Link 
            to="/legacy" 
            style={{ 
              padding: '10px 15px', 
              backgroundColor: '#607D8B', 
              color: 'white', 
              textDecoration: 'none', 
              borderRadius: '4px' 
            }}
          >
            📊 Legacy Graph
          </Link>
          <Link 
            to="/erd" 
            style={{ 
              padding: '10px 15px', 
              backgroundColor: '#4CAF50', 
              color: 'white', 
              textDecoration: 'none', 
              borderRadius: '4px' 
            }}
          >
            🗂️ ERD View
          </Link>
          <Link 
            to="/analyses" 
            style={{ 
              padding: '10px 15px', 
              backgroundColor: '#9C27B0', 
              color: 'white', 
              textDecoration: 'none', 
              borderRadius: '4px' 
            }}
          >
            📁 All Analyses
          </Link>
        </div>
      </div>
    </div>
  );
};

export default App;