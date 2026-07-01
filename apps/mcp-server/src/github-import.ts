import type { KlauroConfig } from './klauro-config';
import { execFileSync } from 'node:child_process';
import { detectRemoteProvider } from './remote-provider';

export function buildGithubImportPlan(projectPath: string, config: KlauroConfig) {
  const detected = detectRemoteProvider(readGitRemote(projectPath));
  const owner = config.github?.owner || (detected?.provider === 'github' ? detected.owner : undefined);
  const repositories = config.github?.repositories?.length
    ? config.github.repositories
    : detected?.provider === 'github' && detected.repository ? [detected.repository] : [];
  return {
    project_path: projectPath,
    generated_at: new Date().toISOString(),
    detected_remote: detected,
    github_app: {
      owner,
      repositories,
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
    local_agent_note: 'GitHub import keeps hosted selected-branch analysis fresh. Local agents can still use private working-copy context for uncommitted changes that do not exist on the provider yet.',
  };
}

function readGitRemote(projectPath: string): string | undefined {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}
