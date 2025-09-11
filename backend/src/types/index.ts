// Core architecture types for Unravl visualization

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
  complexity: number; // 1-10 scale
  lastModified: Date;
  exports: string[];
  imports: string[];
  httpMethods?: string[]; // For routes
  dbQueries?: string[]; // For models/services
  externalCalls?: string[]; // For API integrations
  isEntry?: boolean; // Entry points (main routes)
  isOrphaned?: boolean; // No dependencies or dependents
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
  from: string; // Component ID
  to: string; // Component ID
  type: ConnectionType;
  weight: number; // Usage frequency/importance
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
  analysisDate: Date;
  repositoryPath: string;
  entryPointsCount: number;
  orphanedCount: number;
  complexityAverage: number;
}

// Analysis request/response types
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