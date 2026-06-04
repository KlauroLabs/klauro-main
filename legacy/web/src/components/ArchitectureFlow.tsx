import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Box, Paper, Typography, Chip } from '@mui/material';

interface Component {
  id: string;
  name: string;
  type: string;
  layer: string;
  metrics?: {
    linesOfCode: number;
    complexity: number;
  };
  connections?: {
    incoming: number;
    outgoing: number;
  };
}

interface ArchitectureFlowProps {
  components: Component[];
  connections: Array<{
    from: string;
    to: string;
    type: string;
  }>;
}

const ArchitectureFlow: React.FC<ArchitectureFlowProps> = ({ components, connections }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dimensions, setDimensions] = useState({ width: 1200, height: 800 });

  useEffect(() => {
    if (!svgRef.current || !components.length) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    // Group components by layer
    const layers = {
      presentation: [] as Component[],
      business: [] as Component[],
      data: [] as Component[],
      infrastructure: [] as Component[],
      external: [] as Component[]
    };

    components.forEach(comp => {
      const layer = comp.layer || 'business';
      if (layer in layers) {
        layers[layer as keyof typeof layers].push(comp);
      }
    });

    // Calculate positions for each layer
    const layerWidth = dimensions.width / 5;
    const layerPositions = {
      presentation: 0,
      business: layerWidth,
      data: layerWidth * 2,
      infrastructure: layerWidth * 3,
      external: layerWidth * 4
    };

    // Create main group
    const g = svg.append('g')
      .attr('transform', 'translate(50, 50)');

    // Add layer backgrounds
    Object.entries(layerPositions).forEach(([layer, x]) => {
      const layerGroup = g.append('g')
        .attr('class', `layer-${layer}`);

      // Layer background
      layerGroup.append('rect')
        .attr('x', x)
        .attr('y', 0)
        .attr('width', layerWidth - 10)
        .attr('height', dimensions.height - 100)
        .attr('fill', 'none')
        .attr('stroke', '#333')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '5,5')
        .attr('rx', 10);

      // Layer label
      layerGroup.append('text')
        .attr('x', x + layerWidth / 2)
        .attr('y', -20)
        .attr('text-anchor', 'middle')
        .attr('fill', '#888')
        .attr('font-size', '14px')
        .attr('font-weight', 'bold')
        .text(layer.charAt(0).toUpperCase() + layer.slice(1));
    });

    // Position components within their layers
    const nodePositions = new Map<string, { x: number; y: number }>();

    Object.entries(layers).forEach(([layerName, layerComponents]) => {
      const x = layerPositions[layerName as keyof typeof layerPositions] + layerWidth / 2;
      const spacing = Math.min(80, (dimensions.height - 150) / (layerComponents.length + 1));

      layerComponents.forEach((comp, i) => {
        const y = 50 + (i + 1) * spacing;
        nodePositions.set(comp.id, { x, y });
      });
    });

    // Draw connections first (so they appear behind nodes)
    const connectionGroup = g.append('g').attr('class', 'connections');

    connections.forEach(conn => {
      const source = nodePositions.get(conn.from);
      const target = nodePositions.get(conn.to);

      if (source && target) {
        // Create curved path
        const midX = (source.x + target.x) / 2;
        const midY = (source.y + target.y) / 2;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const dr = Math.sqrt(dx * dx + dy * dy) / 2;

        connectionGroup.append('path')
          .attr('d', `M${source.x},${source.y} Q${midX},${midY - dr * 0.3} ${target.x},${target.y}`)
          .attr('fill', 'none')
          .attr('stroke', '#666')
          .attr('stroke-width', 1.5)
          .attr('opacity', 0.6)
          .attr('marker-end', 'url(#arrowhead)');
      }
    });

    // Add arrow marker definition
    svg.append('defs').append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 8)
      .attr('refY', 0)
      .attr('markerWidth', 8)
      .attr('markerHeight', 8)
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
        .style('cursor', 'pointer');

      // Determine node color based on type
      const getNodeColor = (type: string) => {
        const colors: Record<string, string> = {
          controller: '#4CAF50',
          service: '#2196F3',
          model: '#9C27B0',
          utility: '#FF9800',
          middleware: '#F44336',
          route: '#00BCD4',
          config: '#795548'
        };
        return colors[type] || '#607D8B';
      };

      // Node circle
      node.append('circle')
        .attr('r', 30)
        .attr('fill', getNodeColor(comp.type))
        .attr('opacity', 0.9)
        .attr('stroke', '#fff')
        .attr('stroke-width', 2);

      // Node label
      node.append('text')
        .attr('text-anchor', 'middle')
        .attr('dy', 45)
        .attr('font-size', '12px')
        .attr('fill', '#333')
        .text(comp.name.length > 20 ? comp.name.substring(0, 20) + '...' : comp.name);

      // Add metrics on hover
      node.on('mouseenter', function() {
        d3.select(this).select('circle')
          .transition()
          .duration(200)
          .attr('r', 35);
      })
      .on('mouseleave', function() {
        d3.select(this).select('circle')
          .transition()
          .duration(200)
          .attr('r', 30);
      });

      // Add tooltip
      node.append('title')
        .text(`${comp.name}
Type: ${comp.type}
Layer: ${comp.layer}
Lines: ${comp.metrics?.linesOfCode || 0}
Complexity: ${comp.metrics?.complexity || 0}
Connections In: ${comp.connections?.incoming || 0}
Connections Out: ${comp.connections?.outgoing || 0}`);
    });

    // Add zoom behavior
    const zoom = d3.zoom()
      .scaleExtent([0.5, 2])
      .on('zoom', (event) => {
        g.attr('transform', `translate(${event.transform.x + 50}, ${event.transform.y + 50}) scale(${event.transform.k})`);
      });

    svg.call(zoom as any);

  }, [components, connections, dimensions]);

  return (
    <Paper sx={{ p: 2, height: '100%', bgcolor: '#1a1a1a' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h6" sx={{ color: '#fff' }}>
          Architecture Flow Diagram
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Chip label="Presentation" size="small" sx={{ bgcolor: '#333', color: '#fff' }} />
          <Chip label="Business" size="small" sx={{ bgcolor: '#333', color: '#fff' }} />
          <Chip label="Data" size="small" sx={{ bgcolor: '#333', color: '#fff' }} />
          <Chip label="Infrastructure" size="small" sx={{ bgcolor: '#333', color: '#fff' }} />
        </Box>
      </Box>
      <svg
        ref={svgRef}
        width="100%"
        height={dimensions.height}
        style={{ backgroundColor: '#0a0a0a', borderRadius: '8px' }}
      />
    </Paper>
  );
};

export default ArchitectureFlow;