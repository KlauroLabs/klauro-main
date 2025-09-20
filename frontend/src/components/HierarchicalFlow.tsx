import React, { useEffect, useRef, useMemo } from 'react';
import * as d3 from 'd3';
import { Box, Paper, Typography } from '@mui/material';

interface Component {
  id: string;
  name: string;
  type: string;
  path?: string;
  layer?: string;
  metadata?: any;
}

interface Connection {
  id: string;
  from: string;
  to: string;
  type: string;
  weight: number;
}

interface HierarchicalFlowProps {
  components: Component[];
  connections: Connection[];
  onComponentClick?: (component: Component) => void;
}

const HierarchicalFlow: React.FC<HierarchicalFlowProps> = ({
  components,
  connections,
  onComponentClick
}) => {
  const svgRef = useRef<SVGSVGElement>(null);

  // Categorize components by type into layers
  const categorizedComponents = useMemo(() => {
    const layers = {
      presentation: [] as Component[],
      business: [] as Component[],
      data: [] as Component[],
      infrastructure: [] as Component[],
      external: [] as Component[]
    };

    components.forEach(comp => {
      // Categorize based on path and type
      const path = comp.path?.toLowerCase() || '';
      const type = comp.type?.toLowerCase() || '';
      const name = comp.name?.toLowerCase() || '';

      if (path.includes('/pages/') || path.includes('/components/') ||
          type.includes('page') || type.includes('component') ||
          name.includes('page') || name.includes('view')) {
        layers.presentation.push(comp);
      } else if (path.includes('/services/') || path.includes('/hooks/') ||
                 type.includes('service') || type.includes('hook') ||
                 name.includes('service') || name.includes('hook')) {
        layers.business.push(comp);
      } else if (path.includes('/database/') || path.includes('/entities/') ||
                 type.includes('entity') || type.includes('model') ||
                 name.includes('entity') || name.includes('model')) {
        layers.data.push(comp);
      } else if (path.includes('/utils/') || path.includes('/lib/') ||
                 type.includes('utility') || type.includes('helper')) {
        layers.infrastructure.push(comp);
      } else {
        // Default to business layer
        layers.business.push(comp);
      }
    });

    return layers;
  }, [components]);

  useEffect(() => {
    if (!svgRef.current || components.length === 0) return;

    const width = 1400;
    const height = 800;
    const margin = { top: 50, right: 50, bottom: 50, left: 50 };

    // Clear previous content
    d3.select(svgRef.current).selectAll('*').remove();

    const svg = d3.select(svgRef.current)
      .attr('width', width)
      .attr('height', height);

    // Create main group
    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Calculate layout dimensions
    const layoutWidth = width - margin.left - margin.right;
    const layoutHeight = height - margin.top - margin.bottom;
    const layerWidth = layoutWidth / 5;

    // Layer positions
    const layerPositions = {
      presentation: 0,
      business: layerWidth,
      data: layerWidth * 2,
      infrastructure: layerWidth * 3,
      external: layerWidth * 4
    };

    // Create layer backgrounds
    Object.entries(layerPositions).forEach(([layer, x]) => {
      const layerGroup = g.append('g')
        .attr('class', `layer-${layer}`);

      // Layer background
      layerGroup.append('rect')
        .attr('x', x)
        .attr('y', 0)
        .attr('width', layerWidth - 10)
        .attr('height', layoutHeight)
        .attr('fill', 'none')
        .attr('stroke', '#444')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '5,5')
        .attr('rx', 10)
        .attr('opacity', 0.3);

      // Layer label
      layerGroup.append('text')
        .attr('x', x + layerWidth / 2)
        .attr('y', -20)
        .attr('text-anchor', 'middle')
        .attr('fill', '#aaa')
        .attr('font-size', '14px')
        .attr('font-weight', 'bold')
        .text(layer.charAt(0).toUpperCase() + layer.slice(1));
    });

    // Position nodes
    const nodePositions = new Map<string, { x: number; y: number }>();

    Object.entries(categorizedComponents).forEach(([layerName, layerComponents]) => {
      const x = layerPositions[layerName as keyof typeof layerPositions] + layerWidth / 2;
      const verticalSpacing = Math.min(60, layoutHeight / (layerComponents.length + 1));

      layerComponents.forEach((comp, i) => {
        const y = (i + 1) * verticalSpacing;
        nodePositions.set(comp.id, { x, y });
      });
    });

    // Draw connections first (so they appear behind nodes)
    const connectionGroup = g.append('g').attr('class', 'connections');

    connections.forEach(conn => {
      const source = nodePositions.get(conn.from);
      const target = nodePositions.get(conn.to);

      if (source && target) {
        // Create curved path for better visibility
        const midX = (source.x + target.x) / 2;
        const curve = Math.abs(target.x - source.x) / 4;

        connectionGroup.append('path')
          .attr('d', `M ${source.x},${source.y} Q ${midX},${source.y - curve} ${target.x},${target.y}`)
          .attr('fill', 'none')
          .attr('stroke', '#666')
          .attr('stroke-width', Math.max(0.5, Math.min(3, conn.weight * 0.5)))
          .attr('opacity', 0.4)
          .attr('marker-end', 'url(#arrowhead)');
      }
    });

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

    // Draw component nodes
    const nodeGroup = g.append('g').attr('class', 'nodes');

    components.forEach(comp => {
      const pos = nodePositions.get(comp.id);
      if (!pos) return;

      const node = nodeGroup.append('g')
        .attr('transform', `translate(${pos.x}, ${pos.y})`)
        .style('cursor', 'pointer')
        .on('click', () => onComponentClick?.(comp));

      // Determine node color based on type
      const getNodeColor = (type: string) => {
        const colors: Record<string, string> = {
          page: '#4CAF50',
          component: '#2196F3',
          service: '#9C27B0',
          hook: '#FF9800',
          utility: '#607D8B',
          model: '#F44336',
          entity: '#E91E63'
        };

        const typeKey = Object.keys(colors).find(key =>
          type.toLowerCase().includes(key)
        );
        return colors[typeKey || 'utility'];
      };

      // Node circle
      const circle = node.append('circle')
        .attr('r', 20)
        .attr('fill', getNodeColor(comp.type))
        .attr('opacity', 0.8)
        .attr('stroke', '#fff')
        .attr('stroke-width', 2);

      // Node label
      node.append('text')
        .attr('text-anchor', 'middle')
        .attr('dy', 35)
        .attr('font-size', '10px')
        .attr('fill', '#ccc')
        .text(comp.name.length > 15 ? comp.name.substring(0, 15) + '...' : comp.name);

      // Add hover effects
      node.on('mouseenter', function() {
        d3.select(this).select('circle')
          .transition()
          .duration(200)
          .attr('r', 25)
          .attr('opacity', 1);
      })
      .on('mouseleave', function() {
        d3.select(this).select('circle')
          .transition()
          .duration(200)
          .attr('r', 20)
          .attr('opacity', 0.8);
      });

      // Add tooltip
      node.append('title')
        .text(`${comp.name}
Type: ${comp.type}
Path: ${comp.path || 'N/A'}
Connections: ${connections.filter(c => c.from === comp.id || c.to === comp.id).length}`);
    });

    // Add zoom behavior
    const zoom = d3.zoom()
      .scaleExtent([0.5, 3])
      .on('zoom', (event) => {
        g.attr('transform', `translate(${event.transform.x + margin.left}, ${event.transform.y + margin.top}) scale(${event.transform.k})`);
      });

    svg.call(zoom as any);

  }, [components, connections, categorizedComponents, onComponentClick]);

  return (
    <Paper sx={{ p: 2, height: '100%', bgcolor: '#1a1a1a' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h6" sx={{ color: '#fff' }}>
          System Architecture - Hierarchical View
        </Typography>
        <Box sx={{ color: '#aaa' }}>
          {components.length} components • {connections.length} connections
        </Box>
      </Box>
      <svg
        ref={svgRef}
        style={{
          backgroundColor: '#0a0a0a',
          borderRadius: '8px',
          width: '100%',
          height: 'calc(100% - 60px)'
        }}
      />
    </Paper>
  );
};

export default HierarchicalFlow;