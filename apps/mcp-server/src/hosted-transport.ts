import { Agent, fetch as undiciFetch } from 'undici';
import { findStoredAccountOwningProject, listStoredAccounts } from './connector-auth';
import { probeHostedProjectBinding } from './klauro-config';








































let hostedDispatcher: Agent | undefined;
let hostedUploadDispatcher: Agent | undefined;
let hostedArtifactDispatcher: Agent | undefined;

export function getHostedDispatcher(): Agent {
  if (!hostedDispatcher) hostedDispatcher = new Agent({ allowH2: true });
  return hostedDispatcher;
}

export function getHostedUploadDispatcher(): Agent {
  if (!hostedUploadDispatcher) hostedUploadDispatcher = new Agent({ allowH2: false, pipelining: 1 });
  return hostedUploadDispatcher;
}

export function getHostedArtifactDispatcher(): Agent {
  if (!hostedArtifactDispatcher) hostedArtifactDispatcher = new Agent({ allowH2: false, pipelining: 1 });
  return hostedArtifactDispatcher;
}







export function resetHostedDispatcher(): void {
  const stale = hostedDispatcher;
  hostedDispatcher = undefined;
  if (stale) stale.destroy().catch(() => {});
}

export function resetHostedUploadDispatcher(): void {
  const stale = hostedUploadDispatcher;
  hostedUploadDispatcher = undefined;
  if (stale) stale.destroy().catch(() => {});
}

export function resetHostedArtifactDispatcher(): void {
  const stale = hostedArtifactDispatcher;
  hostedArtifactDispatcher = undefined;
  if (stale) stale.destroy().catch(() => {});
}







const DEAD_CONNECTION_CODES = new Set([
  'ERR_HTTP2_INVALID_SESSION', 'ERR_HTTP2_GOAWAY_SESSION', 'ERR_HTTP2_SESSION_ERROR',
  'ERR_HTTP2_STREAM_ERROR', 'ERR_HTTP2_STREAM_CANCEL', 'ECONNRESET', 'UND_ERR_SOCKET',
]);





export function isDeadConnectionError(error: unknown): boolean {
  const code = findErrorCode(error);
  if (code && DEAD_CONNECTION_CODES.has(code)) return true;
  const text = unwrapCauseChain(error).join(' ');
  return /session has been destroyed|session is closed|other side closed|socket hang up/i.test(text);
}




function hostedRequestTimeoutMs(): number {
  const override = Number(process.env.KLAURO_HOSTED_REQUEST_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : 60_000;
}




function hostedRetryDelaysMs(): number[] {
  const override = Number(process.env.KLAURO_HOSTED_RETRY_DELAY_MS);
  if (Number.isFinite(override) && override >= 0) return [override, override, override];
  return [400, 1_200, 3_600];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}



export class HostedTransportError extends Error {
  readonly url: string;
  readonly attempts: number;
  readonly causeChain: string[];
  readonly code?: string;

  constructor(message: string, details: { url: string; attempts: number; causeChain: string[]; code?: string }) {
    super(message);
    this.name = 'HostedTransportError';
    this.url = details.url;
    this.attempts = details.attempts;
    this.causeChain = details.causeChain;
    this.code = details.code;
  }
}









export function unwrapCauseChain(error: unknown, maxDepth = 8): string[] {
  const frames: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < maxDepth && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    frames.push(describeErrorFrame(current));



    const aggregated = (current as { errors?: unknown[] }).errors;
    if (Array.isArray(aggregated) && aggregated.length > 0) {
      for (const nested of aggregated.slice(0, 3)) frames.push(describeErrorFrame(nested));
    }
    current = (current as { cause?: unknown }).cause;
  }
  return frames.filter((frame, index) => frame && frames.indexOf(frame) === index);
}

function describeErrorFrame(value: unknown): string {
  if (value instanceof Error) {
    const code = (value as { code?: string }).code;
    const base = value.message || value.name;
    return code && !base.includes(code) ? `${base} (${code})` : base;
  }
  if (value && typeof value === 'object') {
    const record = value as { message?: string; code?: string };
    if (record.message || record.code) return [record.message, record.code].filter(Boolean).join(' ');
  }
  return String(value);
}




