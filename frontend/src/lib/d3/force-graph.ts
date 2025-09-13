import * as d3 from 'd3';
import { ArchitectureBlueprint, Component, Connection } from '@/types/visualization';

export interface ForceGraphOptions {
  width?: number;
  height?: number;
  layout?: string;
  theme?: 'light' | 'dark' | 'blueprint';
  nodeRadius?: number;
  linkDistance?: number;
  chargeStrength?: number;
  centerStrength?: number;
  onNodeClick?: (node: any) => void;
  onEdgeClick?: (edge: any) => void;
}

export class ForceGraph {
  private container: HTMLElement;
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private g: d3.Selection<SVGGElement, unknown, null, undefined>;
  private simulation: d3.Simulation<any, any> | null = null;
  private nodes: any[] = [];
  private links: any[] = [];
  private options: ForceGraphOptions;
  private zoom: d3.ZoomBehavior<Element, unknown>;
  private currentTransform: d3.ZoomTransform = d3.zoomIdentity;

  constructor(container: HTMLElement, options: ForceGraphOptions = {}) {
    this.container = container;
    this.options = {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: 'force',
      theme: 'light',
      nodeRadius: 8,
      linkDistance: 50,
      chargeStrength: -300,
      centerStrength: 0.05,
      ...options
    };

    this.svg = d3.select(container)
      .append('svg')
      .attr('width', this.options.width!)
      .attr('height', this.options.height!);

    this.g = this.svg.append('g');

    this.zoom = d3.zoom()
      .scaleExtent([0.1, 5])
      .on('zoom', (event) => {
        this.currentTransform = event.transform;
        this.g.attr('transform', event.transform.toString());
      });

    this.svg.call(this.zoom as any);

    this.setupDefs();
    this.setupResizeObserver();
  }

  private setupDefs(): void {
    const defs = this.svg.append('defs');

    defs.append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '-0 -5 10 10')
      .attr('refX', 13)
      .attr('refY', 0)
      .attr('orient', 'auto')
      .attr('markerWidth', 13)
      .attr('markerHeight', 13)
      .append('path')
      .attr('d', 'M 0,-5 L 10,0 L 0,5')
      .attr('fill', '#999');

