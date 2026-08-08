/**
 * Transport for the installed MCP client's hosted read/query calls.
 *
 * Every hosted MCP tool funnels through one of two callers in
 * installed-client-server.ts, so whatever those two do on a transport failure
 * IS the product's failure behaviour for the entire tool surface. Bare
 * `fetch()` there means a single transient network condition presents to the
 * agent as the two-word string `fetch failed`: no URL, no cause, no
 * remediation, and no retry — an agent that receives it has no next step.
 *
 * Two constraints therefore hold here:
 *
 *  1. A transport error MUST be retried before it is reported. Node's fetch
 *     rejects identically for a permanent misconfiguration and a one-off reset
 *     or TLS record failure, and the upload path already treats that class as
 *     retriable; the read path must not be the only surface where a blip is
 *     terminal.
 *  2. A reported error MUST carry the unwrapped `cause` chain, the target URL,
 *     and a remediation naming a command the shipped CLI implements. Node wraps
 *     every network-level failure in an opaque `TypeError: fetch failed` whose
 *     real content lives in `error.cause` (recursively) — reporting the wrapper
 *     alone discards the entire diagnosis.
 */

/** Per-request timeout. Hosted reads are slices, not uploads, so this is far
 *  below the upload timeout: past this point a hang is more useful reported
 *  than waited on. */
function hostedRequestTimeoutMs(): number {
  const override = Number(process.env.KLAURO_HOSTED_REQUEST_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : 60_000;
}

/** Backoff before attempts 2-4. Kept short: a hosted read is on an agent's
 *  critical path, so the ladder must outlast a restart blip without turning a
 *  hard-down server into a minute of silence. */
function hostedRetryDelaysMs(): number[] {
  const override = Number(process.env.KLAURO_HOSTED_RETRY_DELAY_MS);
  if (Number.isFinite(override) && override >= 0) return [override, override, override];
  return [400, 1_200, 3_600];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Carries the diagnosis so callers can re-report it verbatim rather than
 *  re-deriving it from a message string. */
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

/**
 * Flatten an error and every nested `cause` into readable frames.
 *
 * The frame that names the actual condition is usually two or three levels
 * down (`TypeError: fetch failed` -> `AggregateError` -> `Error: connect
 * ECONNREFUSED 127.0.0.1:443`), and each level may carry its own `code`, so
 * every level is emitted rather than only the innermost.
 */
export function unwrapCauseChain(error: unknown, maxDepth = 8): string[] {
  const frames: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < maxDepth && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    frames.push(describeErrorFrame(current));
    // AggregateError (what Happy Eyeballs produces when every candidate
    // address fails) hides the real per-address errors in `errors`, not in
    // `cause`; without this branch the chain dead-ends at the aggregate.
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

/** First error code found anywhere in the chain. Remediation is chosen from
 *  this, so it reads the whole chain rather than only the outermost frame
 *  (which for `fetch failed` never carries one). */
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
]);

/** True for conditions that another attempt can plausibly clear: transport
 *  faults, our own timeout, and TLS record-level corruption (a damaged record
 *  on one connection says nothing about the next one). A wrong hostname,
 *  a rejected certificate, or an application-level status is NOT retried —
 *  retrying those only delays an honest report. */
export function isRetriableTransportError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  const code = findErrorCode(error);
  if (code && RETRIABLE_CODES.has(code)) return true;
  if (code) return false;
  const text = unwrapCauseChain(error).join(' ');
  if (/bad record mac|decryption failed|record layer failure/i.test(text)) return true;
  // undici's generic envelope with nothing more specific attached: still a
  // transport fault, still worth one more attempt.
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
  return `Could not complete the request to ${origin}. Run \`klauro doctor\` to check connectivity, the configured server URL, and credentials.`;
}

function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

/** Strip credentials before a URL is put in an error an agent will echo. */
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

/**
 * Build the message an agent actually receives. It must answer three
 * questions on its own: what failed, where, and what to do next.
 */
export function describeTransportFailure(error: unknown, context: { url: string; operation: string; attempts: number }): string {
  const chain = unwrapCauseChain(error);
  const code = findErrorCode(error);
  const chainText = chain.join(' <- ');
  const attemptNote = context.attempts > 1 ? ` after ${context.attempts} attempts` : '';
  return `Klauro could not reach the hosted server for ${context.operation}${attemptNote}. ` +
    `Target: ${redactUrl(context.url)}. ` +
    `Underlying error: ${chainText || String(error)}${code && !chainText.includes(code) ? ` (${code})` : ''}. ` +
    remediationFor(code, chainText, context.url);
}

/**
 * Turn a non-OK hosted response into an error that names the status, the URL,
 * and what to do — never a bare status number. Reads the body defensively:
 * an edge that intercepts the request returns HTML, and JSON.parse-ing that
 * yields a syntax error unrelated to the real failure.
 */
export async function describeHttpFailure(response: Response, context: { url: string; operation: string }): Promise<string> {
  const contentType = response.headers.get('content-type') || '';
  let serverMessage = '';
  let snippet = '';
  const bodyText = await response.text().catch(() => '');
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(bodyText) as { error?: unknown; message?: unknown };
      serverMessage = String(parsed?.error || parsed?.message || '');
    } catch { /* fall through to the raw snippet below */ }
  }
  if (!serverMessage) snippet = bodyText.slice(0, 300).replace(/\s+/g, ' ').trim();

  const target = redactUrl(context.url);
  const detail = serverMessage || snippet || `content-type "${contentType || 'none'}"`;
  const status = response.status;
  let remediation: string;
  if (status === 401 || status === 403) {
    remediation = 'The request was not authorized. Run `klauro auth-status`; if it reports no account, run `klauro login`, then restart the MCP client.';
  } else if (status === 404) {
    remediation = "The hosted project was not found for the currently signed-in account. The server returns this same 404 whether the project id in this repo's .klaurorc no longer exists OR it exists but belongs to a workspace this account is not a member of (it deliberately does not distinguish the two, to avoid leaking a private project's existence). Run `klauro status` to see the bound project id, and `klauro whoami` to confirm which account is signed in; if it's the wrong account, run `klauro login` for the one that owns this project, otherwise run `klauro init --force` to bind a fresh project this account can see.";
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

/**
 * `fetch` with a timeout, a bounded retry ladder, and a terminal error that
 * carries the unwrapped cause. Resolves with the Response for ANY completed
 * exchange — status interpretation belongs to the caller, which knows whether
 * a given status is an error for that endpoint.
 */
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
      return await fetch(target, { ...init, signal: controller.signal });
    } catch (error) {
      lastError = error;
      if (!isRetriableTransportError(error) || attempt === delays.length) break;
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
