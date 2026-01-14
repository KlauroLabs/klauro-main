import {
  Workspace,
  WorkspaceAccess,
  Codebase,
  WorkspaceStats,
  CreateWorkspaceRequest,
  UpdateWorkspaceRequest,
  CreateCodebaseRequest,
  UpdateCodebaseRequest,
  InviteUserRequest,
  WorkspaceInvitation,
  WorkspaceListResponse,
  CodebaseListResponse,
} from '../types/workspace.types';
import {
  AnalysisRun,
  CreateAnalysisRequest,
  AnalysisProgress,
  AnalysisHistoryItem,
  CodebaseComparison,
  AnalysisFilters,
  AnalysisRunListResponse,
  AnalysisResult,
} from '../types/codebase.types';
import { BillingUsage } from '../types/billing.types';
import { User } from '../types/workspace.types';

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
    ? 'http://localhost:3001/api'
    : '/api';

  private async fetchWithAuth<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const token = localStorage.getItem('accessToken');
    const headers = {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers,
    };

    const response = await fetch(`${this.baseURL}${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      if (response.status === 401) {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('user');
        window.location.href = '/login';
        throw new Error('Session expired. Please login again.');
      }

      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(errorData.message || `Request failed: ${response.statusText}`);
    }

    return response.json();
  }

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

  // User Management
  async getCurrentUser(): Promise<User> {
    return this.fetchWithAuth<User>('/user/me');
  }

  async updateUser(data: Partial<User>): Promise<User> {
    return this.fetchWithAuth<User>('/user/me', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async getBillingUsage(): Promise<BillingUsage> {
    return this.fetchWithAuth<BillingUsage>('/user/billing/usage');
  }

  // Workspace Management
  async getWorkspaces(): Promise<WorkspaceListResponse> {
    return this.fetchWithAuth<WorkspaceListResponse>('/workspaces');
  }

  async getWorkspace(id: string): Promise<Workspace> {
    return this.fetchWithAuth<Workspace>(`/workspaces/${id}`);
  }

  async createPersonalWorkspace(data: CreateWorkspaceRequest): Promise<Workspace> {
    return this.fetchWithAuth<Workspace>('/workspaces/user', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async createOrganizationWorkspace(organizationId: string, data: CreateWorkspaceRequest): Promise<Workspace> {
    return this.fetchWithAuth<Workspace>(`/workspaces/organization/${organizationId}`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateWorkspace(id: string, data: UpdateWorkspaceRequest): Promise<Workspace> {
    return this.fetchWithAuth<Workspace>(`/workspaces/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteWorkspace(id: string): Promise<void> {
    await this.fetchWithAuth<void>(`/workspaces/${id}`, {
      method: 'DELETE',
    });
  }

  async getWorkspaceStats(id: string): Promise<WorkspaceStats> {
    return this.fetchWithAuth<WorkspaceStats>(`/workspaces/${id}/stats`);
  }

  // Workspace Access Management
  async getWorkspaceAccess(workspaceId: string): Promise<WorkspaceAccess[]> {
    return this.fetchWithAuth<WorkspaceAccess[]>(`/workspaces/${workspaceId}/access`);
  }

  async inviteUserToWorkspace(workspaceId: string, data: InviteUserRequest): Promise<WorkspaceInvitation> {
    return this.fetchWithAuth<WorkspaceInvitation>(`/workspaces/${workspaceId}/invite`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateWorkspaceAccess(workspaceId: string, userId: string, accessLevel: string): Promise<WorkspaceAccess> {
    return this.fetchWithAuth<WorkspaceAccess>(`/workspaces/${workspaceId}/access/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ accessLevel }),
    });
  }

  async removeWorkspaceAccess(workspaceId: string, userId: string): Promise<void> {
    await this.fetchWithAuth<void>(`/workspaces/${workspaceId}/access/${userId}`, {
      method: 'DELETE',
    });
  }

  // Codebase Management
  async getCodebases(workspaceId: string): Promise<CodebaseListResponse> {
    return this.fetchWithAuth<CodebaseListResponse>(`/workspaces/${workspaceId}/codebases`);
  }

  async getCodebase(workspaceId: string, codebaseId: string): Promise<Codebase> {
    return this.fetchWithAuth<Codebase>(`/workspaces/${workspaceId}/codebases/${codebaseId}`);
  }

  async createCodebase(workspaceId: string, data: CreateCodebaseRequest): Promise<Codebase> {
    return this.fetchWithAuth<Codebase>(`/workspaces/${workspaceId}/codebases`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateCodebase(workspaceId: string, codebaseId: string, data: UpdateCodebaseRequest): Promise<Codebase> {
    return this.fetchWithAuth<Codebase>(`/workspaces/${workspaceId}/codebases/${codebaseId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteCodebase(workspaceId: string, codebaseId: string): Promise<void> {
    await this.fetchWithAuth<void>(`/workspaces/${workspaceId}/codebases/${codebaseId}`, {
      method: 'DELETE',
    });
  }

  async startCodebaseAnalysis(workspaceId: string, codebaseId: string): Promise<void> {
    return this.fetchWithAuth<void>(`/workspaces/${workspaceId}/codebases/${codebaseId}/analyze`, {
      method: 'POST',
    });
  }

  // Analysis Management
  async getAnalyses(workspaceId: string, codebaseId: string, filters?: AnalysisFilters): Promise<AnalysisRunListResponse> {
    const queryParams = filters ? '?' + new URLSearchParams(filters as any).toString() : '';
    return this.fetchWithAuth<AnalysisRunListResponse>(`/workspaces/${workspaceId}/codebases/${codebaseId}/analyses${queryParams}`);
  }

  async getAnalysis(workspaceId: string, codebaseId: string, analysisId: string): Promise<AnalysisResult> {
    return this.fetchWithAuth<AnalysisResult>(`/workspaces/${workspaceId}/codebases/${codebaseId}/analyses/${analysisId}`);
  }

  async createAnalysis(workspaceId: string, codebaseId: string, data: CreateAnalysisRequest): Promise<AnalysisResult> {
    return this.fetchWithAuth<AnalysisResult>(`/workspaces/${workspaceId}/codebases/${codebaseId}/analyses`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async cancelAnalysis(workspaceId: string, codebaseId: string, analysisId: string): Promise<void> {
    await this.fetchWithAuth<void>(`/workspaces/${workspaceId}/codebases/${codebaseId}/analyses/${analysisId}/cancel`, {
      method: 'POST',
    });
  }

  async getAnalysisProgress(workspaceId: string, codebaseId: string, analysisId: string): Promise<AnalysisProgress> {
    return this.fetchWithAuth<AnalysisProgress>(`/workspaces/${workspaceId}/codebases/${codebaseId}/analyses/${analysisId}/progress`);
  }

  async getAnalysisHistory(workspaceId: string, codebaseId: string, filters?: AnalysisFilters): Promise<AnalysisHistoryItem[]> {
    const queryParams = filters ? '?' + new URLSearchParams(filters as any).toString() : '';
    return this.fetchWithAuth<AnalysisHistoryItem[]>(`/workspaces/${workspaceId}/codebases/${codebaseId}/analyses/history${queryParams}`);
  }

  async compareAnalyses(workspaceId: string, codebaseId: string, baselineId: string, comparisonId: string): Promise<CodebaseComparison> {
    return this.fetchWithAuth<CodebaseComparison>(`/workspaces/${workspaceId}/codebases/${codebaseId}/analyses/compare?baseline=${baselineId}&comparison=${comparisonId}`);
  }
}

export const apiService = new APIService();

export class AnalyzerAPI {
  static async analyze(request: { projectPath: string; language?: string; options?: any }): Promise<AnalysisResponse> {
    const baseURL = process.env.NODE_ENV === 'development' ? 'http://localhost:3001' : '';
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