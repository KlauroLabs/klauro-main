import { BillingTier, OnboardingState } from './billing.types';

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  billingTier: BillingTier;
  onboardingState: OnboardingState;
  createdAt: string;
  updatedAt: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  description?: string;
  logo_url?: string;
  billing_tier: BillingTier;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  description?: string;
  visibility: 'private' | 'public' | 'internal';
  ownerType: 'user' | 'organization';
  ownerId: string;
  ownerName: string;
  isActive: boolean;
  settings?: Record<string, any>;
  userRole?: string;
  accessGrantCount: number;
  codebaseCount?: number;
  tagCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceAccess {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  status: AccessStatus;
  grantedById?: string;
  grantedAt?: string;
  revokedAt?: string;
  revokedById?: string;
  expiresAt?: string;
  notes?: string;
  permissions?: Record<string, boolean>;
  createdAt: string;
  updatedAt: string;

  // Populated fields
  user?: Pick<User, 'id' | 'email' | 'name' | 'avatarUrl'>;
  workspace?: Pick<Workspace, 'id' | 'name'>;
  grantedBy?: Pick<User, 'id' | 'name' | 'email'>;
  revokedBy?: Pick<User, 'id' | 'name' | 'email'>;
}

export interface Codebase {
  id: string;
  name: string;
  description?: string;
  workspaceId: string;
  repositoryUrl?: string;
  repositoryProvider?: string;
  repositoryId?: string;
  defaultBranch?: string;
  language?: string;
  framework?: string;
  status: CodebaseStatus;
  tags?: string[];
  lastAnalyzedAt?: string;
  settings?: Record<string, any>;
  createdAt: string;
  updatedAt: string;

  // Extended fields (from CodebaseWithStatsResponseDto)
  fileCount?: number;
  sizeBytes?: number;
  languageBreakdown?: Record<string, number>;
  healthScore?: number;
  componentCount?: number;
  connectionCount?: number;
}

export type WorkspaceOwnerType = 'user' | 'organization';
export type WorkspaceVisibility = 'private' | 'public' | 'internal';

export type AccessLevel = 'viewer' | 'contributor' | 'admin' | 'owner';
export type WorkspaceRole = 'admin' | 'editor' | 'viewer';
export type AccessStatus = 'active' | 'pending' | 'revoked';

export type CodebaseStatus =
  | 'active'
  | 'archived'
  | 'analyzing'
  | 'error';

export type AnalysisStatus =
  | 'pending'
  | 'running'
  | 'analyzing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface WorkspaceSettings {
  visibility: 'private' | 'internal' | 'public';
  auto_analyze: boolean;
  retention_days: number;
  webhook_url?: string;
  notifications: {
    analysis_complete: boolean;
    analysis_failed: boolean;
    weekly_summary: boolean;
  };
}

export interface CodebaseSettings {
  auto_analyze: boolean;
  analysis_schedule?: string;
  ignore_patterns: string[];
  include_patterns: string[];
  max_file_size_mb: number;
  webhook_url?: string;
  notifications: {
    analysis_complete: boolean;
    analysis_failed: boolean;
    issues_detected: boolean;
  };
}

export interface WorkspaceStats {
  totalCodebases: number;
  activeCodebases: number;
  analyzingCodebases: number;
  errorCodebases: number;
  totalConnections: number;
  totalAnalysisRuns: number;
  lastAnalysisAt?: string;
  averageHealthScore: number;
}

export interface CodebaseStats {
  analysisCount: number;
  componentCount: number;
  lastAnalysisStatus?: string;
  healthScore: number;
  errorCount: number;
  telemetryEventsCount: number;
  connectionCount: number;
  incomingConnections: number;
  outgoingConnections: number;
}

export interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  invitedBy: string;
  invitedAt: string;
  expiresAt: string;
  acceptedAt?: string;
  status: AccessStatus;
  notes?: string;
  createdAt: string;
  updatedAt: string;

  // Populated fields
  workspace?: Pick<Workspace, 'id' | 'name' | 'ownerType'>;
  inviter?: Pick<User, 'id' | 'name' | 'email'>;
}

export interface CreateWorkspaceRequest {
  name: string;
  slug: string;
  description?: string;
  visibility?: WorkspaceVisibility;
  settings?: Record<string, any>;
}

export interface UpdateWorkspaceRequest {
  name?: string;
  description?: string;
  visibility?: WorkspaceVisibility;
  settings?: Record<string, any>;
}

export type CodebaseSourceType = 'repository_url' | 'local_path' | 'upload';

export interface CreateCodebaseRequest {
  name: string;
  description?: string;
  sourceType?: CodebaseSourceType;
  repositoryUrl?: string;
  localPath?: string;
  repositoryProvider?: string;
  repositoryId?: string;
  defaultBranch?: string;
  language?: string;
  framework?: string;
  settings?: Record<string, any>;
}

export interface WorkspaceListResponse {
  data: Workspace[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasMore: boolean;
}

export interface CodebaseListResponse {
  data: Codebase[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasMore: boolean;
}

export interface CodebaseDashboard {
  totalCodebases: number;
  activeCodebases: number;
  analyzingCodebases: number;
  errorCodebases: number;
  totalComponents: number;
  totalConnections: number;
  languageDistribution: Record<string, number>;
  frameworkDistribution: Record<string, number>;
  recentActivity: Array<{ date: string; analysisCount: number }>;
}

export interface UpdateCodebaseRequest {
  name?: string;
  description?: string;
  repositoryUrl?: string;
  repositoryProvider?: string;
  repositoryId?: string;
  defaultBranch?: string;
  language?: string;
  framework?: string;
  settings?: Record<string, any>;
}

export interface InviteUserRequest {
  email: string;
  role: WorkspaceRole;
  expiresAt?: string;
  notes?: string;
}

export interface WorkspaceContextValue {
  currentWorkspace: Workspace | null;
  workspaces: Workspace[];
  isLoading: boolean;
  error: string | null;
  switchWorkspace: (workspaceId: string) => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  createWorkspace: (data: CreateWorkspaceRequest) => Promise<Workspace>;
  updateWorkspace: (id: string, data: UpdateWorkspaceRequest) => Promise<Workspace>;
  deleteWorkspace: (id: string) => Promise<void>;
}