export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

export interface Session {
  token: string;
  user: SessionUser;
}

export interface Workspace {
  id: string;
  name: string;
  role: string;
  project_count: number;
  user_count: number;
}

export interface Project {
  id: string;
  workspace_id?: string;
  name: string;
  repo_url?: string;
  local_path?: string;
  analysis_id?: string;
}

export interface WorkspaceMember {
  id: string;
  email: string;
  name?: string;
  role: string;
}

export interface ProjectRevision {
  analysis_id: string;
  analysis_revision: number;
  branch?: string;
  commit?: string;
  source: string;
  generated_at: string;
  files: number;
  bytes: number;
  nodes: number;
  edges: number;
}

export interface AppStateData {
  user: SessionUser;
  workspaces: Workspace[];
  projectsByWorkspace: Record<string, Project[]>;
  membersByWorkspace: Record<string, WorkspaceMember[]>;
  revisionsByProject: Record<string, ProjectRevision[]>;
}

const configuredBase = import.meta.env.VITE_KLAURO_API_URL as string | undefined;
// app.klauro.com is a static host with no /api/* routes of its own — the API
// lives on mcp.klauro.com. If a build ever ships without VITE_KLAURO_API_URL
// baked in (the original cause of the alpha login failure), fall back to the
// known-good API host for that specific hostname instead of same-origin,
// which would 405 on every auth call. Local dev (any other hostname) keeps
// the same-origin fallback so a dev-run API on the current host still works.
const knownProductionApiHosts: Record<string, string> = {
  'app.klauro.com': 'https://mcp.klauro.com',
};
const fallbackBase = knownProductionApiHosts[window.location.hostname] || window.location.origin;
export const apiBaseUrl = (configuredBase || fallbackBase).replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function apiRequest<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(typeof body.error === 'string' ? body.error : 'Request failed', response.status);
  }
  return body as T;
}

export function signIn(email: string, password: string): Promise<Session> {
  return apiRequest<Session>('/api/auth/login', '', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function registerAccount(input: { email: string; name?: string; password: string; workspace_name?: string }): Promise<Session> {
  return apiRequest<Session>('/api/auth/register', '', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function loadAppData(token: string): Promise<AppStateData> {
  const me = await apiRequest<{ user: SessionUser }>('/api/me', token);
  const workspaceResult = await apiRequest<{ workspaces: Workspace[] }>('/api/workspaces', token);
  const projectsByWorkspace: Record<string, Project[]> = {};
  const membersByWorkspace: Record<string, WorkspaceMember[]> = {};
  const revisionsByProject: Record<string, ProjectRevision[]> = {};

  await Promise.all(workspaceResult.workspaces.map(async workspace => {
    const [projects, members] = await Promise.all([
      apiRequest<{ projects: Project[] }>(`/api/workspaces/${encodeURIComponent(workspace.id)}/projects`, token),
      apiRequest<{ users: WorkspaceMember[] }>(`/api/workspaces/${encodeURIComponent(workspace.id)}/users`, token),
    ]);
    projectsByWorkspace[workspace.id] = projects.projects.map(project => ({ ...project, workspace_id: workspace.id }));
    membersByWorkspace[workspace.id] = members.users;
    await Promise.all(projectsByWorkspace[workspace.id].map(async project => {
      const analysisId = project.analysis_id || project.id;
      try {
        const revisions = await apiRequest<{ revisions: ProjectRevision[] }>(`/v1/projects/${encodeURIComponent(analysisId)}/revisions`, token);
        revisionsByProject[project.id] = revisions.revisions;
      } catch {
        revisionsByProject[project.id] = [];
      }
    }));
  }));

  return {
    user: me.user,
    workspaces: workspaceResult.workspaces,
    projectsByWorkspace,
    membersByWorkspace,
    revisionsByProject,
  };
}

export function createWorkspace(token: string, name: string): Promise<{ workspace: Workspace }> {
  return apiRequest('/api/workspaces', token, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export function createProject(token: string, workspaceId: string, input: { name: string; repo_url?: string; local_path?: string; analysis_id?: string }): Promise<{ project: Project }> {
  return apiRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function addWorkspaceMember(token: string, workspaceId: string, input: { email: string; role: string }): Promise<{ membership: WorkspaceMember }> {
  return apiRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/users`, token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
