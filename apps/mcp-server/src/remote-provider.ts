export type RemoteProvider = 'github' | 'gitlab' | 'bitbucket' | 'azure_devops' | 'custom';

export interface RemoteProviderInfo {
  provider: RemoteProvider;
  host?: string;
  owner?: string;
  repository?: string;
  repository_url?: string;
  connectable: boolean;
  suggested_connection?: {
    type: 'github_app' | 'git_provider';
    action: string;
    reason: string;
  };
}

export function detectRemoteProvider(remoteUrl?: string): RemoteProviderInfo | undefined {
  if (!remoteUrl) return undefined;
  const parsed = parseGitRemote(remoteUrl.trim());
  if (!parsed) {
    return {
      provider: 'custom',
      repository_url: remoteUrl,
      connectable: false,
    };
  }

  const provider = providerFromHost(parsed.host);
  const info: RemoteProviderInfo = {
    provider,
    host: parsed.host,
    owner: parsed.owner,
    repository: parsed.repository,
    repository_url: normalizeRepositoryUrl(parsed),
    connectable: provider !== 'custom' && Boolean(parsed.owner && parsed.repository),
  };

  if (provider === 'github' && info.connectable) {
    info.suggested_connection = {
      type: 'github_app',
      action: `Connect ${parsed.owner}/${parsed.repository} through the Klauro GitHub App`,
      reason: 'Hosted selected-branch analysis can stay fresh from push webhooks; local agents can still use private working-copy context for uncommitted work.',
    };
  } else if (info.connectable) {
    info.suggested_connection = {
      type: 'git_provider',
      action: `Connect ${parsed.owner}/${parsed.repository} from ${providerLabel(provider)}`,
      reason: 'Hosted repository import can keep pushed analysis current; private working-copy context covers uncommitted agent work.',
    };
  }

  return info;
}

function parseGitRemote(value: string): { host: string; owner?: string; repository?: string; protocol?: string } | undefined {
  const scpLike = value.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (scpLike && !value.includes('://')) return parsePath(scpLike[1], scpLike[2], 'ssh');

  try {
    const url = new URL(value);
    return parsePath(url.hostname, url.pathname.replace(/^\/+/, ''), url.protocol.replace(/:$/, ''));
  } catch {
    const hostPath = value.match(/^([^/]+)\/(.+)$/);
    return hostPath ? parsePath(hostPath[1], hostPath[2]) : undefined;
  }
}

function parsePath(host: string, rawPath: string, protocol?: string): { host: string; owner?: string; repository?: string; protocol?: string } {
  const parts = rawPath.replace(/\.git$/i, '').split('/').filter(Boolean);
  return {
    host: host.toLowerCase(),
    owner: parts[0],
    repository: parts[1],
    protocol,
  };
}

function providerFromHost(host: string): RemoteProvider {
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
  if (host === 'gitlab.com' || host.endsWith('.gitlab.com')) return 'gitlab';
  if (host === 'bitbucket.org' || host.endsWith('.bitbucket.org')) return 'bitbucket';
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) return 'azure_devops';
  return 'custom';
}

function providerLabel(provider: RemoteProvider): string {
  if (provider === 'gitlab') return 'GitLab';
  if (provider === 'bitbucket') return 'Bitbucket';
  if (provider === 'azure_devops') return 'Azure DevOps';
  if (provider === 'github') return 'GitHub';
  return 'the configured Git provider';
}

function normalizeRepositoryUrl(parsed: { host: string; owner?: string; repository?: string }): string | undefined {
  if (!parsed.owner || !parsed.repository) return undefined;
  return `https://${parsed.host}/${parsed.owner}/${parsed.repository}`;
}