export function findErrorCode(error: unknown, maxDepth = 8): string | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < maxDepth && current; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const code = (current as { code?: string }).code;
    if (typeof code === 'string' && code) return code;
    const aggregated = (current as { errors?: unknown[] }).errors;
    if (Array.isArray(aggregated)) {
      for (const nested of aggregated) {
        const nestedCode = (nested as { code?: string })?.code;
        if (typeof nestedCode === 'string' && nestedCode) return nestedCode;
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const RETRIABLE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_STREAM_PREMATURE_CLOSE',



  ...DEAD_CONNECTION_CODES,
]);






export function isRetriableTransportError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;





  if (isDeadConnectionError(error)) return true;
  const code = findErrorCode(error);
  if (code && RETRIABLE_CODES.has(code)) return true;
  if (code) return false;
  const text = unwrapCauseChain(error).join(' ');
  if (/bad record mac|decryption failed|record layer failure/i.test(text)) return true;


  return error instanceof Error && error.message === 'fetch failed';
}

function remediationFor(code: string | undefined, chainText: string, url: string): string {
  const origin = safeOrigin(url);
  if (code === 'ECONNREFUSED') {
    return `Nothing is listening at ${origin}. Check the analyzer serverUrl in this repo's .klaurorc (or the KLAURO_ANALYZER_URL environment variable) — a stale localhost or development URL there points the client away from the hosted server — then run \`klauro doctor\`.`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `${origin} did not resolve. Check network/DNS connectivity and the analyzer serverUrl in this repo's .klaurorc, then run \`klauro doctor\`.`;
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    return `${origin} accepted no connection before the timeout. Check network connectivity (a proxy or VPN can block it) and run \`klauro doctor\`.`;
  }
  if (code === 'AbortError' || /aborted|timed out after/i.test(chainText)) {
    return `${origin} did not answer within the request timeout. Retry; if it persists, run \`klauro doctor\` and raise KLAURO_HOSTED_REQUEST_TIMEOUT_MS.`;
  }
  if (code?.startsWith('ERR_TLS') || code?.startsWith('ERR_SSL') || /certificate|bad record mac|tls/i.test(chainText)) {
    return `The TLS session to ${origin} failed. This is usually a proxy, a TLS-inspecting middlebox, or a corrupted record on the network path rather than a server fault. Retry, then run \`klauro doctor\`.`;
  }
  if ((code && DEAD_CONNECTION_CODES.has(code)) || /session has been destroyed|session is closed|other side closed|socket hang up/i.test(chainText)) {
    return `A previously-open connection to ${origin} was reset — commonly a server-side deploy or restart tearing down live connections — and a fresh connection was already retried. If this still fails after the retry, ${origin} may genuinely be down: run \`klauro doctor\` to check, and if it reports the server reachable, report this as a bug rather than assuming an outage.`;
  }
  return `Could not complete the request to ${origin}. Run \`klauro doctor\` to check connectivity, the configured server URL, and credentials.`;
}

function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}


export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|key|secret|password|authorization/i.test(key)) parsed.searchParams.set(key, 'REDACTED');
    }
    return parsed.toString();
  } catch {
    return url;
  }
}





export function describeTransportFailure(error: unknown, context: { url: string; operation: string; attempts: number }): string {
  const chain = unwrapCauseChain(error);
  const code = findErrorCode(error);
  const chainText = chain.join(' <- ');
  const attemptNote = context.attempts > 1 ? ` after ${context.attempts} attempts` : '';





  const headline = isDeadConnectionError(error)
    ? `Klauro's connection to the hosted server was reset for ${context.operation}${attemptNote}`
    : `Klauro could not reach the hosted server for ${context.operation}${attemptNote}`;
  return `${headline}. ` +
    `Target: ${redactUrl(context.url)}. ` +
    `Underlying error: ${chainText || String(error)}${code && !chainText.includes(code) ? ` (${code})` : ''}. ` +
    remediationFor(code, chainText, context.url);
}















