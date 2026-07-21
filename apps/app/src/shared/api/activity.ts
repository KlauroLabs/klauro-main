import { apiRequest } from './client';
import type { SessionUser } from './auth';
import type { Project, ProjectRevision } from './projects';
import type { Workspace, WorkspaceMember } from './workspaces';

export interface AppStateData {
  user: SessionUser;
  workspaces: Workspace[];
  projectsByWorkspace: Record<string, Project[]>;
  membersByWorkspace: Record<string, WorkspaceMember[]>;
  revisionsByProject: Record<string, ProjectRevision[]>;
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
