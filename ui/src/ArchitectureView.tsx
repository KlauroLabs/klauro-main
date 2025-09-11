import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DataSet, Network } from 'vis-network/standalone/esm/vis-network';
import { ArchitectureBlueprint, ComponentNode, Connection, ComponentType, RiskArea } from './types';

interface ArchitectureViewProps {
  blueprint: ArchitectureBlueprint;
}

export default function ArchitectureView({ blueprint }: ArchitectureViewProps) {
  const networkRef = useRef<HTMLDivElement>(null);
  const [network, setNetwork] = useState<Network | null>(null);
  const [selectedComponent, setSelectedComponent] = useState<ComponentNode | null>(null);
  const [showOrphaned, setShowOrphaned] = useState(true);
  const [filterType, setFilterType] = useState<ComponentType | 'all'>('all');

  // Color mapping for different component types
  const getColorForComponentType = (type: ComponentType, isRisk: boolean = false): string => {
    if (isRisk) {
      return '#FF5722'; // Red for risk areas
    }
    
    switch (type) {
      case 'route': return '#2196F3';      // Blue for routes
      case 'controller': return '#4CAF50';  // Green for controllers
      case 'middleware': return '#FF9800';  // Orange for middleware
      case 'model': return '#9C27B0';       // Purple for models
      case 'service': return '#00BCD4';     // Cyan for services
      case 'utility': return '#607D8B';     // Blue-grey for utilities
      case 'config': return '#795548';      // Brown for config
      case 'database': return '#E91E63';    // Pink for database
      case 'external_api': return '#FFC107'; // Amber for external APIs
      case 'orphaned': return '#9E9E9E';    // Grey for orphaned
      default: return '#757575';            // Default grey
    }
  };

  const getShapeForComponentType = (type: ComponentType): string => {
    switch (type) {
      case 'route': return 'triangle';
      case 'controller': return 'box';
      case 'middleware': return 'diamond';
      case 'model': return 'database';
      case 'service': return 'ellipse';
      case 'database': return 'database';
      case 'external_api': return 'star';
      case 'orphaned': return 'dot';
      default: return 'box';
    }
  };

  const isHighRiskComponent = (componentId: string): boolean => {
    return blueprint.riskAreas.some(risk => 
      risk.componentId === componentId && risk.riskLevel === 'high'
    );
  };

  const handleNodeClick = useCallback((params: { nodes: string[] }) => {
    if (params.nodes.length === 0) {
      setSelectedComponent(null);
      return;
    }

    const clickedNodeId = params.nodes[0];
    const clickedComponent = blueprint.components.find(comp => comp.id === clickedNodeId);

    if (clickedComponent) {
      setSelectedComponent(clickedComponent);
      
      // Highlight connected components
      const connectedNodes = new Set([clickedNodeId]);
      blueprint.connections.forEach(conn => {
        if (conn.from === clickedNodeId || conn.to === clickedNodeId) {
          connectedNodes.add(conn.from);
          connectedNodes.add(conn.to);
        }
      });

      // Update node colors to highlight connections
      if (network) {
        const nodes = blueprint.components.map(comp => {
          const isConnected = connectedNodes.has(comp.id);
          const isSelected = comp.id === clickedNodeId;
          
          return {
            id: comp.id,
            label: `${comp.name}\n(${comp.type})`,
            color: isSelected ? '#FF5722' : 
                   isConnected ? getColorForComponentType(comp.type, true) :
                   getColorForComponentType(comp.type, isHighRiskComponent(comp.id)),
            shape: getShapeForComponentType(comp.type),
            opacity: isConnected ? 1.0 : 0.3,
            size: isSelected ? 30 : 20
          };
        });

        network.setData({ nodes: new DataSet(nodes), edges: network.body.data.edges });
      }
    }
  }, [blueprint, network]);

  const initializeNetwork = useCallback(() => {
    if (!networkRef.current) return;

    console.log(`🎨 Rendering architecture view with ${blueprint.components.length} components, ${blueprint.connections.length} connections`);

    // PERFORMANCE OPTIMIZATION: For large datasets (>100 components), show only the most important ones initially
    let filteredComponents = blueprint.components.filter(comp => {
      if (!showOrphaned && comp.metadata.isOrphaned) return false;
      if (filterType !== 'all' && comp.type !== filterType) return false;
      return true;
    });

    // If there are too many components, prioritize the most important ones
    if (filteredComponents.length > 100) {
      console.log(`⚡ Large dataset detected (${filteredComponents.length} components). Showing top 100 most important components.`);
      
      // Sort by importance: entry points first, then by complexity and connections
      filteredComponents = filteredComponents
        .map(comp => ({
          ...comp,
          importance: (comp.metadata.isEntry ? 1000 : 0) + 
                     (comp.metadata.complexity * 10) + 
                     (comp.dependencies.length + comp.dependents.length)
        }))
        .sort((a, b) => (b.importance || 0) - (a.importance || 0))
        .slice(0, 100);
    }

    // Create nodes
    const nodes = filteredComponents.map(comp => ({
      id: comp.id,
      label: `${comp.name}\n(${comp.type})`,
      color: getColorForComponentType(comp.type, isHighRiskComponent(comp.id)),
      shape: getShapeForComponentType(comp.type),
      size: Math.min(comp.metadata.complexity * 2 + 15, 40), // Size based on complexity, capped
      font: { size: 10, color: '#333333' }
    }));

    // Create edges (only for filtered components)
    const filteredComponentIds = new Set(filteredComponents.map(c => c.id));
    const edges = blueprint.connections
      .filter(conn => filteredComponentIds.has(conn.from) && filteredComponentIds.has(conn.to))
      .slice(0, 200) // Limit edges for performance
      .map(conn => ({
        id: `${conn.from}-${conn.to}`,
        from: conn.from,
        to: conn.to,
        arrows: { to: { enabled: true, scaleFactor: 0.8 } },
        color: { color: '#666666', opacity: 0.6 },
        width: Math.min(conn.weight || 1, 3),
        smooth: { type: 'continuous' }
      }));

    console.log(`📊 Rendering ${nodes.length} nodes and ${edges.length} edges`);

    const data = {
      nodes: new DataSet(nodes),
      edges: new DataSet(edges)
    };

    const options = {
      layout: {
        improvedLayout: false, // Disabled for performance
        hierarchical: {
          enabled: false
        }
      },
      physics: {
        enabled: false, // DISABLED for performance with large datasets
        stabilization: false
      },
      nodes: {
        borderWidth: 2,
        shadow: true,
        chosen: {
          node: {
            borderColor: '#FF5722',
            borderWidth: 3
          }
        }
      },
      edges: {
        smooth: {
          type: 'continuous',
          roundness: 0.5
        },
        shadow: true
      },
      interaction: {
        hover: true,
        selectConnectedEdges: false
      }
    };

    const net = new Network(networkRef.current, data, options);
    net.on("click", handleNodeClick);
    setNetwork(net);

  }, [blueprint, showOrphaned, filterType, handleNodeClick]);

  useEffect(() => {
    initializeNetwork();
  }, [initializeNetwork]);

  const resetView = () => {
    setSelectedComponent(null);
    setFilterType('all');
    setShowOrphaned(true);
    initializeNetwork();
  };

  const componentTypeOptions: (ComponentType | 'all')[] = [
    'all', 'route', 'controller', 'middleware', 'model', 'service', 
    'utility', 'config', 'database', 'external_api', 'orphaned'
  ];

  const totalComponents = blueprint.components.length;
  const isLargeDataset = totalComponents > 100;

  return (
    <div style={{ display: 'flex', height: '80vh' }}>
      {/* Performance notification for large datasets */}
      {isLargeDataset && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          background: '#fff3cd',
          color: '#856404',
          padding: '10px',
          textAlign: 'center',
          borderBottom: '1px solid #ffeaa7',
          zIndex: 1001,
          fontSize: '14px'
        }}>
          ⚡ Large dataset detected ({totalComponents} components, {blueprint.connections.length} connections). 
          Showing top 100 most important components for performance. Use filters to explore specific areas.
        </div>
      )}
      
      {/* Main visualization area */}
      <div style={{ flex: 1, position: 'relative', marginTop: isLargeDataset ? '40px' : '0' }}>
        {/* Controls */}
        <div style={{ 
          position: 'absolute', 
          top: 10, 
          left: 10, 
          zIndex: 1000,
          background: 'rgba(255,255,255,0.9)',
          padding: '10px',
          borderRadius: '8px',
          boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
        }}>
          <div style={{ marginBottom: '10px' }}>
            <label>
              <input
                type="checkbox"
                checked={showOrphaned}
                onChange={(e) => setShowOrphaned(e.target.checked)}
                style={{ marginRight: '5px' }}
              />
              Show Orphaned Components
            </label>
          </div>
          
          <div style={{ marginBottom: '10px' }}>
            <label style={{ display: 'block', marginBottom: '5px' }}>Filter by Type:</label>
            <select 
              value={filterType} 
              onChange={(e) => setFilterType(e.target.value as ComponentType | 'all')}
              style={{ padding: '5px', borderRadius: '4px', border: '1px solid #ccc' }}
            >
              {componentTypeOptions.map(type => (
                <option key={type} value={type}>
                  {type.replace('_', ' ').toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          <button 
            onClick={resetView}
            style={{
              padding: '5px 10px',
              backgroundColor: '#2196F3',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Reset View
          </button>
        </div>

        {/* Network visualization */}
        <div ref={networkRef} style={{ height: '100%', width: '100%' }} />
      </div>

      {/* Component details sidebar */}
      <div style={{ 
        width: '300px', 
        background: '#f5f5f5', 
        padding: '20px', 
        overflow: 'auto',
        borderLeft: '1px solid #ddd'
      }}>
        <h3>Component Details</h3>
        
        {selectedComponent ? (
          <div>
            <h4 style={{ color: getColorForComponentType(selectedComponent.type) }}>
              {selectedComponent.name}
            </h4>
            
            <div style={{ marginBottom: '15px' }}>
              <strong>Type:</strong> {selectedComponent.type}<br/>
              <strong>Path:</strong> <code style={{ fontSize: '12px' }}>{selectedComponent.path}</code><br/>
              <strong>Lines:</strong> {selectedComponent.metadata.lineCount}<br/>
              <strong>Complexity:</strong> {selectedComponent.metadata.complexity}/10
            </div>

            {selectedComponent.metadata.httpMethods && (
              <div style={{ marginBottom: '10px' }}>
                <strong>HTTP Methods:</strong>
                <div style={{ fontSize: '12px' }}>
                  {selectedComponent.metadata.httpMethods.map(method => (
                    <span key={method} style={{ 
                      background: '#e0e0e0', 
                      padding: '2px 6px', 
                      margin: '2px', 
                      borderRadius: '3px',
                      display: 'inline-block'
                    }}>
                      {method}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div style={{ marginBottom: '10px' }}>
              <strong>Dependencies ({selectedComponent.dependencies.length}):</strong>
              <div style={{ fontSize: '12px', maxHeight: '100px', overflow: 'auto' }}>
                {selectedComponent.dependencies.map(dep => (
                  <div key={dep} style={{ padding: '2px 0' }}>{dep}</div>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: '10px' }}>
              <strong>Dependents ({selectedComponent.dependents.length}):</strong>
              <div style={{ fontSize: '12px', maxHeight: '100px', overflow: 'auto' }}>
                {selectedComponent.dependents.map(dep => (
                  <div key={dep} style={{ padding: '2px 0' }}>{dep}</div>
                ))}
              </div>
            </div>

            {/* Risk information */}
            {blueprint.riskAreas
              .filter(risk => risk.componentId === selectedComponent.id)
              .map(risk => (
                <div key={risk.componentId} style={{ 
                  background: risk.riskLevel === 'high' ? '#ffebee' : 
                             risk.riskLevel === 'medium' ? '#fff3e0' : '#f3e5f5',
                  padding: '10px',
                  borderRadius: '4px',
                  marginTop: '10px'
                }}>
                  <strong style={{ color: '#d32f2f' }}>Risk Level: {risk.riskLevel.toUpperCase()}</strong>
                  <div style={{ fontSize: '12px', marginTop: '5px' }}>
                    {risk.reasons.map((reason, idx) => (
                      <div key={idx}>• {reason}</div>
                    ))}
                  </div>
                  <div style={{ fontSize: '12px', marginTop: '5px', fontStyle: 'italic' }}>
                    {risk.impact}
                  </div>
                </div>
              ))
            }
          </div>
        ) : (
          <div>
            <p>Click on a component to see its details.</p>
            
            <div style={{ marginTop: '20px' }}>
              <h4>Project Overview</h4>
              <div style={{ fontSize: '14px' }}>
                <div><strong>Framework:</strong> {blueprint.framework}</div>
                <div><strong>Total Components:</strong> {blueprint.metadata.totalComponents}</div>
                <div><strong>Entry Points:</strong> {blueprint.metadata.entryPointsCount}</div>
                <div><strong>Orphaned:</strong> {blueprint.metadata.orphanedCount}</div>
                <div><strong>Avg Complexity:</strong> {blueprint.metadata.complexityAverage.toFixed(1)}/10</div>
              </div>
            </div>

            {blueprint.riskAreas.length > 0 && (
              <div style={{ marginTop: '20px' }}>
                <h4>Risk Summary</h4>
                <div style={{ fontSize: '12px' }}>
                  {blueprint.riskAreas.map(risk => (
                    <div key={risk.componentId} style={{ 
                      padding: '5px',
                      margin: '5px 0',
                      borderLeft: `4px solid ${risk.riskLevel === 'high' ? '#f44336' : 
                                                  risk.riskLevel === 'medium' ? '#ff9800' : '#4caf50'}`,
                      background: '#f9f9f9'
                    }}>
                      <strong>{risk.componentId}</strong> - {risk.riskLevel}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}