// CAS v1.2.0 TypeScript interfaces

export interface CASOutput {
  cas_version: "1.2.0";
  analysis_timestamp: string;
  analysis_id: string;

  system: {
    id: string;
    name: string;
    root_path: string;
    type?: string;
    description?: string;
    metadata?: Record<string, any>;
  };

  nodes: CASNode[];
  edges: CASEdge[];
  entry_points: EntryPoint[];
  exit_points: ExitPoint[];
  external_services: ExternalService[];

  perspectives?: CASPerspective[];
  repository_links?: RepositoryLink[];
  dependencies?: Dependencies;
  disclosure?: DisclosureHints;
  analyzer_contributions: AnalyzerContribution[];
  metadata?: SystemMetadata;
}

export interface CASNode {
  id: string;
  name: string;
  tags: string[];

  perspectives?: string[];

  source: SourceLocation;
  type?: string;
  level?: number;
  level_name?: string;
  relationships?: Relationships;
  documentation?: Documentation;
  metrics?: Metrics;
  security?: SecurityContext;
  telemetry?: TelemetryHooks;
  dataFlow?: DataFlow;
  metadata?: {
    perspective_data?: Record<string, any>;
    [key: string]: any;
  };
}

export interface CASEdge {
  id: string;
  source: string;
  target: string;
  type: string;

  perspectives?: string[];
  analyzer?: string;
  dataFlow?: EdgeDataFlow;
  metadata?: {
    perspective_data?: Record<string, any>;
    [key: string]: any;
  };
}

export interface CASPerspective {
  id: string;
  name: string;
  description: string;
  analyzer_id: string;
  type: 'flow' | 'structure' | 'deployment' | 'data' | 'security' | 'custom';

  connection_rules?: {
    node_connections?: Array<{
      from_type: string;
      to_types: string[];
      edge_type: string;
      conditions?: Record<string, any>;
    }>;
    visible_node_types?: string[];
    relevant_edge_types?: string[];
  };

  layout_hints?: {
    style: 'hierarchical' | 'force' | 'circular' | 'grid';
    direction?: 'TB' | 'LR' | 'BT' | 'RL';
    group_by?: string;
  };

  metadata?: Record<string, any>;
}

export interface SourceLocation {
  file: string;
  line: number;
  end_line: number;
}

export interface EntryPoint {
  id: string;
  name: string;
  type: string;
  node_id: string;
  metadata?: Record<string, any>;
}

export interface ExitPoint {
  id: string;
  name: string;
  type: string;
  node_id: string;
  target?: string;
  metadata?: Record<string, any>;
}

export interface ExternalService {
  id: string;
  name: string;
  type: string;
  direction: 'consumption' | 'production' | 'bidirectional';
  connection_node: string;
  metadata?: Record<string, any>;
}

export interface AnalyzerContribution {
  analyzer_name: string;
  analyzer_type: string;
  version?: string;
  confidence: number;
  provided_perspectives?: string[];
}

export interface RepositoryLink {
  target_system_id: string;
  connection_type: string;
  metadata?: Record<string, any>;
}

export interface Dependencies {
  [key: string]: any;
}

export interface DisclosureHints {
  [key: string]: any;
}

export interface SystemMetadata {
  [key: string]: any;
}

export interface Relationships {
  [key: string]: any;
}

export interface Documentation {
  [key: string]: any;
}

export interface Metrics {
  [key: string]: any;
}

export interface SecurityContext {
  [key: string]: any;
}

export interface TelemetryHooks {
  [key: string]: any;
}

export interface DataFlow {
  [key: string]: any;
}

export interface EdgeDataFlow {
  [key: string]: any;
}

// UI-specific types for perspective views
export interface PerspectiveGroup {
  id: string;
  name: string;
  type: string;
  count: number;
  nodes: CASNode[];
  color: string;
  icon: React.ReactNode;
}

export interface ViewState {
  mode: 'overview' | 'perspective' | 'component';
  selectedPerspective?: string;
  selectedComponent?: string;
  zoom: number;
  position: { x: number; y: number };
}