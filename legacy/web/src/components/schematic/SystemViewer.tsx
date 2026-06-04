import React, { useState, useEffect } from 'react';
import { Box, Container } from '@mui/material';
import { SystemSchematic } from './SystemSchematic';
import { SchematicNavigation } from './SchematicNavigation';
import { IssuesPanel } from './IssuesPanel';
import { ComponentDetailsPanel } from './ComponentDetailsPanel';

// Transform analysis data from backend to visualization format
const transformAnalysisData = (analysisData: any) => {
  if (!analysisData) {
    return {
      id: 'root',
      name: 'No Data Available',
      type: 'section' as const,
      status: 'critical' as const,
      position: { x: 0, y: 0 },
      size: { width: 800, height: 600 },
      connections: [],
      metrics: {
        cpu: 0,
        memory: 0,
        requests: 0,
        errors: 1,
        activeUsers: 0
      },
      issues: [{
        id: 'no-data',
        severity: 'high' as const,
        message: 'No analysis data available. Run analysis from Projects page.',
        component: 'system'
      }],
      children: []
    };
  }

  // Transform backend components and connections to visualization format
  const components = analysisData.components || [];
  const connections = analysisData.connections || [];
  
  return {
    id: 'root',
    name: analysisData.projectId || 'System Architecture',
    type: 'section' as const,
    status: 'healthy' as const,
    position: { x: 0, y: 0 },
    size: { width: 800, height: 600 },
    connections: [],
    metrics: {
      totalComponents: analysisData.metrics?.totalComponents || components.length,
      totalConnections: analysisData.metrics?.totalConnections || connections.length,
      analyzedFiles: analysisData.metrics?.analyzedFiles || 0,
      language: analysisData.language || 'Unknown'
    },
    issues: [],
    children: components.map((component: any, index: number) => ({
      id: component.id,
      name: component.name,
      type: 'subsystem' as const,
      status: 'healthy' as const,
      position: { 
        x: 50 + (index % 3) * 250, 
        y: 50 + Math.floor(index / 3) * 150 
      },
      size: { width: 200, height: 100 },
      connections: connections
        .filter((c: any) => c.sourceId === component.id)
        .map((c: any) => c.targetId),
      metrics: {
        path: component.path,
        type: component.type,
        dependencies: component.dependencies?.length || 0
      },
      issues: [],
      children: (component.dependencies || []).map((dep: string, depIndex: number) => ({
        id: `${component.id}-${dep}`,
        name: dep,
        type: 'component' as const,
        status: 'healthy' as const,
        position: { 
          x: 60 + (depIndex % 2) * 80, 
          y: 80 
        },
        size: { width: 70, height: 30 },
        connections: [],
        metrics: {},
        issues: []
      }))
    }))
  };
};

interface SystemViewerProps {
  projectId: string;
  analysisData?: any;
}

export const SystemViewer: React.FC<SystemViewerProps> = ({ projectId, analysisData }) => {
  const [systemData, setSystemData] = useState(() => transformAnalysisData(analysisData));
  const [currentPath, setCurrentPath] = useState([
    { id: 'root', name: 'System Overview', level: 0 }
  ]);
  const [currentZoom, setCurrentZoom] = useState(1);
  const [showIssuesPanel, setShowIssuesPanel] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectedComponent, setSelectedComponent] = useState<any>(null);
  const [showDetailsPanel, setShowDetailsPanel] = useState(false);

  // Update when analysis data changes
  useEffect(() => {
    setSystemData(transformAnalysisData(analysisData));
  }, [analysisData]);

  // Navigate to a specific level in the hierarchy
  const navigateToLevel = (levelId: string) => {
    if (levelId === 'root') {
      setCurrentPath([{ id: 'root', name: 'System Overview', level: 0 }]);
      setSystemData(transformAnalysisData(analysisData));
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

    const fullSystemData = transformAnalysisData(analysisData);
    const path = findPath(fullSystemData, levelId);
    
    if (path) {
      setCurrentPath(path);
      // Find and set the current node data
      let currentNode = fullSystemData;
      for (let i = 1; i < path.length; i++) {
        const nextNode = currentNode.children?.find((child: any) => child.id === path[i].id);
        if (nextNode) currentNode = nextNode;
      }
      setSystemData(currentNode);
    }
  };

  // Handle drilling down into a component
  const handleDrillDown = (nodeId: string) => {
    const targetNode = systemData.children?.find((child: any) => child.id === nodeId);
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
          currentPath={currentPath.map(p => p.name)}
        />
      </Box>

      {/* Issues Panel */}
      <IssuesPanel
        issues={allIssues}
        isOpen={showIssuesPanel}
        onClose={() => setShowIssuesPanel(false)}
        onIssueClick={(issue) => {
          if (issue && issue.component) {
            // Navigate to the component with the issue
            navigateToLevel(issue.component);
          }
        }}
        onNavigateToComponent={(componentId) => {
          navigateToLevel(componentId);
        }}
      />

      {/* Component Details Panel */}
      {showDetailsPanel && selectedComponent && (
        <ComponentDetailsPanel
          component={selectedComponent}
          isOpen={showDetailsPanel}
          onClose={() => setShowDetailsPanel(false)}
        />
      )}
    </Container>
  );
};

// Helper function to get component details
function getComponentDetails(nodeId: string) {
  return {
    id: nodeId,
    name: nodeId,
    type: 'component',
    status: 'healthy',
    metrics: {},
    dependencies: [],
    issues: []
  };
}