    const gradient = defs.append('linearGradient')
      .attr('id', 'node-gradient')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '100%')
      .attr('y2', '100%');

    gradient.append('stop')
      .attr('offset', '0%')
      .style('stop-color', '#4CAF50')
      .style('stop-opacity', 1);

    gradient.append('stop')
      .attr('offset', '100%')
      .style('stop-color', '#2196F3')
      .style('stop-opacity', 1);
  }

  private setupResizeObserver(): void {
    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        this.options.width = width;
        this.options.height = height;
        this.svg.attr('width', width).attr('height', height);
        if (this.simulation) {
          this.simulation.force('center', d3.forceCenter(width / 2, height / 2));
          this.simulation.alpha(0.3).restart();
        }
      }
    });

    resizeObserver.observe(this.container);
  }

  render(blueprint: ArchitectureBlueprint): void {
    this.nodes = blueprint.components.map(c => ({
      ...c,
      x: Math.random() * this.options.width!,
      y: Math.random() * this.options.height!
    }));

    this.links = blueprint.connections.map(c => ({
      ...c,
      source: c.sourceId,
      target: c.targetId
    }));

    this.clearVisualization();
    
    switch (this.options.layout) {
      case 'hierarchical':
        this.applyHierarchicalLayout();
        break;
      case 'circular':
        this.applyCircularLayout();
        break;
      case 'grid':
        this.applyGridLayout();
        break;
      case 'radial':
        this.applyRadialLayout();
        break;
      default:
        this.applyForceLayout();
    }

    this.drawLinks();
    this.drawNodes();
  }

  private applyForceLayout(): void {
    this.simulation = d3.forceSimulation(this.nodes)
      .force('link', d3.forceLink(this.links)
        .id((d: any) => d.id)
        .distance(this.options.linkDistance!))
      .force('charge', d3.forceManyBody()
        .strength(this.options.chargeStrength!))
      .force('center', d3.forceCenter(
        this.options.width! / 2,
        this.options.height! / 2
      ))
      .force('collision', d3.forceCollide()
        .radius((d: any) => this.getNodeRadius(d) + 5));

    this.simulation.on('tick', () => this.updatePositions());
  }

  private applyHierarchicalLayout(): void {
    const stratify = d3.stratify()
      .id((d: any) => d.id)
      .parentId((d: any) => {
        const link = this.links.find(l => l.target === d.id);
        return link ? link.source : null;
      });

    try {
      const root = stratify(this.nodes);
      const treeLayout = d3.tree()
        .size([this.options.width! - 100, this.options.height! - 100]);
      
      const treeData = treeLayout(root);
      
      treeData.descendants().forEach((d: any) => {
        const node = this.nodes.find(n => n.id === d.id);
        if (node) {
          node.x = d.x + 50;
          node.y = d.y + 50;
        }
      });
    } catch (e) {
      this.applyForceLayout();
    }
  }

  private applyCircularLayout(): void {
    const radius = Math.min(this.options.width!, this.options.height!) / 3;
    const center = {
      x: this.options.width! / 2,
      y: this.options.height! / 2
    };

    this.nodes.forEach((node, i) => {
      const angle = (i / this.nodes.length) * 2 * Math.PI;
      node.x = center.x + radius * Math.cos(angle);
      node.y = center.y + radius * Math.sin(angle);
    });
  }

  private applyGridLayout(): void {
    const cols = Math.ceil(Math.sqrt(this.nodes.length));
    const rows = Math.ceil(this.nodes.length / cols);
    const cellWidth = this.options.width! / (cols + 1);
    const cellHeight = this.options.height! / (rows + 1);

    this.nodes.forEach((node, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      node.x = (col + 1) * cellWidth;
      node.y = (row + 1) * cellHeight;
    });
  }

  private applyRadialLayout(): void {
    const center = {
      x: this.options.width! / 2,
      y: this.options.height! / 2
    };

    const levels = this.calculateLevels();
    const maxLevel = Math.max(...levels.values());
    const radiusStep = Math.min(this.options.width!, this.options.height!) / (2 * (maxLevel + 1));

    const levelNodes = new Map<number, any[]>();
    this.nodes.forEach(node => {
      const level = levels.get(node.id) || 0;
      if (!levelNodes.has(level)) {
        levelNodes.set(level, []);
      }
      levelNodes.get(level)!.push(node);
    });

    levelNodes.forEach((nodes, level) => {
      const radius = level * radiusStep;
      nodes.forEach((node, i) => {
        const angle = (i / nodes.length) * 2 * Math.PI;
        node.x = center.x + radius * Math.cos(angle);
        node.y = center.y + radius * Math.sin(angle);
      });
    });
  }

  private calculateLevels(): Map<string, number> {
    const levels = new Map<string, number>();
    const visited = new Set<string>();
    
    const rootNodes = this.nodes.filter(n => 
      !this.links.some(l => l.target === n.id)
    );

    rootNodes.forEach(root => {
      const queue = [{ node: root, level: 0 }];
      
      while (queue.length > 0) {
        const { node, level } = queue.shift()!;
        
        if (visited.has(node.id)) continue;
        visited.add(node.id);
        levels.set(node.id, level);
        
        const children = this.links
          .filter(l => l.source === node.id)
          .map(l => this.nodes.find(n => n.id === l.target))
          .filter(n => n && !visited.has(n.id));
        
        children.forEach(child => {
          queue.push({ node: child, level: level + 1 });
        });
      }
    });

    this.nodes.forEach(node => {
      if (!levels.has(node.id)) {
        levels.set(node.id, 0);
      }
    });

    return levels;
  }

  private drawLinks(): void {
    const linkGroup = this.g.append('g')
      .attr('class', 'links');

    const links = linkGroup.selectAll('line')
      .data(this.links)
      .enter().append('line')
      .attr('stroke', '#999')
      .attr('stroke-opacity', 0.6)
      .attr('stroke-width', (d: any) => Math.sqrt(d.weight || 1))
      .attr('marker-end', 'url(#arrowhead)')
      .on('click', (event, d) => {
        event.stopPropagation();
        this.options.onEdgeClick?.(d);
      });

    if (this.simulation) {
      this.simulation.on('tick', () => {
        links
          .attr('x1', (d: any) => d.source.x)
          .attr('y1', (d: any) => d.source.y)
          .attr('x2', (d: any) => d.target.x)
          .attr('y2', (d: any) => d.target.y);
      });
    } else {
      links
        .attr('x1', (d: any) => {
          const source = this.nodes.find(n => n.id === d.source);
          return source ? source.x : 0;
        })
        .attr('y1', (d: any) => {
          const source = this.nodes.find(n => n.id === d.source);
          return source ? source.y : 0;
        })
        .attr('x2', (d: any) => {
          const target = this.nodes.find(n => n.id === d.target);
          return target ? target.x : 0;
        })
        .attr('y2', (d: any) => {
          const target = this.nodes.find(n => n.id === d.target);
          return target ? target.y : 0;
        });
    }
  }

  private drawNodes(): void {
    const nodeGroup = this.g.append('g')
      .attr('class', 'nodes');

    const nodes = nodeGroup.selectAll('g')
      .data(this.nodes)
      .enter().append('g')
      .attr('transform', (d: any) => `translate(${d.x},${d.y})`)
      .call(this.setupDrag() as any)
      .on('click', (event, d) => {
        event.stopPropagation();
        this.options.onNodeClick?.(d);
      });

    nodes.append('circle')
      .attr('r', (d: any) => this.getNodeRadius(d))
      .attr('fill', (d: any) => this.getNodeColor(d))
      .attr('stroke', '#fff')
      .attr('stroke-width', 2);

    nodes.append('text')
      .text((d: any) => d.name)
      .attr('x', 0)
      .attr('y', -15)
      .attr('text-anchor', 'middle')
      .style('font-size', '12px')
      .style('fill', this.options.theme === 'dark' ? '#fff' : '#333');

    if (this.simulation) {
      this.simulation.on('tick', () => {
        nodes.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
      });
    }
  }

  private getNodeRadius(node: any): number {
    const baseRadius = this.options.nodeRadius!;
    const connections = this.links.filter(l => 
      l.source === node.id || l.target === node.id
    ).length;
    return baseRadius + Math.min(connections * 0.5, 10);
  }

  private getNodeColor(node: any): string {
    const colors: Record<string, string> = {
      service: '#4CAF50',
      database: '#2196F3',
      cache: '#FF9800',
      queue: '#9C27B0',
      api: '#00BCD4',
      frontend: '#E91E63',
      default: '#607D8B'
    };
    return colors[node.type] || colors.default;
  }

  private setupDrag(): d3.DragBehavior<Element, unknown, unknown> {
    return d3.drag()
      .on('start', (event, d: any) => {
        if (this.simulation) {
          if (!event.active) this.simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        }
      })
      .on('drag', (event, d: any) => {
        d.fx = event.x;
        d.fy = event.y;
        if (!this.simulation) {
          d.x = event.x;
          d.y = event.y;
          d3.select(event.sourceEvent.target.parentNode)
            .attr('transform', `translate(${d.x},${d.y})`);
        }
      })
      .on('end', (event, d: any) => {
        if (this.simulation) {
          if (!event.active) this.simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        }
      });
  }

  private updatePositions(): void {
    this.g.selectAll('.nodes g')
      .attr('transform', (d: any) => `translate(${d.x},${d.y})`);

    this.g.selectAll('.links line')
      .attr('x1', (d: any) => d.source.x)
      .attr('y1', (d: any) => d.source.y)
      .attr('x2', (d: any) => d.target.x)
      .attr('y2', (d: any) => d.target.y);
  }

  private clearVisualization(): void {
    this.g.selectAll('*').remove();
  }

  updateTelemetry(telemetry: any): void {
    const nodeSelection = this.g.selectAll('.nodes circle');
    
    nodeSelection.each(function(d: any) {
      const activity = telemetry.nodeActivity?.[d.id] || 0;
      const maxActivity = Math.max(...Object.values(telemetry.nodeActivity || {}));
      const intensity = activity / (maxActivity || 1);
      
      d3.select(this)
        .transition()
        .duration(500)
        .attr('fill-opacity', 0.3 + intensity * 0.7)
        .attr('r', (d: any) => {
          const baseRadius = 8;
          return baseRadius + intensity * 10;
        });
    });

    const linkSelection = this.g.selectAll('.links line');
    
    linkSelection.each(function(d: any) {
      const flow = telemetry.edgeFlow?.[`${d.source.id}-${d.target.id}`] || 0;
      const maxFlow = Math.max(...Object.values(telemetry.edgeFlow || {}));
      const intensity = flow / (maxFlow || 1);
      
      d3.select(this)
        .transition()
        .duration(500)
        .attr('stroke-width', 1 + intensity * 4)
        .attr('stroke-opacity', 0.3 + intensity * 0.7);
    });
  }

  searchNodes(query: string): void {
    const lowerQuery = query.toLowerCase();
    
    this.g.selectAll('.nodes g').each(function(d: any) {
      const matches = d.name.toLowerCase().includes(lowerQuery) ||
                     d.type.toLowerCase().includes(lowerQuery) ||
                     d.id.toLowerCase().includes(lowerQuery);
      
      d3.select(this)
        .transition()
        .duration(300)
        .style('opacity', matches || !query ? 1 : 0.2);
    });
  }

  applyFilters(filters: any): void {
    this.g.selectAll('.nodes g').each(function(d: any) {
      let visible = true;
      
      if (!filters.showOrphaned && d.orphaned) {
        visible = false;
      }
      
      if (!filters.showCritical && d.critical) {
        visible = false;
      }
      
      if (filters.minConnections > 0) {
        const connections = d.connections || 0;
        if (connections < filters.minConnections) {
          visible = false;
        }
      }
      
      if (filters.componentTypes?.length > 0 && !filters.componentTypes.includes(d.type)) {
        visible = false;
      }
      
      d3.select(this)
        .transition()
        .duration(300)
        .style('opacity', visible ? 1 : 0.1);
    });
  }

  setZoom(scale: number): void {
    const transform = d3.zoomIdentity
      .translate(this.currentTransform.x, this.currentTransform.y)
      .scale(scale);
    
    this.svg.transition()
      .duration(300)
      .call(this.zoom.transform as any, transform);
  }

  resetView(): void {
    this.svg.transition()
      .duration(750)
      .call(this.zoom.transform as any, d3.zoomIdentity);
  }

  async export(format: 'svg' | 'png' | 'pdf'): Promise<Blob> {
    const svgElement = this.svg.node();
    if (!svgElement) throw new Error('SVG element not found');

    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(svgElement);
    
    if (format === 'svg') {
      return new Blob([svgString], { type: 'image/svg+xml' });
    }
    
    if (format === 'png') {
      return new Promise((resolve, reject) => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const img = new Image();
        
        img.onload = () => {
          canvas.width = img.width;
          canvas.height = img.height;
          ctx?.drawImage(img, 0, 0);
          canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error('Failed to create PNG'));
          }, 'image/png');
        };
        
        img.onerror = reject;
        img.src = 'data:image/svg+xml;base64,' + btoa(svgString);
      });
    }
    
    throw new Error(`Export format ${format} not supported in browser`);
  }

  destroy(): void {
    if (this.simulation) {
      this.simulation.stop();
      this.simulation = null;
    }
    this.svg.remove();
  }
}