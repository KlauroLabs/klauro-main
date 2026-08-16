import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_KLAURO_CLOUD_URL } from './defaults';
import { findErrorCode, unwrapCauseChain } from './hosted-transport';

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

export interface StoredConnectorAccount {
  token: string;
  email?: string;
  updated_at: string;
}

















export interface StoredConnectorAuth {
  version: 1;
  defaultServerUrl?: string;
  accounts: Record<string, StoredConnectorAccount>;
  accountsByServer?: Record<string, Record<string, StoredConnectorAccount>>;
}









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




  const chain = unwrapCauseChain(error);
  const code = findErrorCode(error);
  const chainText = chain.join(' <- ');
  const detail = code && !chainText.includes(code)
    ? `${code}: ${chainText}`
    : chainText || String(error);
  return new Error(
    `Could not reach ${serverUrl} — check the server URL and network connectivity (${detail}), then run \`klauro doctor\`.`
  );
}










export const SESSION_TOKEN_TTL_DAYS = 14;



export const TOKEN_EXPIRY_WARN_DAYS = 11;

export interface SessionAge {
  ageDays: number | null;
  daysRemaining: number | null;
}


export function describeSessionAge(updatedAt: string | undefined, now: Date = new Date()): SessionAge {
  if (!updatedAt) return { ageDays: null, daysRemaining: null };
  const parsed = new Date(updatedAt);
  if (Number.isNaN(parsed.getTime())) return { ageDays: null, daysRemaining: null };
  const ageDays = (now.getTime() - parsed.getTime()) / (24 * 60 * 60 * 1000);
  return { ageDays, daysRemaining: SESSION_TOKEN_TTL_DAYS - ageDays };
}




let warnedThisProcess = false;


export function resetSessionWarningStateForTests(): void {
  warnedThisProcess = false;
}









export function warnIfSessionExpiringSoon(
  serverUrl: string,
  account: StoredConnectorAuth['accounts'][string] | undefined,
  now: Date = new Date(),
  stderr: { write: (chunk: string) => unknown } = process.stderr,
): void {
  if (!account || warnedThisProcess) return;
  const { ageDays } = describeSessionAge(account.updated_at, now);
  if (ageDays === null || ageDays < TOKEN_EXPIRY_WARN_DAYS) return;
  warnedThisProcess = true;
  const who = account.email ? ` as ${account.email}` : '';
  if (ageDays >= SESSION_TOKEN_TTL_DAYS) {
    stderr.write(`Klauro: your session${who} on ${serverUrl} is ${ageDays.toFixed(1)} days old, past the ${SESSION_TOKEN_TTL_DAYS}-day TTL — it has very likely expired. Run \`klauro login\` to refresh.\n`);
  } else {
    stderr.write(`Klauro: your session${who} on ${serverUrl} is ${ageDays.toFixed(1)} days old and will expire around day ${SESSION_TOKEN_TTL_DAYS}. Run \`klauro login\` soon to avoid an interruption.\n`);
  }
}

export type AuthStatusState = 'no-token' | 'signed-in' | 'rejected' | 'unreachable';

export interface AuthStatusResult {
  state: AuthStatusState;
  server_url: string;
  email?: string;
  session_age_days?: number;
  days_remaining?: number;
  ttl_days: number;
  last_refreshed?: string;
  auth_file: string;
  detail: string;
}















