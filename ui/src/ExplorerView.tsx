import React, { useState, useEffect, useMemo } from 'react';
import { ArchitectureBlueprint, ComponentNode, ComponentType } from './types';

interface ExplorerViewProps {
  blueprint: ArchitectureBlueprint;
}

interface ExplorerState {
  view: 'welcome' | 'overview' | 'category' | 'component' | 'flow';
  selectedCategory?: ComponentType;
  selectedComponent?: ComponentNode;
  selectedFlow?: string;
  searchQuery: string;
  showOnlyProblematic: boolean;
  showOnlyEntryPoints: boolean;
}

export default function ExplorerView({ blueprint }: ExplorerViewProps) {
  const [state, setState] = useState<ExplorerState>({
    view: 'welcome',
    searchQuery: '',
    showOnlyProblematic: false,
    showOnlyEntryPoints: false
  });

  const [breadcrumbs, setBreadcrumbs] = useState<Array<{label: string, action: () => void}>>([]);

  // Categorize components with better grouping
  const categories = useMemo(() => {
    const groups = {
      'route': { 
        name: '🛣️ API Routes & Endpoints', 
        description: 'External interfaces and entry points',
        icon: '🌐',
        color: '#2196F3',
        components: blueprint.components.filter(c => c.type === 'route')
      },
      'controller': { 
        name: '🎛️ Controllers & Handlers', 
        description: 'Business logic and request processing',
        icon: '⚡',
        color: '#4CAF50',
        components: blueprint.components.filter(c => c.type === 'controller')
      },
      'service': { 
        name: '🔧 Services & Business Logic', 
        description: 'Core application services',
        icon: '🏗️',
        color: '#00BCD4',
        components: blueprint.components.filter(c => c.type === 'service')
      },
      'model': { 
        name: '📊 Data Models & Schemas', 
        description: 'Data structures and entities',
        icon: '💾',
        color: '#9C27B0',
        components: blueprint.components.filter(c => c.type === 'model')
      },
      'middleware': { 
        name: '⚙️ Middleware & Guards', 
        description: 'Authentication, validation, and processing',
        icon: '🛡️',
        color: '#FF9800',
        components: blueprint.components.filter(c => c.type === 'middleware')
      },
      'database': { 
        name: '🗄️ Database & Storage', 
        description: 'Data persistence and queries',
        icon: '🗃️',
        color: '#E91E63',
        components: blueprint.components.filter(c => c.type === 'database')
      },
      'external_api': { 
        name: '🌐 External APIs & Services', 
        description: 'Third-party integrations',
        icon: '🔗',
        color: '#FFC107',
        components: blueprint.components.filter(c => c.type === 'external_api')
      },
      'config': { 
        name: '⚙️ Configuration & Settings', 
        description: 'App configuration and environment setup',
        icon: '🔧',
        color: '#795548',
        components: blueprint.components.filter(c => c.type === 'config')
      }
    };

    return Object.entries(groups)
      .filter(([_, group]) => group.components.length > 0)
      .map(([key, group]) => ({ key: key as ComponentType, ...group }));
  }, [blueprint]);

  // Smart filtering
  const filteredComponents = useMemo(() => {
    let components = blueprint.components;

    if (state.searchQuery) {
      const query = state.searchQuery.toLowerCase();
      components = components.filter(c => 
        c.name.toLowerCase().includes(query) ||
        c.path.toLowerCase().includes(query) ||
        c.type.toLowerCase().includes(query)
      );
    }

    if (state.showOnlyProblematic) {
      const problematicIds = new Set(blueprint.riskAreas.filter(r => r.riskLevel === 'high').map(r => r.componentId));
      components = components.filter(c => problematicIds.has(c.id));
    }

    if (state.showOnlyEntryPoints) {
      components = components.filter(c => c.metadata.isEntry);
    }

    return components;
  }, [blueprint, state.searchQuery, state.showOnlyProblematic, state.showOnlyEntryPoints]);

  // Navigation helpers
  const navigateTo = (newState: Partial<ExplorerState>) => {
    setState(prev => ({ ...prev, ...newState }));
  };

  const updateBreadcrumbs = (newCrumbs: Array<{label: string, action: () => void}>) => {
    setBreadcrumbs(newCrumbs);
  };

  const getRiskLevel = (componentId: string) => {
    const risk = blueprint.riskAreas.find(r => r.componentId === componentId);
    return risk?.riskLevel || null;
  };

  const getComponentsByCategory = (category: ComponentType) => {
    return filteredComponents.filter(c => c.type === category);
  };

  // Welcome screen for first-time users
  if (state.view === 'welcome') {
    return (
      <div style={{ 
        padding: '40px', 
        textAlign: 'center', 
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        color: 'white',
        minHeight: '80vh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center'
      }}>
        <div style={{ maxWidth: '600px', margin: '0 auto' }}>
          <h1 style={{ fontSize: '48px', marginBottom: '20px', textShadow: '0 2px 4px rgba(0,0,0,0.3)' }}>
            🗺️ Welcome to Code Explorer
          </h1>
          <p style={{ fontSize: '20px', marginBottom: '40px', opacity: 0.9 }}>
            Your interactive guide to understanding this codebase
          </p>
          
          <div style={{ 
            background: 'rgba(255,255,255,0.1)', 
            borderRadius: '16px', 
            padding: '30px', 
            marginBottom: '40px',
            backdropFilter: 'blur(10px)'
          }}>
            <h3 style={{ marginBottom: '20px' }}>🎯 What you can explore:</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px' }}>
              <div>
                <div style={{ fontSize: '24px', marginBottom: '10px' }}>🛣️</div>
                <strong>API Routes</strong><br/>
                <span style={{ opacity: 0.8 }}>How users interact with the app</span>
              </div>
              <div>
                <div style={{ fontSize: '24px', marginBottom: '10px' }}>⚡</div>
                <strong>Business Logic</strong><br/>
                <span style={{ opacity: 0.8 }}>What the app actually does</span>
              </div>
              <div>
                <div style={{ fontSize: '24px', marginBottom: '10px' }}>💾</div>
                <strong>Data Flow</strong><br/>
                <span style={{ opacity: 0.8 }}>How information moves around</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '20px', justifyContent: 'center' }}>
            <button
              onClick={() => {
                navigateTo({ view: 'overview' });
                updateBreadcrumbs([{ label: '🏠 Overview', action: () => navigateTo({ view: 'overview' }) }]);
              }}
              style={{
                background: 'rgba(255,255,255,0.2)',
                border: '2px solid rgba(255,255,255,0.3)',
                color: 'white',
                padding: '15px 30px',
                borderRadius: '30px',
                fontSize: '18px',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
                backdropFilter: 'blur(10px)'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.3)';
                e.currentTarget.style.transform = 'translateY(-2px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.2)';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              🚀 Start Exploring
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Main explorer interface
  return (
    <div style={{ height: '80vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header with search and filters */}
      <div style={{
        background: 'linear-gradient(90deg, #667eea 0%, #764ba2 100%)',
        color: 'white',
        padding: '20px',
        boxShadow: '0 2px 10px rgba(0,0,0,0.1)'
      }}>
        {/* Breadcrumbs */}
        <div style={{ marginBottom: '15px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          {breadcrumbs.map((crumb, index) => (
            <React.Fragment key={index}>
              <button
                onClick={crumb.action}
                style={{
                  background: 'rgba(255,255,255,0.1)',
                  border: 'none',
                  color: 'white',
                  padding: '5px 12px',
                  borderRadius: '20px',
                  cursor: 'pointer',
                  fontSize: '14px'
                }}
              >
                {crumb.label}
              </button>
              {index < breadcrumbs.length - 1 && <span style={{ opacity: 0.7 }}>→</span>}
            </React.Fragment>
          ))}
        </div>

        {/* Search and filters */}
        <div style={{ display: 'flex', gap: '15px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '300px' }}>
            <input
              type="text"
              placeholder="🔍 Search components, files, or types..."
              value={state.searchQuery}
              onChange={(e) => setState(prev => ({ ...prev, searchQuery: e.target.value }))}
              style={{
                width: '100%',
                padding: '12px 20px',
                borderRadius: '25px',
                border: 'none',
                fontSize: '16px',
                background: 'rgba(255,255,255,0.9)',
                boxShadow: '0 2px 10px rgba(0,0,0,0.1)'
              }}
            />
          </div>
          
          <button
            onClick={() => setState(prev => ({ ...prev, showOnlyProblematic: !prev.showOnlyProblematic }))}
            style={{
              background: state.showOnlyProblematic ? '#f44336' : 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.3)',
              color: 'white',
              padding: '10px 15px',
              borderRadius: '20px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            {state.showOnlyProblematic ? '🚨 Problems Only' : '⚠️ Show Problems'}
          </button>
          
          <button
            onClick={() => setState(prev => ({ ...prev, showOnlyEntryPoints: !prev.showOnlyEntryPoints }))}
            style={{
              background: state.showOnlyEntryPoints ? '#4CAF50' : 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.3)',
              color: 'white',
              padding: '10px 15px',
              borderRadius: '20px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            {state.showOnlyEntryPoints ? '🚪 Entry Points' : '🚪 Show Entries'}
          </button>
        </div>
      </div>

      {/* Main content area */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {state.view === 'overview' && (
          <div style={{ padding: '30px' }}>
            {/* Quick stats */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '20px',
              marginBottom: '40px'
            }}>
              <div style={{
                background: 'linear-gradient(135deg, #4CAF50, #45a049)',
                color: 'white',
                padding: '20px',
                borderRadius: '16px',
                textAlign: 'center',
                boxShadow: '0 4px 15px rgba(76, 175, 80, 0.3)'
              }}>
                <div style={{ fontSize: '32px', fontWeight: 'bold' }}>{blueprint.metadata.totalComponents}</div>
                <div style={{ opacity: 0.9 }}>Total Components</div>
              </div>
              <div style={{
                background: 'linear-gradient(135deg, #2196F3, #1976D2)',
                color: 'white',
                padding: '20px',
                borderRadius: '16px',
                textAlign: 'center',
                boxShadow: '0 4px 15px rgba(33, 150, 243, 0.3)'
              }}>
                <div style={{ fontSize: '32px', fontWeight: 'bold' }}>{blueprint.metadata.entryPointsCount}</div>
                <div style={{ opacity: 0.9 }}>Entry Points</div>
              </div>
              <div style={{
                background: 'linear-gradient(135deg, #FF5722, #D84315)',
                color: 'white',
                padding: '20px',
                borderRadius: '16px',
                textAlign: 'center',
                boxShadow: '0 4px 15px rgba(255, 87, 34, 0.3)'
              }}>
                <div style={{ fontSize: '32px', fontWeight: 'bold' }}>
                  {blueprint.riskAreas.filter(r => r.riskLevel === 'high').length}
                </div>
                <div style={{ opacity: 0.9 }}>Critical Issues</div>
              </div>
              <div style={{
                background: 'linear-gradient(135deg, #9C27B0, #7B1FA2)',
                color: 'white',
                padding: '20px',
                borderRadius: '16px',
                textAlign: 'center',
                boxShadow: '0 4px 15px rgba(156, 39, 176, 0.3)'
              }}>
                <div style={{ fontSize: '32px', fontWeight: 'bold' }}>
                  {blueprint.metadata.complexityAverage.toFixed(1)}/10
                </div>
                <div style={{ opacity: 0.9 }}>Avg Complexity</div>
              </div>
            </div>

            {/* Categories grid */}
            <h2 style={{ marginBottom: '30px', color: '#333' }}>🗂️ Explore by Category</h2>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))',
              gap: '25px'
            }}>
              {categories.map(category => {
                const hasProblems = category.components.some(c => getRiskLevel(c.id) === 'high');
                const entryPointsCount = category.components.filter(c => c.metadata.isEntry).length;

                return (
                  <div
                    key={category.key}
                    onClick={() => {
                      navigateTo({ view: 'category', selectedCategory: category.key });
                      updateBreadcrumbs([
                        { label: '🏠 Overview', action: () => navigateTo({ view: 'overview' }) },
                        { label: category.name, action: () => navigateTo({ view: 'category', selectedCategory: category.key }) }
                      ]);
                    }}
                    style={{
                      background: 'white',
                      border: hasProblems ? '2px solid #f44336' : '1px solid #e0e0e0',
                      borderRadius: '20px',
                      padding: '25px',
                      cursor: 'pointer',
                      transition: 'all 0.3s ease',
                      boxShadow: '0 4px 15px rgba(0,0,0,0.08)',
                      position: 'relative',
                      overflow: 'hidden'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = 'translateY(-5px)';
                      e.currentTarget.style.boxShadow = '0 8px 25px rgba(0,0,0,0.15)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'translateY(0)';
                      e.currentTarget.style.boxShadow = '0 4px 15px rgba(0,0,0,0.08)';
                    }}
                  >
                    {/* Category header */}
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '15px' }}>
                      <div style={{
                        background: `linear-gradient(135deg, ${category.color}, ${category.color}dd)`,
                        color: 'white',
                        width: '50px',
                        height: '50px',
                        borderRadius: '15px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '24px',
                        marginRight: '15px',
                        boxShadow: `0 4px 15px ${category.color}40`
                      }}>
                        {category.icon}
                      </div>
                      <div>
                        <h3 style={{ margin: 0, color: category.color, fontSize: '18px' }}>
                          {category.name.replace(/^🛣️|🎛️|🔧|📊|⚙️|🗄️|🌐/, '')}
                        </h3>
                        <p style={{ margin: '5px 0 0 0', color: '#666', fontSize: '14px' }}>
                          {category.description}
                        </p>
                      </div>
                    </div>

                    {/* Stats */}
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr 1fr',
                      gap: '15px',
                      marginBottom: '15px'
                    }}>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '24px', fontWeight: 'bold', color: category.color }}>
                          {category.components.length}
                        </div>
                        <div style={{ fontSize: '12px', color: '#666' }}>Components</div>
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#4CAF50' }}>
                          {entryPointsCount}
                        </div>
                        <div style={{ fontSize: '12px', color: '#666' }}>Entry Points</div>
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '24px', fontWeight: 'bold', color: hasProblems ? '#f44336' : '#4CAF50' }}>
                          {hasProblems ? '⚠️' : '✅'}
                        </div>
                        <div style={{ fontSize: '12px', color: '#666' }}>Health</div>
                      </div>
                    </div>

                    {/* Problem indicator */}
                    {hasProblems && (
                      <div style={{
                        background: '#ffebee',
                        color: '#d32f2f',
                        padding: '8px 12px',
                        borderRadius: '8px',
                        fontSize: '12px',
                        fontWeight: 'bold'
                      }}>
                        🚨 Contains critical issues
                      </div>
                    )}

                    {/* Decorative gradient */}
                    <div style={{
                      position: 'absolute',
                      top: 0,
                      right: 0,
                      width: '100px',
                      height: '100px',
                      background: `linear-gradient(135deg, ${category.color}20, transparent)`,
                      borderRadius: '0 20px 0 100px'
                    }} />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {state.view === 'category' && state.selectedCategory && (() => {
          const categoryData = categories.find(c => c.key === state.selectedCategory);
          const components = getComponentsByCategory(state.selectedCategory);
          
          return (
            <div style={{ padding: '30px' }}>
              {/* Category header */}
              <div style={{
                background: `linear-gradient(135deg, ${categoryData?.color}, ${categoryData?.color}dd)`,
                color: 'white',
                padding: '30px',
                borderRadius: '20px',
                marginBottom: '30px',
                boxShadow: `0 8px 25px ${categoryData?.color}40`
              }}>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: '15px' }}>
                  <div style={{ fontSize: '48px', marginRight: '20px' }}>{categoryData?.icon}</div>
                  <div>
                    <h1 style={{ margin: 0, fontSize: '32px' }}>{categoryData?.name}</h1>
                    <p style={{ margin: '5px 0 0 0', opacity: 0.9, fontSize: '18px' }}>
                      {categoryData?.description}
                    </p>
                  </div>
                </div>
                <div style={{ fontSize: '16px', opacity: 0.9 }}>
                  {components.length} components • {components.filter(c => c.metadata.isEntry).length} entry points
                </div>
              </div>

              {/* Component grid */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                gap: '20px'
              }}>
                {components.map(component => {
                  const riskLevel = getRiskLevel(component.id);
                  const isProblematic = riskLevel === 'high';

                  return (
                    <div
                      key={component.id}
                      onClick={() => {
                        navigateTo({ view: 'component', selectedComponent: component });
                        updateBreadcrumbs([
                          { label: '🏠 Overview', action: () => navigateTo({ view: 'overview' }) },
                          { label: categoryData?.name || '', action: () => navigateTo({ view: 'category', selectedCategory: state.selectedCategory }) },
                          { label: component.name, action: () => navigateTo({ view: 'component', selectedComponent: component }) }
                        ]);
                      }}
                      style={{
                        background: 'white',
                        border: isProblematic ? '2px solid #f44336' : '1px solid #e0e0e0',
                        borderRadius: '16px',
                        padding: '20px',
                        cursor: 'pointer',
                        transition: 'all 0.3s ease',
                        boxShadow: '0 4px 15px rgba(0,0,0,0.08)'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'translateY(-3px)';
                        e.currentTarget.style.boxShadow = '0 8px 25px rgba(0,0,0,0.15)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'translateY(0)';
                        e.currentTarget.style.boxShadow = '0 4px 15px rgba(0,0,0,0.08)';
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '15px' }}>
                        <h3 style={{ margin: 0, color: '#333', fontSize: '16px' }}>
                          {component.name}
                        </h3>
                        {isProblematic && (
                          <div style={{
                            background: '#f44336',
                            color: 'white',
                            padding: '4px 8px',
                            borderRadius: '8px',
                            fontSize: '10px',
                            fontWeight: 'bold'
                          }}>
                            🚨 CRITICAL
                          </div>
                        )}
                        {component.metadata.isEntry && (
                          <div style={{
                            background: '#4CAF50',
                            color: 'white',
                            padding: '4px 8px',
                            borderRadius: '8px',
                            fontSize: '10px',
                            fontWeight: 'bold'
                          }}>
                            🚪 ENTRY
                          </div>
                        )}
                      </div>

                      <div style={{ fontSize: '12px', color: '#666', marginBottom: '15px', fontFamily: 'monospace' }}>
                        {component.path.replace(process.cwd(), '.')}
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', fontSize: '12px' }}>
                        <div>
                          <strong>Lines:</strong> {component.metadata.lineCount}
                        </div>
                        <div>
                          <strong>Complexity:</strong> {component.metadata.complexity}/10
                        </div>
                        <div>
                          <strong>Deps:</strong> {component.dependencies.length}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {components.length === 0 && (
                <div style={{
                  textAlign: 'center',
                  padding: '50px',
                  color: '#666',
                  background: '#f9f9f9',
                  borderRadius: '16px'
                }}>
                  <div style={{ fontSize: '48px', marginBottom: '20px' }}>🔍</div>
                  <h3>No components found</h3>
                  <p>Try adjusting your search or filter settings.</p>
                </div>
              )}
            </div>
          );
        })()}

        {state.view === 'component' && state.selectedComponent && (() => {
          const component = state.selectedComponent;
          const risks = blueprint.riskAreas.filter(r => r.componentId === component.id);
          const riskLevel = getRiskLevel(component.id);
          const categoryData = categories.find(c => c.key === component.type);

          return (
            <div style={{ padding: '30px' }}>
              {/* Component header */}
              <div style={{
                background: `linear-gradient(135deg, ${categoryData?.color || '#667eea'}, ${categoryData?.color || '#667eea'}dd)`,
                color: 'white',
                padding: '30px',
                borderRadius: '20px',
                marginBottom: '30px',
                boxShadow: `0 8px 25px ${categoryData?.color || '#667eea'}40`
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                  <div>
                    <h1 style={{ margin: '0 0 10px 0', fontSize: '32px' }}>{component.name}</h1>
                    <p style={{ margin: '0 0 15px 0', opacity: 0.9, fontSize: '16px', fontFamily: 'monospace' }}>
                      {component.path}
                    </p>
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                      <span style={{
                        background: 'rgba(255,255,255,0.2)',
                        padding: '5px 12px',
                        borderRadius: '15px',
                        fontSize: '14px'
                      }}>
                        {categoryData?.icon} {component.type}
                      </span>
                      {component.metadata.isEntry && (
                        <span style={{
                          background: '#4CAF50',
                          padding: '5px 12px',
                          borderRadius: '15px',
                          fontSize: '14px'
                        }}>
                          🚪 Entry Point
                        </span>
                      )}
                      {riskLevel === 'high' && (
                        <span style={{
                          background: '#f44336',
                          padding: '5px 12px',
                          borderRadius: '15px',
                          fontSize: '14px'
                        }}>
                          🚨 Critical Risk
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '30px' }}>
                {/* Main content */}
                <div>
                  {/* Metrics */}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                    gap: '20px',
                    marginBottom: '30px'
                  }}>
                    <div style={{
                      background: 'white',
                      padding: '20px',
                      borderRadius: '16px',
                      textAlign: 'center',
                      boxShadow: '0 4px 15px rgba(0,0,0,0.08)'
                    }}>
                      <div style={{ fontSize: '28px', fontWeight: 'bold', color: categoryData?.color }}>
                        {component.metadata.lineCount}
                      </div>
                      <div style={{ fontSize: '14px', color: '#666' }}>Lines of Code</div>
                    </div>
                    <div style={{
                      background: 'white',
                      padding: '20px',
                      borderRadius: '16px',
                      textAlign: 'center',
                      boxShadow: '0 4px 15px rgba(0,0,0,0.08)'
                    }}>
                      <div style={{ fontSize: '28px', fontWeight: 'bold', color: categoryData?.color }}>
                        {component.metadata.complexity}/10
                      </div>
                      <div style={{ fontSize: '14px', color: '#666' }}>Complexity</div>
                    </div>
                    <div style={{
                      background: 'white',
                      padding: '20px',
                      borderRadius: '16px',
                      textAlign: 'center',
                      boxShadow: '0 4px 15px rgba(0,0,0,0.08)'
                    }}>
                      <div style={{ fontSize: '28px', fontWeight: 'bold', color: categoryData?.color }}>
                        {component.dependencies.length}
                      </div>
                      <div style={{ fontSize: '14px', color: '#666' }}>Dependencies</div>
                    </div>
                    <div style={{
                      background: 'white',
                      padding: '20px',
                      borderRadius: '16px',
                      textAlign: 'center',
                      boxShadow: '0 4px 15px rgba(0,0,0,0.08)'
                    }}>
                      <div style={{ fontSize: '28px', fontWeight: 'bold', color: categoryData?.color }}>
                        {component.dependents.length}
                      </div>
                      <div style={{ fontSize: '14px', color: '#666' }}>Dependents</div>
                    </div>
                  </div>

                  {/* HTTP Methods */}
                  {component.metadata.httpMethods && (
                    <div style={{
                      background: 'white',
                      padding: '25px',
                      borderRadius: '16px',
                      marginBottom: '25px',
                      boxShadow: '0 4px 15px rgba(0,0,0,0.08)'
                    }}>
                      <h3 style={{ marginBottom: '15px' }}>🌐 HTTP Methods</h3>
                      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                        {component.metadata.httpMethods.map(method => (
                          <span key={method} style={{
                            background: '#e3f2fd',
                            color: '#1976d2',
                            padding: '8px 16px',
                            borderRadius: '20px',
                            fontSize: '14px',
                            fontWeight: 'bold'
                          }}>
                            {method}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Dependencies */}
                  {component.dependencies.length > 0 && (
                    <div style={{
                      background: 'white',
                      padding: '25px',
                      borderRadius: '16px',
                      marginBottom: '25px',
                      boxShadow: '0 4px 15px rgba(0,0,0,0.08)'
                    }}>
                      <h3 style={{ marginBottom: '15px' }}>📦 Dependencies ({component.dependencies.length})</h3>
                      <div style={{ 
                        maxHeight: '200px', 
                        overflow: 'auto',
                        background: '#f8f9fa',
                        padding: '15px',
                        borderRadius: '8px'
                      }}>
                        {component.dependencies.map(dep => (
                          <div key={dep} style={{
                            fontFamily: 'monospace',
                            fontSize: '13px',
                            padding: '5px 0',
                            borderBottom: '1px solid #e0e0e0'
                          }}>
                            {dep}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Sidebar */}
                <div>
                  {/* Risk analysis */}
                  {risks.length > 0 && (
                    <div style={{
                      background: riskLevel === 'high' ? '#ffebee' : '#fff3e0',
                      border: `2px solid ${riskLevel === 'high' ? '#f44336' : '#ff9800'}`,
                      borderRadius: '16px',
                      padding: '25px',
                      marginBottom: '25px'
                    }}>
                      <h3 style={{ color: riskLevel === 'high' ? '#d32f2f' : '#f57c00', marginBottom: '15px' }}>
                        ⚠️ Risk Analysis
                      </h3>
                      {risks.map(risk => (
                        <div key={risk.componentId}>
                          <div style={{
                            fontWeight: 'bold',
                            color: riskLevel === 'high' ? '#d32f2f' : '#f57c00',
                            marginBottom: '10px',
                            fontSize: '16px'
                          }}>
                            Risk Level: {risk.riskLevel.toUpperCase()}
                          </div>
                          <div style={{ marginBottom: '15px' }}>
                            <strong>Issues:</strong>
                            <ul style={{ margin: '5px 0', paddingLeft: '20px' }}>
                              {risk.reasons.map((reason, idx) => (
                                <li key={idx} style={{ fontSize: '14px', marginBottom: '5px' }}>{reason}</li>
                              ))}
                            </ul>
                          </div>
                          <div style={{ fontStyle: 'italic', color: '#666', fontSize: '14px' }}>
                            <strong>Impact:</strong> {risk.impact}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Quick actions */}
                  <div style={{
                    background: 'white',
                    padding: '25px',
                    borderRadius: '16px',
                    boxShadow: '0 4px 15px rgba(0,0,0,0.08)'
                  }}>
                    <h3 style={{ marginBottom: '15px' }}>🚀 Quick Actions</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <button style={{
                        background: '#2196F3',
                        color: 'white',
                        border: 'none',
                        padding: '12px',
                        borderRadius: '8px',
                        cursor: 'pointer'
                      }}>
                        📁 View in File Explorer
                      </button>
                      <button style={{
                        background: '#4CAF50',
                        color: 'white',
                        border: 'none',
                        padding: '12px',
                        borderRadius: '8px',
                        cursor: 'pointer'
                      }}>
                        🔗 Show Connections
                      </button>
                      <button style={{
                        background: '#FF9800',
                        color: 'white',
                        border: 'none',
                        padding: '12px',
                        borderRadius: '8px',
                        cursor: 'pointer'
                      }}>
                        📊 Usage Analytics
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}