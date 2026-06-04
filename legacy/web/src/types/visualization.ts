export interface Component {
  id: string;
  name: string;
  type: string;
  path: string;
  language?: string;
  framework?: string;
  dependencies: string[];
  metadata?: Record<string, any>;
  metrics?: ComponentMetrics;
  orphaned?: boolean;
  critical?: boolean;
  connections?: number;
}

export interface Connection {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  weight?: number;
  metadata?: Record<string, any>;
}

export interface ComponentMetrics {
  complexity: number;
  linesOfCode: number;
  dependencies: number;
  dependents: number;
  coupling: number;
  cohesion: number;
}

export interface ArchitectureBlueprint {
  id: string;
  projectId: string;
  components: Component[];
  connections: Connection[];
  orphanedComponents: Component[];
  metadata: {
    timestamp: Date;
    version: string;
    analyzer: string;
    repository: string;
  };
  statistics: {
    totalComponents: number;
    totalConnections: number;
    averageComplexity: number;
    criticalPaths: number;
    orphanedCount: number;
    cyclomaticComplexity: number;
    technicalDebt: number;
  };
}

export interface VisualizationOptions {
  layout?: 'force' | 'hierarchical' | 'circular' | 'grid' | 'dagre' | 'radial';
  theme?: 'light' | 'dark' | 'blueprint';
  filters?: {
    showOrphaned?: boolean;
    showCritical?: boolean;
    minConnections?: number;
    componentTypes?: string[];
  };
  performance?: {
    enableGPU?: boolean;
    maxNodes?: number;
    updateInterval?: number;
  };
}

export interface VisualizationState {
  blueprint: ArchitectureBlueprint | null;
  options: VisualizationOptions;
  selectedNode: string | null;
  selectedEdge: string | null;
  zoom: number;
  pan: { x: number; y: number };
  filters: Record<string, any>;
  search: string;
}

export interface TelemetryUpdate {
  type: 'node' | 'edge' | 'metric';
  id: string;
  data: any;
  timestamp: Date;
}