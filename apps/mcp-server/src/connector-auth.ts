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

/**
 * Multi-account storage (task #127's third defect). `accounts[serverUrl]`
 * remains the single ACTIVE account per server — every existing read site
 * (`connectorToken`, `resolveAuthStatus`, `klauro status`, `klauro init`,
 * etc.) keeps working unchanged, because "the active account" is exactly
 * what those call sites always meant by "the" account.
 *
 * What changes: `klauro login` for a SECOND email on the same server no
 * longer overwrites and loses the first one. Every account ever signed into
 * on a given server is additionally kept in `accountsByServer[serverUrl]`,
 * keyed by email, so `klauro accounts` can list them and `klauro accounts
 * use <email>` can flip the active pointer back WITHOUT re-authenticating.
 * `accountsByServer` is optional so a pre-existing v1 auth.json (single
 * account, no roster) loads and behaves exactly as before until the next
 * login populates the roster.
 */
export interface StoredConnectorAuth {
  version: 1;
  defaultServerUrl?: string;
  accounts: Record<string, StoredConnectorAccount>;
  accountsByServer?: Record<string, Record<string, StoredConnectorAccount>>;
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
  // The condition is rarely one `cause` deep — undici nests, and an
  // AggregateError from address selection hides its real errors elsewhere
  // again — so this reads the whole chain rather than a single level, and
  // names a command instead of leaving the reader to guess a next step.
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

/**
 * Server session TTL, days. Must track remote-analyzer-service.ts's 401
 * remediation text ("session TTL is 14 days") — duplicated here (and again in
 * client-doctor.ts) rather than imported from the server module, because that
 * module is server-only and is never bundled into the installed client
 * (build-bundle.mjs's forbidden list). installed-cli-ops-commands.test.ts
 * asserts the literal string "14 days" appears in the 401 remediation, so the
 * copies can't quietly drift apart unnoticed.
 */
export const SESSION_TOKEN_TTL_DAYS = 14;

/** Warn this many days before the TTL, so a session that is about to strand a
 *  command is flagged BEFORE the request that needs it 401s — not after. */
export const TOKEN_EXPIRY_WARN_DAYS = 11;

export interface SessionAge {
  ageDays: number | null;
  daysRemaining: number | null;
}

/** Local, offline, synchronous — no network round trip. */
export function describeSessionAge(updatedAt: string | undefined, now: Date = new Date()): SessionAge {
  if (!updatedAt) return { ageDays: null, daysRemaining: null };
  const parsed = new Date(updatedAt);
  if (Number.isNaN(parsed.getTime())) return { ageDays: null, daysRemaining: null };
  const ageDays = (now.getTime() - parsed.getTime()) / (24 * 60 * 60 * 1000);
  return { ageDays, daysRemaining: SESSION_TOKEN_TTL_DAYS - ageDays };
}

// At most one expiry warning per process: a single command can resolve
// entitlement more than once (e.g. `analyze` on a dirty tree runs a shared
// pass and an in-flight pass), and repeating the warning would just be noise.
let warnedThisProcess = false;

/** Test-only: reset the once-per-process warning latch between test cases. */
export function resetSessionWarningStateForTests(): void {
  warnedThisProcess = false;
}

/**
 * Local pre-flight for commands that are about to need the stored token:
 * if the session is close to (or past) the server's TTL, warn on stderr
 * BEFORE the request that needs it runs — instead of the first signal being
 * an opaque mid-command 401. Advisory only: never throws, never blocks, and
 * does not replace the real 401 the server will still send if the guess is
 * wrong either way (clock skew, a session the server dropped early, etc).
 */
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

/**
 * The REAL answer to "am I signed in", for `auth-status` / `whoami`. Unlike a
 * check of whether ~/.klauro/auth.json contains a token (which says nothing
 * about whether the server still honors it), this round-trips to GET
 * /api/me with the stored token and reports one of four states:
 *  - no-token:    nothing stored for this server.
 *  - signed-in:   the server accepted the token; includes days remaining.
 *  - rejected:    a token IS stored but the server 401'd it (expired or
 *                 server-side dropped) — the exact "signed_in: true but every
 *                 call 401s" lie this function exists to stop reporting.
 *  - unreachable: the server could not be reached (or errored oddly) to
 *                 verify; reports the local token's presence/age instead of
 *                 guessing, and never hangs — the request is time-boxed.
 */
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
  // Local, offline, synchronous: warn before the network round trip below if
  // the stored session is already close to (or past) the server's TTL — see
  // warnIfSessionExpiringSoon's doc comment. This is the single place that
  // gates every command needing the token (login/index/analyze/remote-sync),
  // so hooking the warning here surfaces it everywhere those commands run,
  // not just in `klauro doctor`.
  warnIfSessionExpiringSoon(serverUrl, loadStoredConnectorAuth().accounts[serverUrl]);
  const token = connectorToken(input.token, input.serverUrl);
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
      // Bounded so an unreachable/hung server produces the clear
      // unreachable-server error below instead of hanging the command
      // indefinitely — this endpoint gates login/index/analyze/remote-sync.
      signal: AbortSignal.timeout(8000),
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

/** Shared tail of every auth.json mutator: write, then best-effort chmod
 *  0600 (the file holds bearer tokens for every signed-in account). */
function persistAuth(auth: StoredConnectorAuth): string {
  const file = authConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on platforms/filesystems that do not support chmod.
  }
  return file;
}

/**
 * Signs an account in as the ACTIVE account for `serverUrl`, and — the fix
 * for task #127's "`klauro login` is a session clobberer" — records it in
 * that server's account roster WITHOUT touching any other email's entry.
 * Before this, `auth.accounts[serverUrl] = {...}` unconditionally overwrote
 * whatever account was previously active, so a second `klauro login` for a
 * work/personal split (or an agent signing in as a beta-test account) always
 * silently evicted the first session with no warning and no way back short
 * of logging in again with the original password.
 */
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

/**
 * Signs out the currently-ACTIVE account for `serverUrl` (unchanged
 * behavior/signature — logout has always meant "sign out the account I'm
 * using", not "sign out everyone"). Removes it from the roster too so
 * `klauro accounts` does not keep listing a token that was just revoked
 * client-side. Other accounts in the roster for this server are untouched;
 * if any remain, the most-recently-used one becomes the new active account
 * automatically (still logged in beats silently logged out when the roster
 * is non-empty) — otherwise the server has no active account, same as today.
 */
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

/**
 * Every account ever signed into `serverUrl` (the roster
 * `saveStoredConnectorSession` builds up), each flagged with whether it is
 * the current active account. Falls back to a single-entry list built from
 * `accounts[serverUrl]` for auth.json files written before the roster
 * existed, so `klauro accounts` never reports "no accounts" for a session
 * that plainly works.
 */
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

/**
 * Flips the ACTIVE account for `serverUrl` to `email`, reusing the already-
 * stored token — no re-authentication, no password. This is the "way to
 * see/switch which account is active" task #127 asked for: e.g. an agent
 * that discovers it is signed in as the wrong account for a bound project
 * can switch back without anyone re-typing a password (`klauro login`
 * remains the only way to ADD a new account to the roster).
 */
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