export async function resolveAuthStatus(input: {
  serverUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<AuthStatusResult> {
  const auth = loadStoredConnectorAuth();
  const serverUrl = normalizeServerUrl(input.serverUrl || auth.defaultServerUrl);
  const account = auth.accounts[serverUrl];
  const authFile = authConfigPath();
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 6000;

  if (!account) {
    return {
      state: 'no-token',
      server_url: serverUrl,
      ttl_days: SESSION_TOKEN_TTL_DAYS,
      auth_file: authFile,
      detail: `Not signed in to ${serverUrl}. Run \`klauro login --email you@example.com --register\` (omit --register if you already have an account).`,
    };
  }

  const { ageDays, daysRemaining } = describeSessionAge(account.updated_at);

  let response: Response;
  try {
    response = await fetchImpl(`${serverUrl}/api/me`, {
      headers: { authorization: `Bearer ${account.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = isNetworkUnreachableError(error) ? 'unreachable' : (error instanceof Error ? error.message : String(error));
    return {
      state: 'unreachable',
      server_url: serverUrl,
      email: account.email,
      session_age_days: ageDays ?? undefined,
      ttl_days: SESSION_TOKEN_TTL_DAYS,
      last_refreshed: account.updated_at,
      auth_file: authFile,
      detail: `Cannot reach ${serverUrl} to verify the session (${reason}). Local token present${account.email ? ` for ${account.email}` : ''}, last refreshed ${account.updated_at}.`,
    };
  }

  const payload = await response.json().catch(() => ({})) as any;

  if (response.status === 401) {
    return {
      state: 'rejected',
      server_url: serverUrl,
      email: account.email,
      session_age_days: ageDays ?? undefined,
      ttl_days: SESSION_TOKEN_TTL_DAYS,
      last_refreshed: account.updated_at,
      auth_file: authFile,
      detail: payload?.error || `Session rejected by ${serverUrl} (HTTP 401) — the stored token was not accepted (expired, or dropped server-side). Run \`klauro login\` to sign in again.`,
    };
  }

  if (!response.ok) {
    return {
      state: 'unreachable',
      server_url: serverUrl,
      email: account.email,
      session_age_days: ageDays ?? undefined,
      ttl_days: SESSION_TOKEN_TTL_DAYS,
      last_refreshed: account.updated_at,
      auth_file: authFile,
      detail: `${serverUrl} responded with HTTP ${response.status} while verifying the session — not a clear accept or reject. Local token present${account.email ? ` for ${account.email}` : ''}, last refreshed ${account.updated_at}.`,
    };
  }

  const email = payload?.user?.email || account.email;
  return {
    state: 'signed-in',
    server_url: serverUrl,
    email,
    session_age_days: ageDays ?? undefined,
    days_remaining: daysRemaining ?? undefined,
    ttl_days: SESSION_TOKEN_TTL_DAYS,
    last_refreshed: account.updated_at,
    auth_file: authFile,
    detail: daysRemaining !== null
      ? `Signed in to ${serverUrl} as ${email}. Session has ${daysRemaining.toFixed(1)} of ${SESSION_TOKEN_TTL_DAYS} days remaining.`
      : `Signed in to ${serverUrl} as ${email}.`,
  };
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
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelaysMs?: number[];
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

  const serverUrl = normalizeServerUrl(input.serverUrl);
  const fetchImpl = input.fetchImpl || fetch;
  const timeoutMs = input.timeoutMs ?? 5000;
  const retryDelaysMs = input.retryDelaysMs ?? [100, 300];






  warnIfSessionExpiringSoon(serverUrl, loadStoredConnectorAuth().accounts[serverUrl]);
  const token = connectorToken(input.token, input.serverUrl);
  if (!token) {




    try {
      await fetchConnectorIdentity(fetchImpl, serverUrl, undefined, timeoutMs, retryDelaysMs);
    } catch (error) {
      if (isNetworkUnreachableError(error)) throw unreachableServerError(serverUrl, error);


    }
    throw new Error(`Klauro account required for ${serverUrl}. Run \`klauro login\` or set KLAURO_ACCOUNT_TOKEN before local indexing, sync, or MCP hosted context.`);
  }

  let response: Response;
  try {
    response = await fetchConnectorIdentity(fetchImpl, serverUrl, token, timeoutMs, retryDelaysMs);
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

async function fetchConnectorIdentity(
  fetchImpl: typeof fetch,
  serverUrl: string,
  token: string | undefined,
  timeoutMs: number,
  retryDelaysMs: number[],
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await fetchImpl(`${serverUrl}/api/me`, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = error;
      if (!isNetworkUnreachableError(error) || attempt === retryDelaysMs.length) throw error;
      await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt]));
    }
  }
  throw lastError;
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

  }
  return { version: 1, accounts: {} };
}

export function loadStoredConnectorToken(serverUrl?: string): string | undefined {
  const auth = loadStoredConnectorAuth();
  const normalized = normalizeServerUrl(serverUrl || auth.defaultServerUrl);
  return auth.accounts[normalized]?.token;
}



function persistAuth(auth: StoredConnectorAuth): string {
  const file = authConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {

  }
  return file;
}











export function saveStoredConnectorSession(input: {
  serverUrl?: string;
  token: string;
  email?: string;
}): { file: string; serverUrl: string } {
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const auth = loadStoredConnectorAuth();
  auth.defaultServerUrl = serverUrl;
  const account: StoredConnectorAccount = {
    token: input.token,
    email: input.email,
    updated_at: new Date().toISOString(),
  };
  auth.accounts[serverUrl] = account;
  if (input.email) {
    auth.accountsByServer = auth.accountsByServer || {};
    auth.accountsByServer[serverUrl] = auth.accountsByServer[serverUrl] || {};
    auth.accountsByServer[serverUrl][input.email] = account;
  }
  const file = persistAuth(auth);
  return { file, serverUrl };
}











export function clearStoredConnectorSession(serverUrl?: string): { file: string; removed: boolean; serverUrl: string; switched_to?: string } {
  const auth = loadStoredConnectorAuth();
  const normalized = normalizeServerUrl(serverUrl || auth.defaultServerUrl);
  const removed = Boolean(auth.accounts[normalized]);
  const removedEmail = auth.accounts[normalized]?.email;
  delete auth.accounts[normalized];
  if (removedEmail && auth.accountsByServer?.[normalized]) {
    delete auth.accountsByServer[normalized][removedEmail];
  }
  let switchedTo: string | undefined;
  const roster = auth.accountsByServer?.[normalized];
  if (roster && Object.keys(roster).length > 0) {
    const [nextEmail, nextAccount] = Object.entries(roster).sort(
      ([, a], [, b]) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
    )[0];
    auth.accounts[normalized] = nextAccount;
    switchedTo = nextEmail;
  }
  if (auth.defaultServerUrl === normalized && !auth.accounts[normalized]) {
    auth.defaultServerUrl = Object.keys(auth.accounts)[0];
  }
  const file = persistAuth(auth);
  return { file, removed, serverUrl: normalized, ...(switchedTo ? { switched_to: switchedTo } : {}) };
}









export function listStoredAccounts(serverUrl?: string): Array<{ email: string; updated_at: string; active: boolean }> {
  const auth = loadStoredConnectorAuth();
  const normalized = normalizeServerUrl(serverUrl || auth.defaultServerUrl);
  const activeEmail = auth.accounts[normalized]?.email;
  const roster = auth.accountsByServer?.[normalized];
  if (roster && Object.keys(roster).length > 0) {
    return Object.entries(roster)
      .map(([email, account]) => ({ email, updated_at: account.updated_at, active: email === activeEmail }))
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  }
  const active = auth.accounts[normalized];
  return active?.email ? [{ email: active.email, updated_at: active.updated_at, active: true }] : [];
}








export function tokenForStoredAccount(serverUrl: string | undefined, email: string): string | undefined {
  const auth = loadStoredConnectorAuth();
  const normalized = normalizeServerUrl(serverUrl || auth.defaultServerUrl);
  const rosterAccount = auth.accountsByServer?.[normalized]?.[email];
  if (rosterAccount) return rosterAccount.token;
  const active = auth.accounts[normalized];
  return active?.email === email ? active.token : undefined;
}

















export async function findStoredAccountOwningProject(
  serverUrl: string,
  projectId: string,
  activeEmail: string | undefined,
  probeImpl: (serverUrl: string, token: string, projectId: string) => Promise<'bound' | 'not_found' | 'indeterminate'>,
): Promise<string | undefined> {
  const candidates = listStoredAccounts(serverUrl).filter(account => account.email !== activeEmail);
  for (const candidate of candidates) {
    const token = tokenForStoredAccount(serverUrl, candidate.email);
    if (!token) continue;
    const probe = await probeImpl(serverUrl, token, projectId);
    if (probe === 'bound') return candidate.email;
  }
  return undefined;
}









export function switchStoredAccount(serverUrl: string | undefined, email: string): { file: string; serverUrl: string; email: string } {
  const auth = loadStoredConnectorAuth();
  const normalized = normalizeServerUrl(serverUrl || auth.defaultServerUrl);
  const roster = auth.accountsByServer?.[normalized];
  const account = roster?.[email];
  if (!account) {
    const known = roster ? Object.keys(roster) : [];
    throw new Error(
      known.length > 0
        ? `No stored session for ${email} on ${normalized}. Known accounts: ${known.join(', ')}. Run \`klauro login --email ${email}\` to add it.`
        : `No stored accounts for ${normalized} yet. Run \`klauro login --email ${email}\` first.`,
    );
  }
  auth.accounts[normalized] = account;
  auth.defaultServerUrl = normalized;
  const file = persistAuth(auth);
  return { file, serverUrl: normalized, email };
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
