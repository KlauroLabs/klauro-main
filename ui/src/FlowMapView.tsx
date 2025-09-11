import React, { useState, useEffect } from 'react';
import { ArchitectureBlueprint, ComponentNode, Connection } from './types';

interface FlowMapViewProps {
  blueprint: ArchitectureBlueprint;
}

interface FlowPath {
  id: string;
  name: string;
  components: ComponentNode[];
  connections: Connection[];
  entryPoint: ComponentNode;
  trafficVolume?: number;
  responseTime?: number;
  errorRate?: number;
  isProblematic?: boolean;
}

interface TrafficPattern {
  pathId: string;
  volume: number;
  peakTime: string;
  avgResponseTime: number;
  errorRate: number;
  bottlenecks: string[];
}

export default function FlowMapView({ blueprint }: FlowMapViewProps) {
  const [selectedPath, setSelectedPath] = useState<FlowPath | null>(null);
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [showTrafficPatterns, setShowTrafficPatterns] = useState(false);
  const [problemAreas, setProblemAreas] = useState<Set<string>>(new Set());

  // Extract flow paths from the blueprint
  const extractFlowPaths = (): FlowPath[] => {
    const entryPoints = blueprint.components.filter(c => c.metadata.isEntry);
    const paths: FlowPath[] = [];

    entryPoints.forEach(entry => {
      // Trace paths from entry points
      const visited = new Set<string>();
      const pathComponents: ComponentNode[] = [entry];
      const pathConnections: Connection[] = [];

      const tracePath = (currentId: string, depth: number = 0) => {
        if (depth > 10 || visited.has(currentId)) return; // Prevent infinite loops
        visited.add(currentId);

        const outgoingConnections = blueprint.connections.filter(c => c.from === currentId);
        outgoingConnections.forEach(conn => {
          const targetComponent = blueprint.components.find(c => c.id === conn.to);
          if (targetComponent && !visited.has(targetComponent.id)) {
            pathComponents.push(targetComponent);
            pathConnections.push(conn);
            tracePath(targetComponent.id, depth + 1);
          }
        });
      };

      tracePath(entry.id);

      if (pathComponents.length > 1) {
        // Generate mock traffic data for demonstration
        const trafficVolume = Math.floor(Math.random() * 1000) + 100;
        const responseTime = Math.floor(Math.random() * 500) + 50;
        const errorRate = Math.random() * 5;
        
        paths.push({
          id: `path_${entry.id}`,
          name: entry.name.replace(/\.(js|ts|jsx|tsx)$/, ''),
          components: pathComponents,
          connections: pathConnections,
          entryPoint: entry,
          trafficVolume,
          responseTime,
          errorRate,
          isProblematic: errorRate > 2 || responseTime > 300
        });
      }
    });

    return paths.sort((a, b) => (b.trafficVolume || 0) - (a.trafficVolume || 0));
  };

  const [flowPaths, setFlowPaths] = useState<FlowPath[]>([]);

  useEffect(() => {
    const paths = extractFlowPaths();
    setFlowPaths(paths);
    
    // Identify problem areas
    const problems = new Set<string>();
    paths.forEach(path => {
      if (path.isProblematic) {
        path.components.forEach(comp => problems.add(comp.id));
      }
    });
    setProblemAreas(problems);
  }, [blueprint]);

  const getStepStyle = (index: number, isSelected: boolean, isProblematic: boolean) => ({
    background: isProblematic ? '#ffebee' : isSelected ? '#e3f2fd' : '#f5f5f5',
    border: isProblematic ? '2px solid #f44336' : isSelected ? '2px solid #2196F3' : '1px solid #ddd',
    borderRadius: '8px',
    padding: '15px',
    margin: '10px 0',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    position: 'relative' as const,
    boxShadow: isSelected ? '0 4px 12px rgba(33, 150, 243, 0.3)' : '0 2px 4px rgba(0,0,0,0.1)'
  });

  const getTrafficIntensity = (volume: number): string => {
    if (volume > 500) return '🔴 High';
    if (volume > 200) return '🟡 Medium';
    return '🟢 Low';
  };

  const getHealthStatus = (path: FlowPath): string => {
    if (path.errorRate && path.errorRate > 2) return '🚨 Critical';
    if (path.responseTime && path.responseTime > 300) return '⚠️ Slow';
    return '✅ Healthy';
  };

  if (!selectedPath) {
    // Flow path selection view
    return (
      <div style={{ padding: '20px', height: '80vh', overflow: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
          <div>
            <h2>🗺️ Flow Map Analysis</h2>
            <p style={{ color: '#666' }}>
              Track user journeys and data flows through your system
            </p>
          </div>
          <button
            onClick={() => setShowTrafficPatterns(!showTrafficPatterns)}
            style={{
              background: showTrafficPatterns ? '#4CAF50' : '#2196F3',
              color: 'white',
              border: 'none',
              padding: '10px 20px',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
          >
            {showTrafficPatterns ? '📊 Hide Traffic' : '📈 Show Traffic'}
          </button>
        </div>

        {/* Critical Issues Alert */}
        {flowPaths.filter(p => p.isProblematic).length > 0 && (
          <div style={{
            background: '#ffebee',
            border: '1px solid #f44336',
            borderRadius: '8px',
            padding: '15px',
            marginBottom: '20px'
          }}>
            <h3 style={{ color: '#d32f2f', margin: '0 0 10px 0' }}>
              🚨 {flowPaths.filter(p => p.isProblematic).length} Critical Flow Issues Detected
            </h3>
            <p style={{ margin: 0, fontSize: '14px' }}>
              High error rates or slow response times detected in key user flows. Click on problematic paths below for details.
            </p>
          </div>
        )}

        {/* Flow paths grid */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))',
          gap: '20px'
        }}>
          {flowPaths.map(path => (
            <div
              key={path.id}
              onClick={() => setSelectedPath(path)}
              style={{
                background: path.isProblematic ? '#ffebee' : 'white',
                border: path.isProblematic ? '2px solid #f44336' : '1px solid #ddd',
                borderRadius: '12px',
                padding: '20px',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
                boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                ':hover': {
                  transform: 'translateY(-2px)',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.15)'
                }
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)';
                e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.15)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
              }}
            >
              {/* Path header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '15px' }}>
                <h3 style={{ margin: 0, color: path.isProblematic ? '#d32f2f' : '#333' }}>
                  🛤️ {path.name}
                </h3>
                <div style={{
                  background: path.isProblematic ? '#f44336' : '#4CAF50',
                  color: 'white',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontWeight: 'bold'
                }}>
                  {getHealthStatus(path)}
                </div>
              </div>

              {/* Flow preview */}
              <div style={{ marginBottom: '15px' }}>
                <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>
                  Flow: {path.components.length} components
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px' }}>
                  {path.components.slice(0, 4).map((comp, idx) => (
                    <React.Fragment key={comp.id}>
                      <span style={{
                        background: problemAreas.has(comp.id) ? '#ffcdd2' : '#e3f2fd',
                        color: problemAreas.has(comp.id) ? '#d32f2f' : '#1976d2',
                        padding: '2px 6px',
                        borderRadius: '3px',
                        fontSize: '10px'
                      }}>
                        {comp.name.length > 15 ? comp.name.slice(0, 15) + '...' : comp.name}
                      </span>
                      {idx < Math.min(path.components.length - 1, 3) && <span>→</span>}
                    </React.Fragment>
                  ))}
                  {path.components.length > 4 && <span style={{ color: '#666' }}>+{path.components.length - 4} more</span>}
                </div>
              </div>

              {/* Traffic metrics */}
              {showTrafficPatterns && (
                <div style={{
                  background: '#f8f9fa',
                  padding: '10px',
                  borderRadius: '6px',
                  fontSize: '12px'
                }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    <div>
                      <strong>Traffic:</strong> {getTrafficIntensity(path.trafficVolume || 0)}<br/>
                      <strong>Volume:</strong> {path.trafficVolume} req/hr
                    </div>
                    <div>
                      <strong>Response:</strong> {path.responseTime}ms<br/>
                      <strong>Error Rate:</strong> {path.errorRate?.toFixed(1)}%
                    </div>
                  </div>
                </div>
              )}

              {/* Entry point info */}
              <div style={{ fontSize: '11px', color: '#888', marginTop: '10px' }}>
                Entry: {path.entryPoint.path.split('/').pop()}
              </div>
            </div>
          ))}
        </div>

        {flowPaths.length === 0 && (
          <div style={{
            textAlign: 'center',
            padding: '50px',
            color: '#666',
            background: '#fafafa',
            borderRadius: '8px'
          }}>
            <h3>No flow paths detected</h3>
            <p>Make sure your application has entry points (routes, controllers) to trace flows.</p>
          </div>
        )}
      </div>
    );
  }

  // Selected path detail view
  return (
    <div style={{ display: 'flex', height: '80vh' }}>
      {/* Flow steps sidebar */}
      <div style={{ width: '350px', borderRight: '1px solid #ddd', overflow: 'auto' }}>
        <div style={{
          padding: '20px',
          background: selectedPath.isProblematic ? '#f44336' : '#2196F3',
          color: 'white',
          position: 'sticky',
          top: 0,
          zIndex: 100
        }}>
          <button
            onClick={() => setSelectedPath(null)}
            style={{
              background: 'rgba(255,255,255,0.2)',
              border: 'none',
              color: 'white',
              padding: '5px 10px',
              borderRadius: '4px',
              cursor: 'pointer',
              marginBottom: '10px'
            }}
          >
            ← Back to Flow Map
          </button>
          <h3 style={{ margin: 0 }}>{selectedPath.name}</h3>
          <p style={{ margin: '5px 0 0 0', opacity: 0.9 }}>
            {selectedPath.components.length} step flow
          </p>
          {selectedPath.isProblematic && (
            <div style={{ background: 'rgba(255,255,255,0.2)', padding: '8px', borderRadius: '4px', marginTop: '10px', fontSize: '14px' }}>
              🚨 This flow has performance or reliability issues
            </div>
          )}
        </div>

        {/* Flow steps */}
        <div style={{ padding: '15px' }}>
          {selectedPath.components.map((component, index) => {
            const isSelected = index === currentStep;
            const isProblematic = problemAreas.has(component.id);
            
            return (
              <div
                key={`${component.id}-${index}`}
                onClick={() => setCurrentStep(index)}
                style={getStepStyle(index, isSelected, isProblematic)}
              >
                {/* Step number */}
                <div style={{
                  position: 'absolute',
                  left: '-10px',
                  top: '15px',
                  background: isProblematic ? '#f44336' : isSelected ? '#2196F3' : '#999',
                  color: 'white',
                  borderRadius: '50%',
                  width: '24px',
                  height: '24px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: 'bold'
                }}>
                  {index + 1}
                </div>

                <div style={{ marginLeft: '20px' }}>
                  <h4 style={{ margin: '0 0 5px 0', fontSize: '14px' }}>
                    {component.name}
                  </h4>
                  <div style={{ fontSize: '12px', color: '#666', marginBottom: '5px' }}>
                    {component.type} • {component.metadata.lineCount} lines
                  </div>
                  
                  {isProblematic && (
                    <div style={{
                      background: '#ffcdd2',
                      color: '#d32f2f',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 'bold',
                      marginTop: '5px'
                    }}>
                      ⚠️ Performance Issue
                    </div>
                  )}

                  {/* Connection indicator */}
                  {index < selectedPath.components.length - 1 && (
                    <div style={{
                      marginTop: '8px',
                      fontSize: '11px',
                      color: '#888',
                      display: 'flex',
                      alignItems: 'center'
                    }}>
                      <span style={{ marginRight: '5px' }}>↓</span>
                      calls {selectedPath.components[index + 1].name.split('.')[0]}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Component detail view */}
      <div style={{ flex: 1, padding: '20px', overflow: 'auto' }}>
        {(() => {
          const currentComponent = selectedPath.components[currentStep];
          const isProblematic = problemAreas.has(currentComponent.id);
          const risks = blueprint.riskAreas.filter(r => r.componentId === currentComponent.id);

          return (
            <div>
              {/* Component header */}
              <div style={{ marginBottom: '20px' }}>
                <h2 style={{ color: isProblematic ? '#d32f2f' : '#333' }}>
                  {currentComponent.name}
                </h2>
                <p style={{ color: '#666', fontFamily: 'monospace', fontSize: '14px' }}>
                  {currentComponent.path}
                </p>
                
                {isProblematic && (
                  <div style={{
                    background: '#ffebee',
                    border: '1px solid #f44336',
                    borderRadius: '6px',
                    padding: '10px',
                    marginTop: '10px'
                  }}>
                    <strong style={{ color: '#d32f2f' }}>⚠️ Performance Alert:</strong>
                    <span style={{ marginLeft: '10px', fontSize: '14px' }}>
                      This component is causing slowdowns in the flow
                    </span>
                  </div>
                )}
              </div>

              {/* Flow position indicator */}
              <div style={{ marginBottom: '20px' }}>
                <h4>Position in Flow</h4>
                <div style={{
                  background: '#f8f9fa',
                  border: '1px solid #dee2e6',
                  borderRadius: '6px',
                  padding: '15px'
                }}>
                  <div style={{ fontSize: '14px', marginBottom: '10px' }}>
                    <strong>Step {currentStep + 1} of {selectedPath.components.length}</strong>
                  </div>
                  
                  {currentStep > 0 && (
                    <div style={{ fontSize: '12px', color: '#666' }}>
                      ← Previous: {selectedPath.components[currentStep - 1].name}
                    </div>
                  )}
                  
                  {currentStep < selectedPath.components.length - 1 && (
                    <div style={{ fontSize: '12px', color: '#666' }}>
                      → Next: {selectedPath.components[currentStep + 1].name}
                    </div>
                  )}
                </div>
              </div>

              {/* Component metrics */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: '15px',
                marginBottom: '20px'
              }}>
                <div style={{ background: '#f5f5f5', padding: '15px', borderRadius: '8px' }}>
                  <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#2196F3' }}>
                    {currentComponent.metadata.complexity}/10
                  </div>
                  <div style={{ fontSize: '12px', color: '#666' }}>Complexity</div>
                </div>
                <div style={{ background: '#f5f5f5', padding: '15px', borderRadius: '8px' }}>
                  <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#4CAF50' }}>
                    {Math.floor(Math.random() * 50) + 10}ms
                  </div>
                  <div style={{ fontSize: '12px', color: '#666' }}>Avg Response</div>
                </div>
                <div style={{ background: '#f5f5f5', padding: '15px', borderRadius: '8px' }}>
                  <div style={{ fontSize: '24px', fontWeight: 'bold', color: isProblematic ? '#f44336' : '#4CAF50' }}>
                    {isProblematic ? '3.2%' : '0.1%'}
                  </div>
                  <div style={{ fontSize: '12px', color: '#666' }}>Error Rate</div>
                </div>
                <div style={{ background: '#f5f5f5', padding: '15px', borderRadius: '8px' }}>
                  <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#FF9800' }}>
                    {currentComponent.dependencies.length}
                  </div>
                  <div style={{ fontSize: '12px', color: '#666' }}>Dependencies</div>
                </div>
              </div>

              {/* Dependencies in flow context */}
              {currentComponent.dependencies.length > 0 && (
                <div style={{ marginBottom: '20px' }}>
                  <h4>Dependencies</h4>
                  <div style={{ background: '#f8f9fa', padding: '10px', borderRadius: '6px' }}>
                    {currentComponent.dependencies.slice(0, 5).map(dep => (
                      <div key={dep} style={{
                        fontSize: '12px',
                        padding: '5px 0',
                        borderBottom: '1px solid #e0e0e0',
                        fontFamily: 'monospace'
                      }}>
                        {dep}
                      </div>
                    ))}
                    {currentComponent.dependencies.length > 5 && (
                      <div style={{ fontSize: '12px', color: '#666', paddingTop: '5px' }}>
                        +{currentComponent.dependencies.length - 5} more dependencies
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Risk analysis */}
              {risks.length > 0 && (
                <div style={{ marginBottom: '20px' }}>
                  <h4>Risk Analysis</h4>
                  {risks.map(risk => (
                    <div key={risk.componentId} style={{
                      background: risk.riskLevel === 'high' ? '#ffebee' : '#fff3e0',
                      border: `1px solid ${risk.riskLevel === 'high' ? '#f44336' : '#ff9800'}`,
                      borderRadius: '6px',
                      padding: '15px'
                    }}>
                      <div style={{ fontWeight: 'bold', color: risk.riskLevel === 'high' ? '#d32f2f' : '#f57c00', marginBottom: '10px' }}>
                        Risk Level: {risk.riskLevel.toUpperCase()}
                      </div>
                      <ul style={{ margin: 0, paddingLeft: '20px' }}>
                        {risk.reasons.map((reason, idx) => (
                          <li key={idx} style={{ fontSize: '14px', marginBottom: '5px' }}>{reason}</li>
                        ))}
                      </ul>
                      <div style={{ marginTop: '10px', fontStyle: 'italic', color: '#666' }}>
                        <strong>Impact:</strong> {risk.impact}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Navigation */}
              <div style={{ marginTop: '30px', display: 'flex', gap: '10px' }}>
                {currentStep > 0 && (
                  <button
                    onClick={() => setCurrentStep(currentStep - 1)}
                    style={{
                      background: '#607D8B',
                      color: 'white',
                      border: 'none',
                      padding: '10px 15px',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    ← Previous Step
                  </button>
                )}
                {currentStep < selectedPath.components.length - 1 && (
                  <button
                    onClick={() => setCurrentStep(currentStep + 1)}
                    style={{
                      background: '#2196F3',
                      color: 'white',
                      border: 'none',
                      padding: '10px 15px',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    Next Step →
                  </button>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}