import { CASOutput } from './cas.types';

export interface AnalysisRun {
  id: string;
  projectId: string;
  triggeredById?: string;
  status: AnalysisStatus;
  type: AnalysisType;
  branch?: string;
  commitSha?: string;
  startedAt?: string;
  completedAt?: string;
  processingTimeMs?: number;
  progress?: number;
  currentOperation?: string;
  errorMessage?: string;
  configuration?: Record<string, any>;
  metadata?: Record<string, any>;
  manifestPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodebaseAnalysis extends AnalysisRun {
  // Legacy alias for AnalysisRun
  codebaseId: string;
  workspaceId: string;
  casOutput?: CASOutput;
  fileCount?: number;
  sizeBytes?: number;
  languageBreakdown?: Record<string, number>;
  complexityScore?: number;
  maintainabilityScore?: number;
  testCoverage?: number;
  documentationCoverage?: number;
  issuesCount?: number;
  criticalIssuesCount?: number;
  securityIssuesCount?: number;
  performanceIssuesCount?: number;
  analysisDurationMs?: number;
  analyzerVersion?: string;
  analysisConfig?: AnalysisConfig;
}

export type AnalysisStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export type AnalysisType =
  | 'manual'
  | 'scheduled'
  | 'webhook'
  | 'api';

export interface AnalysisConfig {
  include_patterns: string[];
  exclude_patterns: string[];
  max_file_size_mb: number;
  max_depth: number;
  enable_call_graph: boolean;
  enable_security_analysis: boolean;
  enable_performance_analysis: boolean;
  enable_documentation_analysis: boolean;
  language_specific?: Record<string, any>;
}

export interface CodebaseHealth {
  overall_score: number; // 0-100

  scores: {
    complexity: number;
    maintainability: number;
    test_coverage: number;
    documentation: number;
    security: number;
    performance: number;
  };

  trends: {
    score_change_7d: number;
    score_change_30d: number;
    analysis_frequency: number;
  };

  recommendations: HealthRecommendation[];
}

export interface HealthRecommendation {
  id: string;
  type: 'complexity' | 'testing' | 'documentation' | 'security' | 'performance' | 'refactoring';
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  affected_files?: string[];
  estimated_effort?: 'low' | 'medium' | 'high';
  priority: number;
}

export interface CodebaseInsights {
  entry_points: {
    count: number;
    types: Record<string, number>;
    most_complex: Array<{
      name: string;
      complexity_score: number;
      file: string;
    }>;
  };

  hot_spots: Array<{
    file: string;
    function: string;
    complexity_score: number;
    call_frequency?: number;
    change_frequency?: number;
  }>;

  dead_code: Array<{
    file: string;
    function: string;
    last_accessed?: string;
  }>;

  dependencies: {
    external_count: number;
    internal_count: number;
    circular_dependencies: Array<{
      files: string[];
      severity: 'warning' | 'error';
    }>;
  };

  architecture_patterns: Array<{
    pattern: string;
    confidence: number;
    files: string[];
  }>;

  technical_debt: {
    estimated_hours: number;
    todo_count: number;
    hack_count: number;
    deprecated_usage_count: number;
  };
}

export interface AnalysisProgress {
  analysisId: string;
  status: AnalysisStatus;
  progress: number;
  currentOperation?: string;
  estimatedTimeRemaining?: number;
  timestamp: string;
}

export interface AnalysisHistoryItem {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: AnalysisStatus;
  type: AnalysisType;
  processingTimeMs?: number;
  progress?: number;
  errorMessage?: string;
  manifestPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodebaseComparison {
  baseline_analysis_id: string;
  comparison_analysis_id: string;

  changes: {
    files_added: number;
    files_removed: number;
    files_modified: number;

    complexity_change: number;
    maintainability_change: number;
    test_coverage_change: number;

    new_issues: number;
    resolved_issues: number;

    new_entry_points: number;
    removed_entry_points: number;
  };

  detailed_changes: Array<{
    file: string;
    change_type: 'added' | 'removed' | 'modified';
    complexity_change?: number;
    lines_added?: number;
    lines_removed?: number;
  }>;
}

export interface CreateAnalysisRequest {
  type?: AnalysisType;
  branch?: string;
  configuration?: Partial<AnalysisConfig>;
  callbackUrl?: string;
}

export interface AnalysisFilters {
  status?: AnalysisStatus[];
  type?: AnalysisType[];
  dateRange?: {
    start: string;
    end: string;
  };
  branch?: string;
  page?: number;
  limit?: number;
}

export interface AnalysisRunListResponse {
  data: AnalysisRun[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasMore: boolean;
}

export interface ArchitectureBlueprint {
  id: string;
  projectName: string;
  framework: string;
  components: any[];
  connections: any[];
  entryPoints: any[];
  exitPoints: any[];
  orphanedComponents: string[];
  riskAreas: any[];
  technologyStack: any;
  dependencies: any;
  apiEndpoints: any[];
  securityAnalysis: any;
  testingInfo: any;
  metadata: any;
  databaseInfo?: any;
  deploymentInfo?: any;
  statistics: {
    totalComponents: number;
    totalConnections: number;
    averageComplexity: number;
    riskAreas: number;
    orphanedCount: number;
    cyclomaticComplexity: number;
    technicalDebt: number;
  };
}

export interface AnalysisResult {
  success: boolean;
  analysisRun: AnalysisRun;
  blueprint?: ArchitectureBlueprint;
  manifestPath?: string;
  analyzersUsed?: Array<{
    name: string;
    type: string;
    status: string;
  }>;
  metadata?: any;
  error?: string;
  processingTime: number;
}

export interface CodebaseContextValue {
  currentCodebase: import('./workspace.types').Codebase | null;
  codebases: import('./workspace.types').Codebase[];
  currentAnalysis: AnalysisRun | null;
  analysisHistory: AnalysisHistoryItem[];
  isLoading: boolean;
  error: string | null;

  // Actions
  switchCodebase: (codebaseId: string) => Promise<void>;
  refreshCodebases: () => Promise<void>;
  startAnalysis: (codebaseId: string, config?: Partial<AnalysisConfig>) => Promise<string>;
  cancelAnalysis: (analysisId: string) => Promise<void>;
  getAnalysisHistory: (codebaseId: string, filters?: AnalysisFilters) => Promise<AnalysisHistoryItem[]>;
  compareAnalyses: (baselineId: string, comparisonId: string) => Promise<CodebaseComparison>;
}