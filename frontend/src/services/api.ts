export interface AnalysisResponse {
  success: boolean;
  cas_version: string;
  analysis_timestamp: string;
  analysis_id: string;
  system: {
    id: string;
    name: string;
    type: string;
    root_path: string;
  };
  nodes: any[];
  edges: any[];
  analyzer_contributions: any[];
  projectId?: string; // Optional for compatibility
}

export interface CASAnalysisRequest {
  projectPath: string;
  options?: {
    includeTests?: boolean;
    maxDepth?: number;
    frameworks?: string[];
  };
}

export interface CASAnalysisResponse {
  cas_version: string;
  analysis_timestamp: string;
  analysis_id: string;
  system: {
    id: string;
    name: string;
    type: string;
    root_path: string;
  };
  nodes: Array<{
    id: string;
    name: string;
    type: string;
    level: number;
    level_name: string;
    source: {
      file: string;
      line: number;
      end_line: number;
    };
    metadata: Record<string, any>;
  }>;
  edges: Array<{
    source: string;
    target: string;
    type: string;
    weight?: number;
  }>;
  analyzer_contributions: Array<{
    analyzer_name: string;
    analyzer_type: string;
    confidence: number;
  }>;
}

export interface DetectedAnalyzersResponse {
  analyzers: Array<{
    id: string;
    name: string;
    type: string;
    version: string;
    detectPatterns: any;
    requires?: string[];
  }>;
}

class APIService {
  private baseURL = process.env.NODE_ENV === 'development'
    ? 'http://localhost:3002/api'
    : '/api';

  async analyzeCAS(request: CASAnalysisRequest): Promise<CASAnalysisResponse> {
    const response = await fetch(`${this.baseURL}/analyze/cas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Analysis failed: ${response.statusText}`);
    }

    return response.json();
  }

  async getDetectedAnalyzers(projectPath: string): Promise<DetectedAnalyzersResponse> {
    const response = await fetch(`${this.baseURL}/analyze/cas/detected-analyzers?projectPath=${encodeURIComponent(projectPath)}`);

    if (!response.ok) {
      throw new Error(`Analyzer detection failed: ${response.statusText}`);
    }

    return response.json();
  }

  async getArchitectureLayout(analysisId: string) {
    const response = await fetch(`${this.baseURL}/architecture/layout/${analysisId}`);

    if (!response.ok) {
      throw new Error(`Architecture layout fetch failed: ${response.statusText}`);
    }

    return response.json();
  }

  async getArchitectureData(analysisId: string) {
    const response = await fetch(`${this.baseURL}/architecture/data/${analysisId}`);

    if (!response.ok) {
      throw new Error(`Architecture data fetch failed: ${response.statusText}`);
    }

    return response.json();
  }
}

export const apiService = new APIService();

export class AnalyzerAPI {
  static async analyze(request: { projectPath: string; language?: string; options?: any }): Promise<AnalysisResponse> {
    const baseURL = process.env.NODE_ENV === 'development' ? 'http://localhost:3002' : '';
    const response = await fetch(`${baseURL}/api/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Analysis failed: ${response.statusText}`);
    }

    return response.json();
  }
}