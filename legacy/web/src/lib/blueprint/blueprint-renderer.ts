import * as d3 from 'd3';
import { ArchitectureBlueprint, Component, Connection } from '@/types/visualization';

export interface BlueprintSection {
  id: string;
  name: string;
  type: 'presentation' | 'business' | 'data' | 'infrastructure' | 'external';
  components: Component[];
  bounds: { x: number; y: number; width: number; height: number };
  health: 'healthy' | 'warning' | 'critical' | 'offline';
  activity: number; // 0-1 scale
}

export interface BlueprintLevel {
  level: number;
  sections: BlueprintSection[];
  connections: Array<{
    from: string;
    to: string;
    path: Array<{ x: number; y: number }>;
    activity: number;
    type: 'data' | 'control' | 'event';
  }>;
}

export interface BlueprintOptions {
  width?: number;
  height?: number;
  theme?: 'light' | 'dark' | 'blueprint';
  showGrid?: boolean;
  showLabels?: boolean;
  onSectionClick?: (sectionId: string) => void;
  onComponentClick?: (componentId: string) => void;
}

export class BlueprintRenderer {
  private container: HTMLElement;
  private svg!: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private defs!: d3.Selection<SVGDefsElement, unknown, null, undefined>;
  private mainGroup!: d3.Selection<SVGGElement, unknown, null, undefined>;
  private options: BlueprintOptions;
  private currentLevel = 0;
  private navigationStack: string[] = [];
  private blueprintData: BlueprintLevel[] = [];
  private animationFrames: Map<string, number> = new Map();

  constructor(container: HTMLElement, options: BlueprintOptions = {}) {
    this.container = container;
    this.options = {
      width: container.clientWidth,
      height: container.clientHeight,
      theme: 'blueprint',
      showGrid: true,
      showLabels: true,
      ...options
    };

    this.initializeSVG();
    this.setupDefinitions();
    this.setupGrid();
  }

  private initializeSVG(): void {
    this.svg = d3.select(this.container)
      .append('svg')
      .attr('width', this.options.width!)
      .attr('height', this.options.height!)
      .style('background', this.getBackgroundColor())
      .style('font-family', 'Monaco, "Courier New", monospace');

    this.defs = this.svg.append('defs');
    this.mainGroup = this.svg.append('g').attr('class', 'blueprint-main');
  }

  private getBackgroundColor(): string {
    switch (this.options.theme) {
      case 'dark': return '#0a0a0a';
      case 'blueprint': return '#001122';
      default: return '#f8f9fa';
    }
  }

  private getLineColor(): string {
    switch (this.options.theme) {
      case 'dark': return '#404040';
      case 'blueprint': return '#00ff88';
      default: return '#e0e0e0';
    }
  }

  private getTextColor(): string {
    switch (this.options.theme) {
      case 'dark': return '#ffffff';
      case 'blueprint': return '#00ff88';
      default: return '#333333';
    }
  }