async function describeProjectNotFoundRemediation(url: string): Promise<string> {
  const base = "The hosted project was not found for the currently signed-in account. The server returns this same 404 whether the project id in this repo's .klaurorc no longer exists OR it exists but belongs to a workspace this account is not a member of.";
  const match = /^(https?:\/\/[^/]+)\/api\/projects\/([^/]+)/.exec(url);
  if (!match) {
    return `${base} Run \`klauro status\` to see the bound project id, \`klauro accounts\` to see who is signed in here, and \`klauro init --force\` to bind a fresh project the active account can see (this starts a separate analysis; it does not touch the existing one).`;
  }
  const [, serverUrl, encodedProjectId] = match;
  const projectId = decodeURIComponent(encodedProjectId);
  try {
    const activeEmail = listStoredAccounts(serverUrl).find(account => account.active)?.email;
    const owner = await findStoredAccountOwningProject(serverUrl, projectId, activeEmail, probeHostedProjectBinding);
    if (owner) {
      return `${base} It belongs to ${owner}, an account already signed in on this machine but not the active one. Run \`klauro accounts --use ${owner}\` to switch (no password needed), then retry. Do not run \`klauro login\` — it would replace the active account's session instead of switching to one already stored here.`;
    }
  } catch {



  }
  return `${base} Run \`klauro accounts\` to see who is signed in here; if the owning account has never signed in on this machine, ask them to add your account to its workspace, or run \`klauro init --force\` to bind a NEW project (${projectId}'s existing analysis is untouched). Do not run \`klauro login\` to try to "become" the owning account unless you actually intend to replace the currently active session.`;
}







export async function describeHttpFailure(response: Response, context: { url: string; operation: string }): Promise<string> {
  const contentType = response.headers.get('content-type') || '';
  let serverMessage = '';
  let snippet = '';
  const bodyText = await response.text().catch(() => '');
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(bodyText) as { error?: unknown; message?: unknown };
      serverMessage = String(parsed?.error || parsed?.message || '');
    } catch {   }
  }
  if (!serverMessage) snippet = bodyText.slice(0, 300).replace(/\s+/g, ' ').trim();

  const target = redactUrl(context.url);
  const detail = serverMessage || snippet || `content-type "${contentType || 'none'}"`;
  const status = response.status;
  let remediation: string;
  if (status === 401 || status === 403) {
    remediation = 'The request was not authorized. Run `klauro auth-status`; if it reports no account, run `klauro login`, then restart the MCP client.';
  } else if (status === 404) {
    remediation = await describeProjectNotFoundRemediation(context.url);
  } else if (status === 426) {
    remediation = 'This client is older than the protocol the server requires. Run `klauro update`, then restart the MCP client.';
  } else if (status === 429) {
    remediation = 'The server is rate limiting this client. Wait and retry.';
  } else if (status >= 500) {
    remediation = 'The hosted server failed to serve the request. Retry; if it persists, run `klauro support-bundle` and report it.';
  } else if (!contentType.includes('application/json')) {
    remediation = "The response was not JSON, which usually means an edge or proxy answered instead of the server. Retry, then run `klauro doctor`.";
  } else {
    remediation = 'Run `klauro doctor` to check the configured server URL and credentials.';
  }
  return `Klauro's hosted server returned HTTP ${status} for ${context.operation}. Target: ${target}. Detail: ${detail}. ${remediation}`;
}







export async function hostedFetch(
  url: string | URL,
  init: RequestInit,
  context: { operation: string },
): Promise<Response> {
  const target = url.toString();
  const delays = hostedRetryDelaysMs();
  const timeoutMs = hostedRequestTimeoutMs();
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {



      return await undiciFetch(target, { ...init, signal: controller.signal, dispatcher: getHostedDispatcher() } as any) as unknown as Response;
    } catch (error) {
      lastError = error;
      if (!isRetriableTransportError(error) || attempt === delays.length) break;



      if (isDeadConnectionError(error)) resetHostedDispatcher();
      await sleep(delays[attempt]);
    } finally {
      clearTimeout(timer);
    }
  }

  const attempts = isRetriableTransportError(lastError) ? delays.length + 1 : 1;
  throw new HostedTransportError(
    describeTransportFailure(lastError, { url: target, operation: context.operation, attempts }),
    { url: redactUrl(target), attempts, causeChain: unwrapCauseChain(lastError), code: findErrorCode(lastError) },
  );
}
