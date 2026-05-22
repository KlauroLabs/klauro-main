import type { UnravlConfig } from './unravl-config';

export function buildGithubImportPlan(projectPath: string, config: UnravlConfig) {
  return {
    project_path: projectPath,
    generated_at: new Date().toISOString(),
    github_app: {
      owner: config.github?.owner,
      repositories: config.github?.repositories || [],
      default_branch_only: config.github?.defaultBranchOnly !== false,
      installation_id: config.github?.installationId,
    },
    required_permissions: [
      { scope: 'repository.contents', access: 'read', reason: 'Clone/import source for main-branch CAS analysis' },
      { scope: 'repository.metadata', access: 'read', reason: 'Resolve repository identity, default branch, and visibility' },
      { scope: 'pull_requests', access: 'read', reason: 'Optional PR analysis and changed-file context' },
      { scope: 'checks', access: 'write', reason: 'Optional Agent Readiness checks on commits and PRs' },
    ],
    webhooks: [
      { event: 'push', reason: 'Refresh main-branch CAS after code changes' },
      { event: 'pull_request', reason: 'Run PR-level readiness and change-risk analysis' },
      { event: 'installation_repositories', reason: 'Track repositories added to or removed from the installation' },
    ],
    local_agent_note: 'GitHub import keeps hosted main-branch truth fresh. Local agents still use remote-sync for dirty working-tree changes that do not exist on GitHub yet.',
  };
}
