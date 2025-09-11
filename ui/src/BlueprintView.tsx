import React, { useState, useEffect } from 'react';
import { ArchitectureBlueprint, ComponentNode, ComponentType } from './types';

interface BlueprintViewProps {
  blueprint: ArchitectureBlueprint;
}

interface ComponentGroup {
  type: ComponentType;
  name: string;
  components: ComponentNode[];
  color: string;
  icon: string;
}

export default function BlueprintView({ blueprint }: BlueprintViewProps) {
  const [currentView, setCurrentView] = useState<'overview' | ComponentType>('overview');
  const [selectedComponent, setSelectedComponent] = useState<ComponentNode | null>(null);

  // Group components by type and importance
  const componentGroups: ComponentGroup[] = [
    {
      type: 'route',
      name: 'API Routes',
      components: blueprint.components.filter(c => c.type === 'route'),
      color: '#2196F3',
      icon: '🛣️'
    },
    {
      type: 'controller',
      name: 'Controllers',
      components: blueprint.components.filter(c => c.type === 'controller'),
      color: '#4CAF50',
      icon: '🎛️'
    },
    {
      type: 'middleware',
      name: 'Middleware',
      components: blueprint.components.filter(c => c.type === 'middleware'),
      color: '#FF9800',
      icon: '⚙️'
    },
    {
      type: 'service',
      name: 'Services',
      components: blueprint.components.filter(c => c.type === 'service'),
      color: '#00BCD4',
      icon: '🔧'
    },
    {
      type: 'model',
      name: 'Data Models',
      components: blueprint.components.filter(c => c.type === 'model'),
      color: '#9C27B0',
      icon: '📊'
    },
    {
      type: 'database',
      name: 'Database',
      components: blueprint.components.filter(c => c.type === 'database'),
      color: '#E91E63',
      icon: '🗄️'
    },
    {
      type: 'external_api',
      name: 'External APIs',
      components: blueprint.components.filter(c => c.type === 'external_api'),
      color: '#FFC107',
      icon: '🌐'
    },
    {
      type: 'config',
      name: 'Configuration',
      components: blueprint.components.filter(c => c.type === 'config'),
      color: '#795548',
      icon: '⚙️'
    }
  ].filter(group => group.components.length > 0);

  const getRiskLevel = (componentId: string): 'high' | 'medium' | 'low' | null => {
    const risk = blueprint.riskAreas.find(r => r.componentId === componentId);
    return risk?.riskLevel || null;
  };

  const getRiskColor = (level: string | null): string => {
    switch (level) {
      case 'high': return '#f44336';
      case 'medium': return '#ff9800';
      case 'low': return '#4caf50';
      default: return '#e0e0e0';
    }
  };

  // Overview grid layout
  if (currentView === 'overview') {
    return (
      <div style={{ padding: '20px', height: '80vh', overflow: 'auto' }}>
        {/* Header */}
        <div style={{ marginBottom: '30px', textAlign: 'center' }}>
          <h2>🏗️ System Architecture Blueprint</h2>
          <p style={{ color: '#666' }}>
            {blueprint.framework} application with {blueprint.metadata.totalComponents} components
          </p>
        </div>

        {/* Architecture Overview Grid */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: '20px',
          marginBottom: '30px'
        }}>
          {componentGroups.map(group => (
            <div
              key={group.type}
              onClick={() => setCurrentView(group.type)}
              style={{
                background: 'white',
                border: `2px solid ${group.color}`,
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
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: '15px' }}>
                <span style={{ fontSize: '24px', marginRight: '10px' }}>{group.icon}</span>
                <h3 style={{ margin: 0, color: group.color }}>{group.name}</h3>
              </div>
              
              <div style={{ fontSize: '32px', fontWeight: 'bold', color: group.color, marginBottom: '10px' }}>
                {group.components.length}
              </div>
              
              <div style={{ fontSize: '14px', color: '#666' }}>
                {group.components.filter(c => c.metadata.isEntry).length} entry points
              </div>
              
              {/* Risk indicator */}
              <div style={{ marginTop: '10px', display: 'flex', gap: '5px' }}>
                {['high', 'medium', 'low'].map(level => {
                  const count = group.components.filter(c => getRiskLevel(c.id) === level).length;
                  return count > 0 && (
                    <div key={level} style={{
                      background: getRiskColor(level),
                      color: 'white',
                      padding: '2px 6px',
                      borderRadius: '10px',
                      fontSize: '10px',
                      fontWeight: 'bold'
                    }}>
                      {count} {level}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* System Health Overview */}
        <div style={{
          background: '#f8f9fa',
          border: '1px solid #dee2e6',
          borderRadius: '8px',
          padding: '20px'
        }}>
          <h3>🏥 System Health</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px' }}>
            <div>
              <strong>Components:</strong> {blueprint.metadata.totalComponents}<br/>
              <strong>Entry Points:</strong> {blueprint.metadata.entryPointsCount}<br/>
              <strong>Orphaned:</strong> {blueprint.metadata.orphanedCount}
            </div>
            <div>
              <strong>Avg Complexity:</strong> {blueprint.metadata.complexityAverage.toFixed(1)}/10<br/>
              <strong>High Risk:</strong> {blueprint.riskAreas.filter(r => r.riskLevel === 'high').length}<br/>
              <strong>Connections:</strong> {blueprint.connections.length}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Detailed view for specific component type
  const currentGroup = componentGroups.find(g => g.type === currentView);
  if (!currentGroup) return null;

  return (
    <div style={{ display: 'flex', height: '80vh' }}>
      {/* Component List */}
      <div style={{ width: '400px', borderRight: '1px solid #ddd', overflow: 'auto' }}>
        {/* Header */}
        <div style={{
          padding: '20px',
          background: currentGroup.color,
          color: 'white',
          position: 'sticky',
          top: 0,
          zIndex: 100
        }}>
          <button
            onClick={() => setCurrentView('overview')}
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
            ← Back to Overview
          </button>
          <h3 style={{ margin: 0 }}>
            {currentGroup.icon} {currentGroup.name}
          </h3>
          <p style={{ margin: '5px 0 0 0', opacity: 0.9 }}>
            {currentGroup.components.length} components
          </p>
        </div>

        {/* Component Cards */}
        <div style={{ padding: '10px' }}>
          {currentGroup.components
            .sort((a, b) => (b.metadata.complexity || 0) - (a.metadata.complexity || 0))
            .map(component => {
              const riskLevel = getRiskLevel(component.id);
              return (
                <div
                  key={component.id}
                  onClick={() => setSelectedComponent(component)}
                  style={{
                    background: selectedComponent?.id === component.id ? '#e3f2fd' : 'white',
                    border: selectedComponent?.id === component.id ? '2px solid #2196F3' : '1px solid #ddd',
                    borderRadius: '8px',
                    padding: '15px',
                    marginBottom: '10px',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <h4 style={{ margin: '0 0 5px 0', fontSize: '14px' }}>
                        {component.name}
                      </h4>
                      <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>
                        {component.path.replace(process.cwd(), '.')}
                      </div>
                      <div style={{ display: 'flex', gap: '10px', fontSize: '11px' }}>
                        <span>Lines: {component.metadata.lineCount}</span>
                        <span>Complexity: {component.metadata.complexity}/10</span>
                      </div>
                    </div>
                    
                    {/* Risk indicator */}
                    {riskLevel && (
                      <div style={{
                        background: getRiskColor(riskLevel),
                        color: 'white',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontSize: '10px',
                        fontWeight: 'bold',
                        marginLeft: '10px'
                      }}>
                        {riskLevel.toUpperCase()}
                      </div>
                    )}
                  </div>
                  
                  {/* Entry point indicator */}
                  {component.metadata.isEntry && (
                    <div style={{
                      background: '#4caf50',
                      color: 'white',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '10px',
                      fontWeight: 'bold',
                      marginTop: '5px',
                      display: 'inline-block'
                    }}>
                      ENTRY POINT
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </div>

      {/* Component Details */}
      <div style={{ flex: 1, padding: '20px', overflow: 'auto' }}>
        {selectedComponent ? (
          <div>
            <h2>{selectedComponent.name}</h2>
            <p style={{ color: '#666', marginBottom: '20px' }}>
              {selectedComponent.path}
            </p>

            {/* Metrics */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: '15px',
              marginBottom: '20px'
            }}>
              <div style={{ background: '#f5f5f5', padding: '15px', borderRadius: '8px' }}>
                <div style={{ fontSize: '24px', fontWeight: 'bold', color: currentGroup.color }}>
                  {selectedComponent.metadata.lineCount}
                </div>
                <div style={{ fontSize: '12px', color: '#666' }}>Lines of Code</div>
              </div>
              <div style={{ background: '#f5f5f5', padding: '15px', borderRadius: '8px' }}>
                <div style={{ fontSize: '24px', fontWeight: 'bold', color: currentGroup.color }}>
                  {selectedComponent.metadata.complexity}/10
                </div>
                <div style={{ fontSize: '12px', color: '#666' }}>Complexity</div>
              </div>
              <div style={{ background: '#f5f5f5', padding: '15px', borderRadius: '8px' }}>
                <div style={{ fontSize: '24px', fontWeight: 'bold', color: currentGroup.color }}>
                  {selectedComponent.dependencies.length}
                </div>
                <div style={{ fontSize: '12px', color: '#666' }}>Dependencies</div>
              </div>
              <div style={{ background: '#f5f5f5', padding: '15px', borderRadius: '8px' }}>
                <div style={{ fontSize: '24px', fontWeight: 'bold', color: currentGroup.color }}>
                  {selectedComponent.dependents.length}
                </div>
                <div style={{ fontSize: '12px', color: '#666' }}>Dependents</div>
              </div>
            </div>

            {/* HTTP Methods (for routes) */}
            {selectedComponent.metadata.httpMethods && (
              <div style={{ marginBottom: '20px' }}>
                <h4>HTTP Methods</h4>
                <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                  {selectedComponent.metadata.httpMethods.map(method => (
                    <span key={method} style={{
                      background: '#e3f2fd',
                      color: '#1976d2',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      fontWeight: 'bold'
                    }}>
                      {method}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Dependencies */}
            {selectedComponent.dependencies.length > 0 && (
              <div style={{ marginBottom: '20px' }}>
                <h4>Dependencies ({selectedComponent.dependencies.length})</h4>
                <div style={{ background: '#f8f9fa', padding: '10px', borderRadius: '4px', maxHeight: '150px', overflow: 'auto' }}>
                  {selectedComponent.dependencies.map(dep => (
                    <div key={dep} style={{ fontSize: '12px', padding: '2px 0', fontFamily: 'monospace' }}>
                      {dep}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Dependents */}
            {selectedComponent.dependents.length > 0 && (
              <div style={{ marginBottom: '20px' }}>
                <h4>Used By ({selectedComponent.dependents.length})</h4>
                <div style={{ background: '#f8f9fa', padding: '10px', borderRadius: '4px', maxHeight: '150px', overflow: 'auto' }}>
                  {selectedComponent.dependents.map(dep => (
                    <div key={dep} style={{ fontSize: '12px', padding: '2px 0', fontFamily: 'monospace' }}>
                      {dep}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Risk Information */}
            {(() => {
              const risks = blueprint.riskAreas.filter(r => r.componentId === selectedComponent.id);
              return risks.length > 0 && (
                <div style={{ marginBottom: '20px' }}>
                  <h4>⚠️ Risk Analysis</h4>
                  {risks.map(risk => (
                    <div key={risk.componentId} style={{
                      background: risk.riskLevel === 'high' ? '#ffebee' : 
                                 risk.riskLevel === 'medium' ? '#fff3e0' : '#f3e5f5',
                      border: `1px solid ${getRiskColor(risk.riskLevel)}`,
                      borderRadius: '8px',
                      padding: '15px'
                    }}>
                      <div style={{ fontWeight: 'bold', color: getRiskColor(risk.riskLevel), marginBottom: '10px' }}>
                        Risk Level: {risk.riskLevel.toUpperCase()}
                      </div>
                      <div style={{ marginBottom: '10px' }}>
                        <strong>Reasons:</strong>
                        <ul style={{ margin: '5px 0', paddingLeft: '20px' }}>
                          {risk.reasons.map((reason, idx) => (
                            <li key={idx} style={{ fontSize: '14px' }}>{reason}</li>
                          ))}
                        </ul>
                      </div>
                      <div style={{ fontStyle: 'italic', color: '#666' }}>
                        <strong>Impact:</strong> {risk.impact}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '50px', color: '#666' }}>
            <h3>Select a component to view details</h3>
            <p>Click on any component from the list to see its details, dependencies, and risk analysis.</p>
          </div>
        )}
      </div>
    </div>
  );
}