  private setupDefinitions(): void {
    // Grid pattern
    const gridPattern = this.defs.append('pattern')
      .attr('id', 'grid')
      .attr('width', 20)
      .attr('height', 20)
      .attr('patternUnits', 'userSpaceOnUse');

    gridPattern.append('path')
      .attr('d', 'M 20 0 L 0 0 0 20')
      .attr('fill', 'none')
      .attr('stroke', this.getLineColor())
      .attr('stroke-width', 0.5)
      .attr('opacity', 0.3);

    // Section health indicators
    const healthGradients = [
      { id: 'healthy', color: '#00ff88' },
      { id: 'warning', color: '#ffaa00' },
      { id: 'critical', color: '#ff3366' },
      { id: 'offline', color: '#666666' }
    ];

    healthGradients.forEach(({ id, color }) => {
      const gradient = this.defs.append('linearGradient')
        .attr('id', `${id}-gradient`)
        .attr('x1', '0%').attr('y1', '0%')
        .attr('x2', '100%').attr('y2', '100%');

      gradient.append('stop')
        .attr('offset', '0%')
        .style('stop-color', color)
        .style('stop-opacity', 0.3);

      gradient.append('stop')
        .attr('offset', '100%')
        .style('stop-color', color)
        .style('stop-opacity', 0.1);
    });

    // Data flow markers
    this.defs.append('marker')
      .attr('id', 'data-flow')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 8)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', this.options.theme === 'blueprint' ? '#00ff88' : '#007acc');
  }

  private setupGrid(): void {
    if (this.options.showGrid) {
      this.svg.append('rect')
        .attr('width', this.options.width!)
        .attr('height', this.options.height!)
        .attr('fill', 'url(#grid)');
    }
  }

  render(blueprint: ArchitectureBlueprint): void {
    this.blueprintData = this.transformToLevels(blueprint);
    this.renderLevel(0);
  }

  private transformToLevels(blueprint: ArchitectureBlueprint): BlueprintLevel[] {
    // Level 0: High-level system sections
    const mainSections = this.createMainSections(blueprint);
    
    // Level 1+: Drill-down into each section
    const levels: BlueprintLevel[] = [
      {
        level: 0,
        sections: mainSections,
        connections: this.createSectionConnections(mainSections, blueprint.connections)
      }
    ];

    // Create detailed levels for each section
    mainSections.forEach((section) => {
      if (section.components.length > 0) {
        levels.push({
          level: levels.length,
          sections: this.createComponentSections(section),
          connections: this.createComponentConnections(section, blueprint.connections)
        });
      }
    });

    return levels;
  }

  private createMainSections(blueprint: ArchitectureBlueprint): BlueprintSection[] {
    const componentsByLayer = new Map<string, Component[]>();
    
    // Group components by architectural layer
    blueprint.components.forEach(comp => {
      const layer = comp.metadata?.layer || 'infrastructure';
      if (!componentsByLayer.has(layer)) {
        componentsByLayer.set(layer, []);
      }
      componentsByLayer.get(layer)!.push(comp);
    });

    const sections: BlueprintSection[] = [];
    const sectionLayout = this.calculateSectionLayout(componentsByLayer.size);

    let sectionIndex = 0;
    componentsByLayer.forEach((components, layer) => {
      const position = sectionLayout[sectionIndex];
      
      sections.push({
        id: layer,
        name: this.formatLayerName(layer),
        type: layer as any,
        components,
        bounds: position,
        health: this.calculateSectionHealth(components),
        activity: this.calculateSectionActivity(components)
      });
      
      sectionIndex++;
    });

    return sections;
  }

  private calculateSectionLayout(sectionCount: number): Array<{ x: number; y: number; width: number; height: number }> {
    const padding = 60;
    const minWidth = 200;
    const minHeight = 150;
    const availableWidth = this.options.width! - padding * 2;
    const availableHeight = this.options.height! - padding * 2;

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
  }

  private formatLayerName(layer: string): string {
    const names: Record<string, string> = {
      'presentation': 'PRESENTATION LAYER',
      'business': 'BUSINESS LOGIC',
      'data': 'DATA SERVICES',
      'infrastructure': 'INFRASTRUCTURE',
      'external': 'EXTERNAL SYSTEMS'
    };
    return names[layer] || layer.toUpperCase();
  }

  private calculateSectionHealth(components: Component[]): 'healthy' | 'warning' | 'critical' | 'offline' {
    if (components.length === 0) return 'offline';
    
    let criticalCount = 0;
    let warningCount = 0;
    let totalComplexity = 0;
    let totalCoupling = 0;
    
    components.forEach(comp => {
      if (comp.critical) criticalCount++;
      if (comp.orphaned) warningCount++;
      if (comp.metrics) {
        totalComplexity += comp.metrics.complexity || 0;
        totalCoupling += comp.metrics.coupling || 0;
      }
    });
    
    const avgComplexity = totalComplexity / components.length;
    const avgCoupling = totalCoupling / components.length;
    const criticalRatio = criticalCount / components.length;
    const warningRatio = warningCount / components.length;
    
    // Determine health based on component metrics
    if (criticalRatio > 0.3 || avgComplexity > 80 || avgCoupling > 0.8) {
      return 'critical';
    } else if (criticalRatio > 0.1 || warningRatio > 0.2 || avgComplexity > 50 || avgCoupling > 0.6) {
      return 'warning';
    } else if (components.every(c => c.orphaned)) {
      return 'offline';
    }
    
    return 'healthy';
  }

  private calculateSectionActivity(components: Component[]): number {
    if (components.length === 0) return 0;
    
    // Base activity on number of connections and component types
    let totalActivity = 0;
    
    components.forEach(comp => {
      // More connections = higher activity
      const connectionActivity = Math.min((comp.connections || 0) / 10, 1);
      
      // Different component types have different baseline activity
      const typeMultipliers: Record<string, number> = {
        'api': 0.8,
        'service': 0.7,
        'database': 0.6,
        'frontend': 0.5,
        'cache': 0.9,
        'queue': 0.7,
        'external-service': 0.4
      };
      
      const typeMultiplier = typeMultipliers[comp.type] || 0.5;
      totalActivity += connectionActivity * typeMultiplier;
    });
    
    return Math.min(totalActivity / components.length, 1);
  }

  private calculateConnectionActivity(sourceSection: BlueprintSection, targetSection: BlueprintSection): number {
    // Activity based on the components involved and their relationships
    const sourceActivity = sourceSection.activity;
    const targetActivity = targetSection.activity;
    
    // Cross-layer connections typically have lower activity
    const layerPenalty = sourceSection.type !== targetSection.type ? 0.7 : 1.0;
    
    return Math.min((sourceActivity + targetActivity) / 2 * layerPenalty, 1);
  }

  private calculateComponentActivity(component: Component): number {
    // Activity based on component characteristics
    let activity = 0.1; // Base activity
    
    // More connections = higher activity
    if (component.connections) {
      activity += Math.min(component.connections / 20, 0.5);
    }
    
    // Metrics-based activity
    if (component.metrics) {
      const { dependencies, dependents, coupling } = component.metrics;
      
      // Components with many dependencies or dependents are more active
      activity += Math.min((dependencies + dependents) / 30, 0.3);
      
      // Higher coupling suggests more activity
      activity += Math.min(coupling * 0.2, 0.2);
    }
    
    // Critical components tend to be more active
    if (component.critical) {
      activity += 0.2;
    }
    
    // Orphaned components have very low activity
    if (component.orphaned) {
      activity = Math.min(activity * 0.1, 0.05);
    }
    
    return Math.min(activity, 1);
  }

  private calculateInternalConnectionActivity(connection: Connection): number {
    // Activity based on connection weight and metadata
    let activity = 0.3; // Base activity for internal connections
    
    if (connection.weight) {
      activity += Math.min(connection.weight / 10, 0.5);
    }
    
    // Different connection types have different activity levels
    const typeMultipliers: Record<string, number> = {
      'data': 0.8,
      'control': 0.6,
      'event': 0.9,
      'dependency': 0.4,
      'inheritance': 0.3
    };
    
    const typeMultiplier = typeMultipliers[connection.type] || 0.5;
    
    return Math.min(activity * typeMultiplier, 1);
  }

  private createSectionConnections(sections: BlueprintSection[], connections: Connection[]): Array<{
    from: string;
    to: string;
    path: Array<{ x: number; y: number }>;
    activity: number;
    type: 'data' | 'control' | 'event';
  }> {
    const sectionConnections: Array<{
      from: string;
      to: string;
      path: Array<{ x: number; y: number }>;
      activity: number;
      type: 'data' | 'control' | 'event';
    }> = [];
    
    for (const connection of connections) {
      const sourceSection = sections.find(s => 
        s.components.some(c => c.id === connection.sourceId)
      );
      const targetSection = sections.find(s => 
        s.components.some(c => c.id === connection.targetId)
      );

      if (sourceSection && targetSection && sourceSection.id !== targetSection.id) {
        const sourceBounds = sourceSection.bounds;
        const targetBounds = targetSection.bounds;
        
        sectionConnections.push({
          from: sourceSection.id,
          to: targetSection.id,
          path: this.calculateConnectionPath(sourceBounds, targetBounds),
          activity: this.calculateConnectionActivity(sourceSection, targetSection),
          type: (connection.type === 'control' || connection.type === 'event') ? connection.type as 'control' | 'event' : 'data'
        });
      }
    }

    return sectionConnections;
  }

  private calculateConnectionPath(source: { x: number; y: number; width: number; height: number }, target: { x: number; y: number; width: number; height: number }): Array<{ x: number; y: number }> {
    const sourceCenter = {
      x: source.x + source.width / 2,
      y: source.y + source.height / 2
    };
    const targetCenter = {
      x: target.x + target.width / 2,
      y: target.y + target.height / 2
    };

    // Create a curved connection path
    const midX = (sourceCenter.x + targetCenter.x) / 2;
    const midY = (sourceCenter.y + targetCenter.y) / 2;
    
    return [
      sourceCenter,
      { x: midX, y: sourceCenter.y },
      { x: midX, y: midY },
      { x: midX, y: targetCenter.y },
      targetCenter
    ];
  }

  private createComponentSections(parentSection: BlueprintSection): BlueprintSection[] {
    const componentSections: BlueprintSection[] = [];
    const componentLayout = this.calculateComponentLayout(parentSection.components.length, parentSection.bounds);
    
    parentSection.components.forEach((component, index) => {
      const position = componentLayout[index];
      
      componentSections.push({
        id: component.id,
        name: component.name,
        type: component.type as any,
        components: [component], // Single component per section at this level
        bounds: position,
        health: this.calculateComponentHealth(component),
        activity: this.calculateComponentActivity(component)
      });
    });

    return componentSections;
  }

  private calculateComponentLayout(componentCount: number, parentBounds: { x: number; y: number; width: number; height: number }): Array<{ x: number; y: number; width: number; height: number }> {
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
  }

  private calculateComponentHealth(component: Component): 'healthy' | 'warning' | 'critical' | 'offline' {
    if (component.critical) return 'critical';
    if (component.orphaned) return 'warning';
    
    if (component.metrics) {
      const { complexity, coupling, dependencies, dependents } = component.metrics;
      
      // High complexity or coupling indicates problems
      if (complexity > 80 || coupling > 0.8) return 'critical';
      if (complexity > 50 || coupling > 0.6) return 'warning';
      
      // Components with no dependents might be unused
      if (dependents === 0 && dependencies > 0) return 'warning';
    }
    
    // High-risk component types require special attention
    const highRiskTypes = ['database', 'cache', 'external-service'];
    if (highRiskTypes.includes(component.type) && !component.metrics?.cohesion) {
      return 'warning';
    }
    
    return 'healthy';
  }

  private createComponentConnections(section: BlueprintSection, connections: Connection[]): Array<{
    from: string;
    to: string;
    path: Array<{ x: number; y: number }>;
    activity: number;
    type: 'data' | 'control' | 'event';
  }> {
    const componentConnections: Array<{
      from: string;
      to: string;
      path: Array<{ x: number; y: number }>;
      activity: number;
      type: 'data' | 'control' | 'event';
    }> = [];
    const componentIds = new Set(section.components.map(c => c.id));
    
    for (const connection of connections) {
      if (componentIds.has(connection.sourceId) || componentIds.has(connection.targetId)) {
        const sourceComponent = section.components.find(c => c.id === connection.sourceId);
        const targetComponent = section.components.find(c => c.id === connection.targetId);
        
        if (sourceComponent && targetComponent) {
          // Both components are in this section - get bounds from component sections
          const componentSections = this.createComponentSections(section);
          const sourceBounds = componentSections.find(cs => cs.id === sourceComponent.id)?.bounds;
          const targetBounds = componentSections.find(cs => cs.id === targetComponent.id)?.bounds;
          
          if (sourceBounds && targetBounds) {
            componentConnections.push({
              from: connection.sourceId,
              to: connection.targetId,
              path: this.calculateConnectionPath(sourceBounds, targetBounds),
              activity: Math.random() * 0.8 + 0.1, // Simulate activity
              type: (connection.type === 'control' || connection.type === 'event') ? connection.type as 'control' | 'event' : 'data'
            });
          }
        }
      }
    }

    return componentConnections;
  }

  private getComponentBounds(componentId: string): { x: number; y: number; width: number; height: number } | null {
    // Find the component section bounds from the current level
    const currentLevelData = this.blueprintData[this.currentLevel];
    if (!currentLevelData) return null;
    
    const componentSection = currentLevelData.sections.find(s => s.id === componentId);
    return componentSection ? componentSection.bounds : null;
  }

  private renderLevel(level: number): void {
    this.mainGroup.selectAll('*').remove();
    
    const levelData = this.blueprintData[level];
    if (!levelData) return;

    // Render sections
    const sectionGroups = this.mainGroup
      .selectAll('.section')
      .data(levelData.sections)
      .enter()
      .append('g')
      .attr('class', 'section')
      .attr('cursor', 'pointer')
      .on('click', (event, d) => {
        if (level === 0) {
          this.drillDown(d.id);
        }
        this.options.onSectionClick?.(d.id);
      });

    // Section backgrounds with health indication
    sectionGroups
      .append('rect')
      .attr('x', d => d.bounds.x)
      .attr('y', d => d.bounds.y)
      .attr('width', d => d.bounds.width)
      .attr('height', d => d.bounds.height)
      .attr('fill', d => `url(#${d.health}-gradient)`)
      .attr('stroke', d => this.getHealthColor(d.health))
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', d => d.health === 'critical' ? '5,5' : 'none')
      .attr('rx', 8);

    // Section titles
    sectionGroups
      .append('text')
      .attr('x', d => d.bounds.x + 16)
      .attr('y', d => d.bounds.y + 24)
      .text(d => d.name)
      .attr('fill', this.getTextColor())
      .attr('font-size', '14px')
      .attr('font-weight', 'bold');

    // Component count indicators
    sectionGroups
      .append('text')
      .attr('x', d => d.bounds.x + d.bounds.width - 16)
      .attr('y', d => d.bounds.y + 24)
      .text(d => `${d.components.length} COMPONENTS`)
      .attr('fill', this.getTextColor())
      .attr('font-size', '10px')
      .attr('text-anchor', 'end')
      .attr('opacity', 0.7);

    // Activity indicators (small bars)
    sectionGroups
      .append('rect')
      .attr('x', d => d.bounds.x + 16)
      .attr('y', d => d.bounds.y + d.bounds.height - 20)
      .attr('width', d => (d.bounds.width - 32) * d.activity)
      .attr('height', 4)
      .attr('fill', d => this.getHealthColor(d.health))
      .attr('opacity', 0.8);

    // Section status text
    sectionGroups
      .append('text')
      .attr('x', d => d.bounds.x + 16)
      .attr('y', d => d.bounds.y + d.bounds.height - 6)
      .text(d => `STATUS: ${d.health.toUpperCase()}`)
      .attr('fill', this.getTextColor())
      .attr('font-size', '9px')
      .attr('opacity', 0.6);

    // Render connections
    this.renderConnections(levelData.connections);
  }

  private getHealthColor(health: string): string {
    const colors: Record<string, string> = {
      'healthy': '#00ff88',
      'warning': '#ffaa00', 
      'critical': '#ff3366',
      'offline': '#666666'
    };
    return colors[health] || colors.offline;
  }

  private renderConnections(connections: any[]): void {
    const connectionGroup = this.mainGroup.append('g').attr('class', 'connections');

    connections.forEach(conn => {
      const line = d3.line<{x: number, y: number}>()
        .x(d => d.x)
        .y(d => d.y)
        .curve(d3.curveCardinal);

      connectionGroup
        .append('path')
        .datum(conn.path)
        .attr('d', line)
        .attr('fill', 'none')
        .attr('stroke', this.getTextColor())
        .attr('stroke-width', Math.max(1, conn.activity * 4))
        .attr('stroke-opacity', 0.3 + conn.activity * 0.5)
        .attr('marker-end', 'url(#data-flow)');

      // Animate data flow particles
      this.animateDataFlow(connectionGroup, conn);
    });
  }

  private animateDataFlow(group: any, connection: any): void {
    if (connection.activity < 0.1) return;

    const particles = Math.ceil(connection.activity * 8);
    const connectionId = `${connection.from}-${connection.to}`;
    
    // Remove existing particles for this connection
    group.selectAll(`.particle-${connectionId.replace(/\W/g, '')}`).remove();
    
    for (let i = 0; i < particles; i++) {
      const particleSize = 2 + connection.activity * 3;
      const speed = 300 + connection.activity * 200; // Faster for higher activity
      
      // Different particle types for different connection types
      let particleColor = this.getTextColor();
      let particleShape = 'circle';
      
      switch (connection.type) {
        case 'data':
          particleColor = '#00ff88';
          break;
        case 'control':
          particleColor = '#ffaa00';
          break;
        case 'event':
          particleColor = '#ff6666';
          particleShape = 'rect';
          break;
        default:
          particleColor = this.options.theme === 'blueprint' ? '#00ff88' : '#007acc';
      }

      const particle = particleShape === 'circle' 
        ? group
            .append('circle')
            .attr('r', particleSize)
            .attr('fill', particleColor)
            .attr('opacity', 0.9)
            .attr('class', `particle-${connectionId.replace(/\W/g, '')}`)
        : group
            .append('rect')
            .attr('width', particleSize * 2)
            .attr('height', particleSize)
            .attr('fill', particleColor)
            .attr('opacity', 0.9)
            .attr('class', `particle-${connectionId.replace(/\W/g, '')}`);

      this.animateParticleAlongPath(particle, connection.path, speed, i * 150, particleShape);
    }
  }

  private animateParticleAlongPath(particle: any, path: Array<{x: number, y: number}>, speed: number, delay: number, shape: string): void {
    const animateParticle = () => {
      let pathIndex = 0;
      
      const moveToNextPoint = () => {
        if (pathIndex < path.length - 1) {
          const current = path[pathIndex];
          const next = path[pathIndex + 1];
          const distance = Math.sqrt(Math.pow(next.x - current.x, 2) + Math.pow(next.y - current.y, 2));
          const duration = (distance / speed) * 1000;
          
          if (shape === 'circle') {
            particle
              .transition()
              .duration(duration)
              .ease(d3.easeLinear)
              .attr('cx', next.x)
              .attr('cy', next.y)
              .on('end', () => {
                pathIndex++;
                if (pathIndex < path.length - 1) {
                  moveToNextPoint();
                } else {
                  // Fade out and restart
                  particle
                    .transition()
                    .duration(200)
                    .attr('opacity', 0)
                    .on('end', () => {
                      particle.attr('cx', path[0].x).attr('cy', path[0].y).attr('opacity', 0.9);
                      pathIndex = 0;
                      setTimeout(moveToNextPoint, Math.random() * 1000 + 500);
                    });
                }
              });
          } else {
            particle
              .transition()
              .duration(duration)
              .ease(d3.easeLinear)
              .attr('x', next.x - 2)
              .attr('y', next.y - 1)
              .on('end', () => {
                pathIndex++;
                if (pathIndex < path.length - 1) {
                  moveToNextPoint();
                } else {
                  particle
                    .transition()
                    .duration(200)
                    .attr('opacity', 0)
                    .on('end', () => {
                      particle.attr('x', path[0].x - 2).attr('y', path[0].y - 1).attr('opacity', 0.9);
                      pathIndex = 0;
                      setTimeout(moveToNextPoint, Math.random() * 1000 + 500);
                    });
                }
              });
          }
        }
      };

      if (shape === 'circle') {
        particle.attr('cx', path[0].x).attr('cy', path[0].y);
      } else {
        particle.attr('x', path[0].x - 2).attr('y', path[0].y - 1);
      }
      
      setTimeout(moveToNextPoint, delay);
    };

    animateParticle();
  }

  drillDown(sectionId: string): void {
    this.navigationStack.push(sectionId);
    
    // Find the section at the current level
    const currentLevelData = this.blueprintData[this.currentLevel];
    const section = currentLevelData.sections.find(s => s.id === sectionId);
    
    if (!section) return;
    
    // Find the level that shows components for this section
    // Level 0 shows main sections, levels 1+ show component details for specific sections
    if (this.currentLevel === 0) {
      // From main sections, find the corresponding detail level
      const mainSections = this.blueprintData[0].sections;
      const sectionIndex = mainSections.findIndex(s => s.id === sectionId);
      
      if (sectionIndex > -1 && this.blueprintData.length > sectionIndex + 1) {
        this.currentLevel = sectionIndex + 1;
        this.renderLevel(this.currentLevel);
        return;
      }
    }
    
    // Fallback to section details view
    this.renderSectionDetails(sectionId);
  }

  private renderSectionDetails(sectionId: string): void {
    const currentLevelData = this.blueprintData[this.currentLevel];
    const section = currentLevelData.sections.find(s => s.id === sectionId);
    
    if (!section) return;

    this.mainGroup.selectAll('*').remove();
    
    // Render breadcrumb
    this.renderBreadcrumb();
    
    // Render section header
    const headerGroup = this.mainGroup.append('g').attr('class', 'section-header');
    
    headerGroup
      .append('rect')
      .attr('x', 20)
      .attr('y', 60)
      .attr('width', this.options.width! - 40)
      .attr('height', 50)
      .attr('fill', `url(#${section.health}-gradient)`)
      .attr('stroke', this.getHealthColor(section.health))
      .attr('stroke-width', 2)
      .attr('rx', 8);
    
    headerGroup
      .append('text')
      .attr('x', 40)
      .attr('y', 85)
      .text(`${section.name} - DETAILED VIEW`)
      .attr('fill', this.getTextColor())
      .attr('font-size', '16px')
      .attr('font-weight', 'bold');
    
    // Render component grid
    this.renderComponentGrid(section);
  }

  private renderBreadcrumb(): void {
    const breadcrumbGroup = this.mainGroup.append('g').attr('class', 'breadcrumb');
    
    const breadcrumbs = ['SYSTEM OVERVIEW', ...this.navigationStack];
    let x = 20;
    
    breadcrumbs.forEach((crumb, index) => {
      if (index > 0) {
        breadcrumbGroup
          .append('text')
          .attr('x', x)
          .attr('y', 30)
          .text(' > ')
          .attr('fill', this.getTextColor())
          .attr('font-size', '12px')
          .attr('opacity', 0.6);
        x += 20;
      }
      
      const text = breadcrumbGroup
        .append('text')
        .attr('x', x)
        .attr('y', 30)
        .text(crumb.replace('_', ' ').toUpperCase())
        .attr('fill', this.getTextColor())
        .attr('font-size', '12px')
        .attr('cursor', index < breadcrumbs.length - 1 ? 'pointer' : 'default')
        .attr('font-weight', index === breadcrumbs.length - 1 ? 'bold' : 'normal');
      
      if (index < breadcrumbs.length - 1) {
        text.on('click', () => {
          this.navigateToLevel(index);
        });
      }
      
      x += text.node()!.getBBox().width + 10;
    });
  }

  private renderComponentGrid(section: BlueprintSection): void {
    const startY = 140;
    const componentSections = this.createComponentSections(section);
    
    const componentGroups = this.mainGroup
      .selectAll('.component')
      .data(componentSections)
      .enter()
      .append('g')
      .attr('class', 'component')
      .attr('cursor', 'pointer')
      .on('click', (event, d) => {
        this.options.onComponentClick?.(d.id);
      });

    // Component backgrounds
    componentGroups
      .append('rect')
      .attr('x', d => d.bounds.x)
      .attr('y', d => d.bounds.y + startY - 120)
      .attr('width', d => d.bounds.width)
      .attr('height', d => d.bounds.height)
      .attr('fill', d => `url(#${d.health}-gradient)`)
      .attr('stroke', d => this.getHealthColor(d.health))
      .attr('stroke-width', 1)
      .attr('rx', 4);

    // Component names
    componentGroups
      .append('text')
      .attr('x', d => d.bounds.x + 8)
      .attr('y', d => d.bounds.y + startY - 100)
      .text(d => d.name)
      .attr('fill', this.getTextColor())
      .attr('font-size', '11px')
      .attr('font-weight', 'bold');

    // Component types
    componentGroups
      .append('text')
      .attr('x', d => d.bounds.x + 8)
      .attr('y', d => d.bounds.y + startY - 85)
      .text(d => d.components[0]?.type?.toUpperCase() || 'COMPONENT')
      .attr('fill', this.getTextColor())
      .attr('font-size', '9px')
      .attr('opacity', 0.7);

    // Health status
    componentGroups
      .append('circle')
      .attr('cx', d => d.bounds.x + d.bounds.width - 12)
      .attr('cy', d => d.bounds.y + startY - 108)
      .attr('r', 6)
      .attr('fill', d => this.getHealthColor(d.health))
      .attr('stroke', this.getTextColor())
      .attr('stroke-width', 1);
  }

  private navigateToLevel(level: number): void {
    // Adjust navigation stack to match the target level
    this.navigationStack = this.navigationStack.slice(0, level);
    this.currentLevel = level;
    
    // If going back to level 0 or the level exists in blueprintData, render it
    if (level === 0 || this.blueprintData[level]) {
      this.renderLevel(this.currentLevel);
    } else {
      // If the level doesn't exist, go to level 0
      this.currentLevel = 0;
      this.navigationStack = [];
      this.renderLevel(0);
    }
  }

  navigateBack(): void {
    if (this.navigationStack.length > 0) {
      this.navigationStack.pop();
      
      // Navigate to the appropriate level based on navigation stack length
      if (this.navigationStack.length === 0) {
        this.currentLevel = 0; // Go back to main sections view
      } else {
        // Stay in detailed view but potentially change which section's details are shown
        // For now, just go back to main view
        this.currentLevel = 0;
        this.navigationStack = [];
      }
      
      this.renderLevel(this.currentLevel);
    }
  }

  updateTelemetry(telemetry: any): void {
    if (!telemetry) return;

    // Update section health status based on telemetry
    this.mainGroup.selectAll('.section')
      .each((d: any, i, nodes) => {
        const sectionGroup = d3.select(nodes[i]);
        const sectionData = d as BlueprintSection;
        
        // Get real-time health and activity data
        const sectionTelemetry = telemetry.sections?.[sectionData.id] || {};
        const activity = sectionTelemetry.activity || sectionData.activity;
        const errorRate = sectionTelemetry.errorRate || 0;
        const responseTime = sectionTelemetry.responseTime || 100;
        
        // Update health based on telemetry
        let newHealth: 'healthy' | 'warning' | 'critical' | 'offline' = 'healthy';
        if (errorRate > 0.1) newHealth = 'critical';
        else if (errorRate > 0.05 || responseTime > 1000) newHealth = 'warning';
        else if (activity < 0.01) newHealth = 'offline';
        
        // Update section background with pulsing effect for high activity
        const rect = sectionGroup.select('rect');
        rect
          .transition()
          .duration(500)
          .attr('fill', `url(#${newHealth}-gradient)`)
          .attr('stroke', this.getHealthColor(newHealth))
          .attr('stroke-width', activity > 0.7 ? 3 : 2)
          .attr('stroke-opacity', 0.8 + activity * 0.2);
        
        // Update activity bar
        const activityBar = sectionGroup.select('rect:nth-child(4)');
        activityBar
          .transition()
          .duration(300)
          .attr('width', (sectionData.bounds.width - 32) * activity)
          .attr('fill', this.getHealthColor(newHealth));
        
        // Add error indicator if there are errors
        if (errorRate > 0) {
          let errorIndicator = sectionGroup.select<SVGCircleElement>('.error-indicator');
          if (errorIndicator.empty()) {
            errorIndicator = sectionGroup
              .append('circle')
              .attr('class', 'error-indicator')
              .attr('cx', sectionData.bounds.x + sectionData.bounds.width - 30)
              .attr('cy', sectionData.bounds.y + 30)
              .attr('r', 8)
              .attr('fill', '#ff3366')
              .attr('stroke', '#ffffff')
              .attr('stroke-width', 2);
            
            // Add error count text
            sectionGroup
              .append('text')
              .attr('class', 'error-count')
              .attr('x', sectionData.bounds.x + sectionData.bounds.width - 30)
              .attr('y', sectionData.bounds.y + 35)
              .attr('text-anchor', 'middle')
              .attr('fill', '#ffffff')
              .attr('font-size', '10px')
              .attr('font-weight', 'bold')
              .text(Math.ceil(errorRate * 100));
          }
          
          // Pulsing animation for errors
          errorIndicator
            .transition()
            .duration(1000)
            .attr('r', 12)
            .transition()
            .duration(1000)
            .attr('r', 8)
            .on('end', function() {
              if (errorRate > 0) {
                d3.select(this).transition().duration(1000).attr('r', 12);
              }
            });
        } else {
          sectionGroup.select('.error-indicator').remove();
          sectionGroup.select('.error-count').remove();
        }
      });

    // Update data flow animations with real traffic
    this.updateDataFlowAnimations(telemetry);
    
    // Update performance metrics overlay
    this.updatePerformanceOverlay(telemetry);
  }

  private updateDataFlowAnimations(telemetry: any): void {
    // Find all existing connection particles and update their frequency
    this.mainGroup.selectAll('.connections path')
      .each((d: any) => {
        const connectionTelemetry = telemetry.connections?.[`${d.from}-${d.to}`] || {};
        const throughput = connectionTelemetry.throughput || 0;
        
        // Update particle frequency based on throughput
        if (throughput > 0.1) {
          // Add more particles for high throughput connections
          this.animateDataFlow(this.mainGroup.select('.connections'), {
            ...d,
            activity: throughput
          });
        }
      });
  }

  private updatePerformanceOverlay(telemetry: any): void {
    const overlayGroup = this.mainGroup.select('.performance-overlay');
    
    if (overlayGroup.empty()) {
      const newOverlay = this.mainGroup.append('g').attr('class', 'performance-overlay');
      
      // Add system-wide metrics display
      const metricsBox = newOverlay
        .append('rect')
        .attr('x', this.options.width! - 200)
        .attr('y', 20)
        .attr('width', 180)
        .attr('height', 120)
        .attr('fill', 'rgba(0, 17, 34, 0.9)')
        .attr('stroke', this.getTextColor())
        .attr('stroke-width', 1)
        .attr('rx', 4);
      
      newOverlay
        .append('text')
        .attr('class', 'metrics-title')
        .attr('x', this.options.width! - 190)
        .attr('y', 40)
        .text('SYSTEM METRICS')
        .attr('fill', this.getTextColor())
        .attr('font-size', '10px')
        .attr('font-weight', 'bold');
      
      // CPU usage
      newOverlay
        .append('text')
        .attr('class', 'cpu-metric')
        .attr('x', this.options.width! - 190)
        .attr('y', 60)
        .attr('fill', this.getTextColor())
        .attr('font-size', '9px');
      
      // Memory usage  
      newOverlay
        .append('text')
        .attr('class', 'memory-metric')
        .attr('x', this.options.width! - 190)
        .attr('y', 75)
        .attr('fill', this.getTextColor())
        .attr('font-size', '9px');
      
      // Request rate
      newOverlay
        .append('text')
        .attr('class', 'request-metric')
        .attr('x', this.options.width! - 190)
        .attr('y', 90)
        .attr('fill', this.getTextColor())
        .attr('font-size', '9px');
      
      // Error rate
      newOverlay
        .append('text')
        .attr('class', 'error-metric')
        .attr('x', this.options.width! - 190)
        .attr('y', 105)
        .attr('fill', this.getTextColor())
        .attr('font-size', '9px');
    }
    
    // Update metrics with real telemetry data
    const systemMetrics = telemetry.system || {};
    
    this.mainGroup.select('.cpu-metric')
      .text(`CPU: ${Math.round((systemMetrics.cpuUsage || 0.45) * 100)}%`);
    
    this.mainGroup.select('.memory-metric')
      .text(`MEM: ${Math.round((systemMetrics.memoryUsage || 0.67) * 100)}%`);
    
    this.mainGroup.select('.request-metric')
      .text(`REQ/S: ${systemMetrics.requestRate || 250}`);
    
    this.mainGroup.select('.error-metric')
      .text(`ERRORS: ${systemMetrics.errorCount || 0}`);
  }

  destroy(): void {
    this.animationFrames.forEach(frameId => cancelAnimationFrame(frameId));
    this.animationFrames.clear();
    this.svg.remove();
  }
}