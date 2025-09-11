// Frontend types matching the backend API

export interface ComponentNode {
  id: string;
  name: string;
  type: ComponentType;
  path: string;
  dependencies: string[];
  dependents: string[];
  metadata: ComponentMetadata;
  position?: { x: number; y: number };
}

export type ComponentType = 
  | 'route' 
  | 'controller' 
  | 'middleware' 
  | 'model' 
  | 'service' 
  | 'utility' 
  | 'config'
  | 'database'
  | 'external_api'
  | 'orphaned';

export interface ComponentMetadata {
  lineCount: number;
  complexity: number;
  lastModified: string;
  exports: string[];
  imports: string[];
  httpMethods?: string[];
  dbQueries?: string[];
  externalCalls?: string[];
  isEntry?: boolean;
  isOrphaned?: boolean;
}

export interface ArchitectureBlueprint {
  projectName: string;
  framework: string;
  components: ComponentNode[];
  connections: Connection[];
  entryPoints: string[];
  orphanedComponents: string[];
  riskAreas: RiskArea[];
  metadata: ProjectMetadata;
}

export interface Connection {
  from: string;
  to: string;
  type: ConnectionType;
  weight: number;
  metadata?: {
    callSites: number;
    dataFlow?: string;
    httpMethod?: string;
  };
}

export type ConnectionType = 
  | 'import' 
  | 'http_call' 
  | 'database' 
  | 'middleware_chain' 
  | 'function_call'
  | 'data_flow';

export interface RiskArea {
  componentId: string;
  riskLevel: 'low' | 'medium' | 'high';
  reasons: string[];
  impact: string;
}

export interface ProjectMetadata {
  totalComponents: number;
  frameworkVersion: string;
  analysisDate: string;
  repositoryPath: string;
  entryPointsCount: number;
  orphanedCount: number;
  complexityAverage: number;
}

// API Request/Response types
export interface AnalysisRequest {
  repositoryPath: string;
  options?: {
    includeTests?: boolean;
    maxDepth?: number;
    excludePatterns?: string[];
  };
}

export interface AnalysisResponse {
  success: boolean;
  blueprint?: ArchitectureBlueprint;
  error?: string;
  processingTime: number;
}

// Legacy types for backward compatibility
export interface GraphData { 
  nodes: Node[]; 
  edges: Edge[];
  metadata: {
    framework: string;
    depth: number;
    erd: ERDData;
  }
}

export interface Node {
  id: string;
  label?: string;
  type: 'class' | 'method' | 'function';
  parents?: string[];
  hidden?: boolean;
}

export interface Edge {
  from: string;
  to: string;
  metadata?: {
    property_name?: string;
  };
}

export interface Model {
  name: string;
  fields: Array<{ name: string; type: string }>;
  relationships: Relationship[];
}

export interface Relationship {
  field_name: string;
  related_model: string;
  relation_type: string;
}

export interface ERDData {
  models: Model[];
  relationships: Relationship[];
}