import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as d3 from 'd3';
import { Box, Paper, Typography, Button } from '@mui/material';

interface Component {
  id: string;
  name: string;
  type: string;
  path?: string;
  layer?: string;
  metadata?: any;
  connections?: number;
  critical?: boolean;
  orphaned?: boolean;
  metrics?: {
    complexity?: number;
    coupling?: number;
    dependencies?: number;
    dependents?: number;
    cohesion?: number;
  };
}

interface Connection {
  id: string;
  from: string;
  to: string;
  type: string;
  weight: number;
}

interface DrillDownSection {
  id: string;
  name: string;
  type: string;
  components: Component[];
  bounds: { x: number; y: number; width: number; height: number };
  health: 'healthy' | 'warning' | 'critical' | 'offline';
  activity: number;
}

interface DrillDownLevel {
  level: number;
  sections: DrillDownSection[];
  connections: Array<{
    from: string;
    to: string;
    path: Array<{ x: number; y: number }>;
    activity: number;
    type: 'data' | 'control' | 'event';
  }>;
}

interface DrillDownVisualizationProps {
  components: Component[];
  connections: Connection[];
  onComponentClick?: (component: Component) => void;
}

const DrillDownVisualization: React.FC<DrillDownVisualizationProps> = ({
  components,
  connections,
  onComponentClick
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [currentLevel, setCurrentLevel] = useState(0);
  const [navigationStack, setNavigationStack] = useState<string[]>([]);
  const [levelData, setLevelData] = useState<DrillDownLevel[]>([]);

  // Group components by logical sections (not rigid layers)
  const createSections = useCallback((comps: Component[]): DrillDownSection[] => {
    const sectionMap = new Map<string, Component[]>();

    comps.forEach(comp => {
      // Group by directory structure or component type
      let sectionKey = 'components';

      if (comp.path) {
        const pathParts = comp.path.split('/');
        if (pathParts.length > 1) {
          sectionKey = pathParts[pathParts.length - 2] || 'components';
        }
      } else if (comp.type) {
        sectionKey = comp.type;
      }

      if (!sectionMap.has(sectionKey)) {
        sectionMap.set(sectionKey, []);
      }
      sectionMap.get(sectionKey)!.push(comp);
    });

    // Convert to sections with layout
    const sections: DrillDownSection[] = [];
    const sectionLayout = calculateSectionLayout(sectionMap.size);

    let index = 0;
    sectionMap.forEach((sectionComponents, key) => {
      const position = sectionLayout[index];
      sections.push({
        id: key,
        name: key.charAt(0).toUpperCase() + key.slice(1),
        type: key,
        components: sectionComponents,
        bounds: position,
        health: calculateSectionHealth(sectionComponents),
        activity: calculateSectionActivity(sectionComponents)
      });
      index++;
    });

    return sections;
  }, []);

  const calculateSectionLayout = (sectionCount: number): Array<{ x: number; y: number; width: number; height: number }> => {
    const width = 1400;
    const height = 800;
    const padding = 60;
    const minWidth = 200;
    const minHeight = 150;

    const availableWidth = width - padding * 2;
    const availableHeight = height - padding * 2;

    const cols = Math.min(Math.ceil(Math.sqrt(sectionCount)), 3);
    const rows = Math.ceil(sectionCount / cols);

    const sectionWidth = Math.max(minWidth, (availableWidth - (cols - 1) * 40) / cols);
    const sectionHeight = Math.max(minHeight, (availableHeight - (rows - 1) * 40) / rows);

    const positions = [];
    for (let i = 0; i < sectionCount; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);

      positions.push({
        x: padding + col * (sectionWidth + 40),
        y: padding + row * (sectionHeight + 40),
        width: sectionWidth,
        height: sectionHeight
      });
    }

    return positions;
  };

  const calculateSectionHealth = (components: Component[]): 'healthy' | 'warning' | 'critical' | 'offline' => {
    if (components.length === 0) return 'offline';

    let criticalCount = 0;
    let warningCount = 0;

    components.forEach(comp => {
      if (comp.critical) criticalCount++;
      if (comp.orphaned) warningCount++;
    });

    const criticalRatio = criticalCount / components.length;
    const warningRatio = warningCount / components.length;

    if (criticalRatio > 0.3) return 'critical';
    if (criticalRatio > 0.1 || warningRatio > 0.2) return 'warning';
    if (components.every(c => c.orphaned)) return 'offline';

    return 'healthy';
  };

  const calculateSectionActivity = (components: Component[]): number => {
    if (components.length === 0) return 0;

    let totalActivity = 0;
    components.forEach(comp => {
      const connectionActivity = Math.min((comp.connections || 0) / 10, 1);
      totalActivity += connectionActivity;
    });

    return Math.min(totalActivity / components.length, 1);
  };

  // Initialize level data
  useEffect(() => {
    if (components.length === 0) return;

    const levels: DrillDownLevel[] = [];

    // Level 0: Main sections overview
    const mainSections = createSections(components);
    levels.push({
      level: 0,
      sections: mainSections,
      connections: createSectionConnections(mainSections, connections)
    });

    // Level 1+: Component details within each section
    mainSections.forEach((section, index) => {
      if (section.components.length > 0) {
        const componentSections = createComponentSections(section);
        levels.push({
          level: index + 1,
          sections: componentSections,
          connections: createComponentConnections(section, connections)
        });
      }
    });

    setLevelData(levels);
  }, [components, connections, createSections]);

  const createSectionConnections = (sections: DrillDownSection[], conns: Connection[]) => {
    const sectionConnections: Array<{
      from: string;
      to: string;
      path: Array<{ x: number; y: number }>;
      activity: number;
      type: 'data' | 'control' | 'event';
    }> = [];

    for (const connection of conns) {
      const sourceSection = sections.find(s =>
        s.components.some(c => c.id === connection.from)
      );
      const targetSection = sections.find(s =>
        s.components.some(c => c.id === connection.to)
      );

      if (sourceSection && targetSection && sourceSection.id !== targetSection.id) {
        const sourceBounds = sourceSection.bounds;
        const targetBounds = targetSection.bounds;

        sectionConnections.push({
          from: sourceSection.id,
          to: targetSection.id,
          path: calculateConnectionPath(sourceBounds, targetBounds),
          activity: Math.min(connection.weight / 10, 1) || 0.3,
          type: connection.type === 'control' || connection.type === 'event' ? connection.type as 'control' | 'event' : 'data'
        });
      }
    }

    return sectionConnections;
  };

  const createComponentSections = (parentSection: DrillDownSection): DrillDownSection[] => {
    const componentSections: DrillDownSection[] = [];
    const componentLayout = calculateComponentLayout(parentSection.components.length, parentSection.bounds);

    parentSection.components.forEach((component, index) => {
      const position = componentLayout[index];

      componentSections.push({
        id: component.id,
        name: component.name,
        type: component.type,
        components: [component],
        bounds: position,
        health: calculateComponentHealth(component),
        activity: calculateComponentActivity(component)
      });
    });

    return componentSections;
  };

  const calculateComponentLayout = (componentCount: number, parentBounds: { x: number; y: number; width: number; height: number }) => {
    const padding = 20;
    const headerHeight = 40;
    const minWidth = 120;
    const minHeight = 80;

    const availableWidth = parentBounds.width - padding * 2;
    const availableHeight = parentBounds.height - headerHeight - padding * 2;

    const cols = Math.min(Math.ceil(Math.sqrt(componentCount)), 4);
    const rows = Math.ceil(componentCount / cols);

    const componentWidth = Math.max(minWidth, (availableWidth - (cols - 1) * 15) / cols);
    const componentHeight = Math.max(minHeight, (availableHeight - (rows - 1) * 15) / rows);

    const positions = [];
    for (let i = 0; i < componentCount; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);

      positions.push({
        x: parentBounds.x + padding + col * (componentWidth + 15),
        y: parentBounds.y + headerHeight + padding + row * (componentHeight + 15),
        width: componentWidth,
        height: componentHeight
      });
    }

    return positions;
  };

  const calculateComponentHealth = (component: Component): 'healthy' | 'warning' | 'critical' | 'offline' => {
    if (component.critical) return 'critical';
    if (component.orphaned) return 'warning';

    if (component.metrics) {
      const { complexity, coupling } = component.metrics;
      if (complexity && complexity > 80) return 'critical';
      if (complexity && complexity > 50) return 'warning';
      if (coupling && coupling > 0.8) return 'critical';
      if (coupling && coupling > 0.6) return 'warning';
    }

    return 'healthy';
  };

  const calculateComponentActivity = (component: Component): number => {
    let activity = 0.1;

    if (component.connections) {
      activity += Math.min(component.connections / 20, 0.5);
    }

    if (component.metrics) {
      const { dependencies = 0, dependents = 0, coupling = 0 } = component.metrics;
      activity += Math.min((dependencies + dependents) / 30, 0.3);
      activity += Math.min(coupling * 0.2, 0.2);
    }

    if (component.critical) activity += 0.2;
    if (component.orphaned) activity = Math.min(activity * 0.1, 0.05);

    return Math.min(activity, 1);
  };

  const createComponentConnections = (section: DrillDownSection, conns: Connection[]) => {
    const componentConnections: Array<{
      from: string;
      to: string;
      path: Array<{ x: number; y: number }>;
      activity: number;
      type: 'data' | 'control' | 'event';
    }> = [];

    const componentIds = new Set(section.components.map(c => c.id));

    for (const connection of conns) {
      if (componentIds.has(connection.from) && componentIds.has(connection.to)) {
        const sourceComponent = section.components.find(c => c.id === connection.from);
        const targetComponent = section.components.find(c => c.id === connection.to);

        if (sourceComponent && targetComponent) {
          const componentSections = createComponentSections(section);
          const sourceBounds = componentSections.find(cs => cs.id === sourceComponent.id)?.bounds;
          const targetBounds = componentSections.find(cs => cs.id === targetComponent.id)?.bounds;

          if (sourceBounds && targetBounds) {
            componentConnections.push({
              from: connection.from,
              to: connection.to,
              path: calculateConnectionPath(sourceBounds, targetBounds),
              activity: Math.min(connection.weight / 10, 1) || 0.3,
              type: connection.type === 'control' || connection.type === 'event' ? connection.type as 'control' | 'event' : 'data'
            });
          }
        }
      }
    }

    return componentConnections;
  };

  const calculateConnectionPath = (source: { x: number; y: number; width: number; height: number }, target: { x: number; y: number; width: number; height: number }): Array<{ x: number; y: number }> => {
    const sourceCenter = {
      x: source.x + source.width / 2,
      y: source.y + source.height / 2
    };
    const targetCenter = {
      x: target.x + target.width / 2,
      y: target.y + target.height / 2
    };

    const midX = (sourceCenter.x + targetCenter.x) / 2;
    const midY = (sourceCenter.y + targetCenter.y) / 2;

    return [
      sourceCenter,
      { x: midX, y: sourceCenter.y },
      { x: midX, y: midY },
      { x: midX, y: targetCenter.y },
      targetCenter
    ];
  };

  const getHealthColor = (health: string): string => {
    const colors: Record<string, string> = {
      'healthy': '#00ff88',
      'warning': '#ffaa00',
      'critical': '#ff3366',
      'offline': '#666666'
    };
    return colors[health] || colors.offline;
  };

  // Render the current level
  useEffect(() => {
    if (!svgRef.current || levelData.length === 0) return;

    const width = 1400;
    const height = 800;

    // Clear previous content
    d3.select(svgRef.current).selectAll('*').remove();

    const svg = d3.select(svgRef.current)
      .attr('width', width)
      .attr('height', height);

    // Add arrow marker definition
    svg.append('defs').append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 25)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#666');

    const currentLevelData = levelData[currentLevel];
    if (!currentLevelData) return;

    // Create main group
    const g = svg.append('g');

    // Draw connections first (so they appear behind sections)
    const connectionGroup = g.append('g').attr('class', 'connections');

    currentLevelData.connections.forEach(conn => {
      const line = d3.line<{x: number, y: number}>()
        .x(d => d.x)
        .y(d => d.y)
        .curve(d3.curveCardinal);

      connectionGroup
        .append('path')
        .datum(conn.path)
        .attr('d', line)
        .attr('fill', 'none')
        .attr('stroke', '#666')
        .attr('stroke-width', Math.max(1, conn.activity * 4))
        .attr('stroke-opacity', 0.6)
        .attr('marker-end', 'url(#arrowhead)');
    });

    // Draw sections
    const sectionGroups = g
      .selectAll('.section')
      .data(currentLevelData.sections)
      .enter()
      .append('g')
      .attr('class', 'section')
      .attr('cursor', 'pointer')
      .on('click', (event, d) => {
        if (currentLevel === 0) {
          drillDown(d.id);
        } else {
          // At component level, trigger component click
          onComponentClick?.(d.components[0]);
        }
      });

    // Section backgrounds
    sectionGroups
      .append('rect')
      .attr('x', d => d.bounds.x)
      .attr('y', d => d.bounds.y)
      .attr('width', d => d.bounds.width)
      .attr('height', d => d.bounds.height)
      .attr('fill', 'rgba(0, 0, 0, 0.1)')
      .attr('stroke', d => getHealthColor(d.health))
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', d => d.health === 'critical' ? '5,5' : 'none')
      .attr('rx', 8);

    // Section titles
    sectionGroups
      .append('text')
      .attr('x', d => d.bounds.x + 16)
      .attr('y', d => d.bounds.y + 24)
      .text(d => d.name)
      .attr('fill', '#ccc')
      .attr('font-size', currentLevel === 0 ? '14px' : '12px')
      .attr('font-weight', 'bold');

    // Component count or type indicators
    sectionGroups
      .append('text')
      .attr('x', d => d.bounds.x + d.bounds.width - 16)
      .attr('y', d => d.bounds.y + 24)
      .text(d => currentLevel === 0 ? `${d.components.length} COMPONENTS` : d.type.toUpperCase())
      .attr('fill', '#aaa')
      .attr('font-size', '10px')
      .attr('text-anchor', 'end')
      .attr('opacity', 0.7);

    // Activity indicators
    sectionGroups
      .append('rect')
      .attr('x', d => d.bounds.x + 16)
      .attr('y', d => d.bounds.y + d.bounds.height - 20)
      .attr('width', d => (d.bounds.width - 32) * d.activity)
      .attr('height', 4)
      .attr('fill', d => getHealthColor(d.health))
      .attr('opacity', 0.8);

    // Status text
    sectionGroups
      .append('text')
      .attr('x', d => d.bounds.x + 16)
      .attr('y', d => d.bounds.y + d.bounds.height - 6)
      .text(d => `STATUS: ${d.health.toUpperCase()}`)
      .attr('fill', '#aaa')
      .attr('font-size', '9px')
      .attr('opacity', 0.6);

    // Add hover effects
    sectionGroups
      .on('mouseenter', function(event, d) {
        d3.select(this).select('rect')
          .transition()
          .duration(200)
          .attr('stroke-width', 3)
          .attr('fill', 'rgba(0, 0, 0, 0.2)');
      })
      .on('mouseleave', function(event, d) {
        d3.select(this).select('rect')
          .transition()
          .duration(200)
          .attr('stroke-width', 2)
          .attr('fill', 'rgba(0, 0, 0, 0.1)');
      });

  }, [levelData, currentLevel]);

  const drillDown = (sectionId: string) => {
    // Find the corresponding level for this section
    const mainSections = levelData[0]?.sections || [];
    const sectionIndex = mainSections.findIndex(s => s.id === sectionId);

    if (sectionIndex > -1 && levelData.length > sectionIndex + 1) {
      setCurrentLevel(sectionIndex + 1);
      setNavigationStack(prev => [...prev, sectionId]);
    }
  };

  const navigateBack = () => {
    if (navigationStack.length > 0) {
      setCurrentLevel(0);
      setNavigationStack([]);
    }
  };

  const navigateToRoot = () => {
    setCurrentLevel(0);
    setNavigationStack([]);
  };

  return (
    <Paper sx={{ p: 2, height: '100%', bgcolor: '#1a1a1a' }}>
      {/* Navigation Controls */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Button
            variant="outlined"
            size="small"
            onClick={navigateToRoot}
            disabled={navigationStack.length === 0}
          >
            System Overview
          </Button>
          {navigationStack.length > 0 && (
            <Button
              variant="outlined"
              size="small"
              onClick={navigateBack}
            >
              Back
            </Button>
          )}
        </Box>

        <Typography variant="h6" sx={{ color: '#fff' }}>
          {currentLevel === 0 ? 'System Architecture' : 'Component Details'}
        </Typography>

        <Box sx={{ color: '#aaa' }}>
          {components.length} components • {connections.length} connections
        </Box>
      </Box>

      {/* Status Bar */}
      <Box sx={{
        mb: 2,
        p: 1,
        bgcolor: 'rgba(255,255,255,0.05)',
        borderRadius: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: '0.75rem',
        color: 'text.secondary'
      }}>
        <Box>
          Drill-down Visualization • Click sections to explore • Level {currentLevel}
        </Box>
        <Box>
          {navigationStack.length > 0 ? navigationStack[navigationStack.length - 1] : 'System Overview'}
        </Box>
      </Box>

      <svg
        ref={svgRef}
        style={{
          backgroundColor: '#0a0a0a',
          borderRadius: '8px',
          width: '100%',
          height: 'calc(100% - 120px)'
        }}
      />
    </Paper>
  );
};

export default DrillDownVisualization;