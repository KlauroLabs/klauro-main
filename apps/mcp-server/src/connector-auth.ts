import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_KLAURO_CLOUD_URL } from './defaults';

export interface ConnectorEntitlement {
  status: 'active' | 'trialing' | 'inactive';
  plan?: string;
  source?: string;
}

export interface ConnectorIdentity {
  user?: {
    id: string;
    email: string;
    name?: string;
  };
  entitlement: ConnectorEntitlement;
}

export interface StoredConnectorAuth {
  version: 1;
  defaultServerUrl?: string;
  accounts: Record<string, {
    token: string;
    email?: string;
    updated_at: string;
  }>;
}

/**
 * Network-unreachable classification: a nonexistent host / refused connection /
 * DNS failure / timeout is NOT an auth problem, and telling the user to
 * `klauro login` against a server that doesn't exist (2026-07 cold-customer
 * audit: a typo'd --server-url produced "Klauro account required") sends them
 * chasing the wrong fix. undici's fetch wraps these as TypeError('fetch
 * failed') with the syscall error on `cause`.
 */
export function isNetworkUnreachableError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: string }).name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const cause = (error as { cause?: unknown }).cause ?? error;
  const code = (cause as { code?: unknown })?.code;
  if (typeof code === 'string' &&
    /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT)$/.test(code)) {
    return true;
  }
  return error instanceof TypeError && /fetch failed/i.test(error.message || '');
}

export function unreachableServerError(serverUrl: string, error: unknown): Error {
  const cause = (error as { cause?: { code?: string } })?.cause;
  const detail = cause?.code || (error instanceof Error ? error.message : String(error));
  return new Error(`Could not reach ${serverUrl} — check the server URL (${detail}).`);
}

export function connectorToken(explicitToken?: string, serverUrl?: string): string | undefined {
  return explicitToken ||
    process.env.KLAURO_ACCOUNT_TOKEN ||
    process.env.KLAURO_AUTH_TOKEN ||
    process.env.KLAURO_ANALYZER_TOKEN ||
    loadStoredConnectorToken(serverUrl);
}

export async function requireConnectorEntitlement(input: {
  serverUrl?: string;
  token?: string;
} = {}): Promise<ConnectorIdentity> {
  if (process.env.KLAURO_CONNECTOR_AUTH_DISABLED === 'true' || process.env.KLAURO_CONNECTOR_AUTH_DISABLED === '1') {
    return {
      entitlement: {
        status: 'active',
        plan: 'dev-bypass',
        source: 'KLAURO_CONNECTOR_AUTH_DISABLED',
      },
    };
  }

  const token = connectorToken(input.token, input.serverUrl);
  const serverUrl = normalizeServerUrl(input.serverUrl);
  if (!token) {
    // No stored token for THIS server url. Before claiming auth is the
    // problem, check the url is even reachable: with a wrong/typo'd
    // --server-url there is never a stored account for it, so this branch
    // used to misdiagnose an unreachable host as "account required".
    try {
      await fetch(`${serverUrl}/api/me`, { signal: AbortSignal.timeout(5000) });
    } catch (error) {
      if (isNetworkUnreachableError(error)) throw unreachableServerError(serverUrl, error);
      // Reachability probe failed for a non-network reason — fall through to
      // the honest auth message.
    }
    throw new Error(`Klauro account required for ${serverUrl}. Run \`klauro login\` or set KLAURO_ACCOUNT_TOKEN before local indexing, sync, or MCP hosted context.`);
  }

  let response: Response;
  try {
    response = await fetch(`${serverUrl}/api/me`, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
  } catch (error) {
    if (isNetworkUnreachableError(error)) throw unreachableServerError(serverUrl, error);
    throw error;
  }
  const payload = await response.json().catch(() => ({})) as any;
  if (response.status === 401) {
    throw new Error(payload?.error || `Klauro authentication failed (HTTP 401) at ${serverUrl}. Run \`klauro login\` to sign in again.`);
  }
  if (!response.ok) {
    throw new Error(payload?.error || `Klauro account check failed with HTTP ${response.status}`);
  }

  const entitlement = normalizeEntitlement(payload?.entitlement);
  if (entitlement.status !== 'active' && entitlement.status !== 'trialing') {
    throw new Error(`Klauro subscription required. Current entitlement: ${entitlement.status}`);
  }

  return {
    user: payload?.user,
    entitlement,
  };
}

export function authConfigPath(): string {
  return process.env.KLAURO_AUTH_CONFIG_PATH || path.join(os.homedir(), '.klauro', 'auth.json');
}

export function normalizeServerUrl(serverUrl?: string): string {
  return (serverUrl || process.env.KLAURO_API_URL || process.env.KLAURO_ANALYZER_URL || process.env.KLAURO_URL || DEFAULT_KLAURO_CLOUD_URL).replace(/\/+$/, '');
}

export function loadStoredConnectorAuth(): StoredConnectorAuth {
  const file = authConfigPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredConnectorAuth;
    if (parsed && parsed.version === 1 && parsed.accounts && typeof parsed.accounts === 'object') return parsed;
  } catch {
    // Missing or invalid auth should behave like signed-out.
  }
  return { version: 1, accounts: {} };
}

export function loadStoredConnectorToken(serverUrl?: string): string | undefined {
  const auth = loadStoredConnectorAuth();
  const normalized = normalizeServerUrl(serverUrl || auth.defaultServerUrl);
  return auth.accounts[normalized]?.token;
}

export function saveStoredConnectorSession(input: {
  serverUrl?: string;
  token: string;
  email?: string;
}): { file: string; serverUrl: string } {
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const file = authConfigPath();
  const auth = loadStoredConnectorAuth();
  auth.defaultServerUrl = serverUrl;
  auth.accounts[serverUrl] = {
    token: input.token,
    email: input.email,
    updated_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on platforms/filesystems that do not support chmod.
  }
  return { file, serverUrl };
}

export function clearStoredConnectorSession(serverUrl?: string): { file: string; removed: boolean; serverUrl: string } {
  const file = authConfigPath();
  const auth = loadStoredConnectorAuth();
  const normalized = normalizeServerUrl(serverUrl || auth.defaultServerUrl);
  const removed = Boolean(auth.accounts[normalized]);
  delete auth.accounts[normalized];
  if (auth.defaultServerUrl === normalized) auth.defaultServerUrl = Object.keys(auth.accounts)[0];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort.
  }
  return { file, removed, serverUrl: normalized };
}

function normalizeEntitlement(value: any): ConnectorEntitlement {
  if (value && (value.status === 'active' || value.status === 'trialing' || value.status === 'inactive')) {
    return {
      status: value.status,
      plan: typeof value.plan === 'string' ? value.plan : undefined,
      source: typeof value.source === 'string' ? value.source : undefined,
    };
  }
  return {
    status: 'active',
    plan: 'alpha',
    source: 'legacy-account',
  };
}
