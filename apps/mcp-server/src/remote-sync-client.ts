import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { saveAnalysis } from './storage';
import type { RemoteAnalyzeResponse, RemoteAnalyzerResponse, RemoteProjectRevisionsResponse } from './remote-analyzer-protocol';
import { buildBranchDiffContext, buildSourceSnapshot, buildWorkingTreeChangeContext } from './remote-source';
import { assertRemoteAnalyzerAllowed, loadKlauroConfig, resolveAnalysisId, resolveAnalyzerUrl } from './klauro-config';
import { connectorToken, requireConnectorEntitlement } from './connector-auth';
import { DEFAULT_KLAURO_CLOUD_URL } from './defaults';

export interface RemoteSyncOptions {
  projectPath: string;
  serverUrl?: string;
  token?: string;
  analysisId?: string;
  /** Wait for the full server-side analysis and return the CAS (legacy
   *  synchronous behavior). Default false: the push returns in seconds with
   *  status 'accepted' and the analysis runs entirely on the server. */
  wait?: boolean;
}

/** How the working-tree (in-flight) side of a dirty-tree analyze went. */
export interface InFlightSyncOutcome {
  status: 'completed' | 'skipped' | 'failed';
  changed_files?: number;
  detail?: string;
}

export interface AnalyzeRemotelyResult extends Omit<RemoteAnalyzeResponse, 'status' | 'cas' | 'analysis_revision' | 'analysis_type'> {
  /** 'accepted' = the default fast path: snapshot uploaded, analysis running
   *  entirely server-side (progressive disclosure). 'success' = legacy
   *  synchronous path (options.wait) carrying the full CAS. */
  status: 'success' | 'accepted';
  analysis_revision?: number;
  analysis_type?: 'full' | 'incremental';
  cas?: RemoteAnalyzeResponse['cas'];
  /** What the shared snapshot was built from (committed HEAD vs working tree).
   *  Optional so plain sync responses remain assignable for shared formatting. */
  snapshot_source?: 'committed-head' | 'working-tree';
  /** Present when the tree was dirty: outcome of the automatic in-flight pass. */
  in_flight?: InFlightSyncOutcome;
}

export async function analyzeCodebaseRemotely(options: RemoteSyncOptions): Promise<AnalyzeRemotelyResult> {
  const projectPath = path.resolve(options.projectPath);
  const loaded = await loadKlauroConfig(projectPath);
  const serverUrl = resolveAnalyzerUrl(loaded, options.serverUrl);
  assertRemoteAnalyzerAllowed(loaded, serverUrl);
  await requireConnectorEntitlement({ serverUrl, token: options.token });
  // On a dirty tree this reads the COMMITTED HEAD content from git objects (never
  // the dirty files, never touching the working tree); on a clean tree it walks
  // the working tree as before. See buildSourceSnapshot/buildHeadSourceSnapshot.
  const snapshot = await buildSourceSnapshot(projectPath);
  const analysisId = resolveAnalysisId(loaded, defaultAnalysisId(projectPath), options.analysisId);
  const response = await postRemote(options, '/v1/analyze', {
    project_id: analysisId,
    organization_id: loaded.config.project.organizationId,
    project_path: projectPath,
    snapshot,
    // Progressive disclosure by default: the server answers in seconds with
    // 'accepted' and runs the analysis entirely server-side. options.wait
    // restores the legacy synchronous response (used where the caller needs
    // the CAS inline).
    async: options.wait === true ? undefined : true,
  }, serverUrl) as AnalyzeRemotelyResult;
  if (response.cas) {
    await saveAnalysis(projectPath, stampAnalyzedCommit(rewriteCasProjectName(response as RemoteAnalyzeResponse, projectPath).cas, response.base_commit));
  }
  response.snapshot_source = snapshot.snapshot_source;

  if (snapshot.snapshot_source === 'committed-head' && response.status === 'accepted') {
    // Fast path: don't block the seconds-long accept on a synchronous
    // in-flight pass — the dirty-tree track is captured on demand
    // (get_in_flight_changes / remote-sync) whenever an agent asks for it.
    response.in_flight = { status: 'skipped', detail: 'captured on demand' };
  } else if (snapshot.snapshot_source === 'committed-head') {
    // The tree was dirty: the shared revision above is HEAD-only, so ALSO run the
    // in-flight (dirty working tree) pass for local agent context. Its failure
    // must never fail the shared analysis that already succeeded.
    try {
      const sync = await syncWorkingTreeRemotely(options);
      const summary = sync.change_report?.summary;
      response.in_flight = {
        status: 'completed',
        changed_files: summary
          ? summary.filesAdded + summary.filesModified + summary.filesDeleted
          : undefined,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      response.in_flight = {
        status: /allowDirtyTreeSync/.test(detail) ? 'skipped' : 'failed',
        detail,
      };
    }
  }
  return response;
}

/** Persist the analyzed commit SHA onto the stored CAS so the local cache is
 *  revision-identifiable (revision-accurate freshness; see revision.ts). */
function stampAnalyzedCommit<T>(cas: T, baseCommit: string | undefined): T {
  if (baseCommit && cas && typeof cas === 'object' && (cas as any).base_commit == null) {
    (cas as any).base_commit = baseCommit;
  }
  return cas;
}

export async function syncWorkingTreeRemotely(options: RemoteSyncOptions): Promise<RemoteAnalyzeResponse> {
  const projectPath = path.resolve(options.projectPath);
  const loaded = await loadKlauroConfig(projectPath);
  const serverUrl = resolveAnalyzerUrl(loaded, options.serverUrl);
  assertRemoteAnalyzerAllowed(loaded, serverUrl);
  await requireConnectorEntitlement({ serverUrl, token: options.token });
  const changes = await buildWorkingTreeChangeContext(projectPath);
  const analysisId = resolveAnalysisId(loaded, defaultAnalysisId(projectPath), options.analysisId);
  const response = await postRemote(options, '/v1/sync', {
    analysis_id: analysisId,
    project_id: analysisId,
    organization_id: loaded.config.project.organizationId,
    project_path: projectPath,
    changes,
  }, serverUrl);
  // The /v1/sync path analyzes the dirty working tree, so it must NOT overwrite
  // the committed 'main' analysis — persist it on the dedicated in-flight track.
  await saveAnalysis(projectPath, rewriteCasProjectName(response, projectPath).cas, 'in-flight');
  return response;
}

export interface RemoteBranchDiffOptions extends RemoteSyncOptions {
  targetBranch: string;
  baseBranch?: string;
}

/**
 * Analyze ONLY the files changed on a non-default branch (a light diff-only
 * payload), then persist the resulting CAS on the dedicated 'other-branch' track
 * so it never overwrites the committed 'main' analysis.
 */
export async function analyzeBranchDiffRemotely(options: RemoteBranchDiffOptions): Promise<RemoteAnalyzeResponse> {
  const projectPath = path.resolve(options.projectPath);
  const loaded = await loadKlauroConfig(projectPath);
  const serverUrl = resolveAnalyzerUrl(loaded, options.serverUrl);
  assertRemoteAnalyzerAllowed(loaded, serverUrl);
  await requireConnectorEntitlement({ serverUrl, token: options.token });
  const diffContext = await buildBranchDiffContext(projectPath, options.targetBranch, options.baseBranch);
  const analysisId = resolveAnalysisId(loaded, defaultAnalysisId(projectPath), options.analysisId);
  const response = await postRemote(options, '/v1/analyze-diff', {
    project_id: analysisId,
    organization_id: loaded.config.project.organizationId,
    project_path: projectPath,
    diff_context: diffContext,
  }, serverUrl);
  await saveAnalysis(projectPath, rewriteCasProjectName(response, projectPath).cas, 'other-branch');
  return response;
}

export async function fetchRemoteProjectRevisions(options: RemoteSyncOptions): Promise<RemoteProjectRevisionsResponse> {
  const projectPath = path.resolve(options.projectPath);
  const loaded = await loadKlauroConfig(projectPath);
  const serverUrl = resolveAnalyzerUrl(loaded, options.serverUrl);
  assertRemoteAnalyzerAllowed(loaded, serverUrl);
  await requireConnectorEntitlement({ serverUrl, token: options.token });
  const analysisId = resolveAnalysisId(loaded, defaultAnalysisId(projectPath), options.analysisId);
  const headers: Record<string, string> = {};
  const token = connectorToken(options.token, serverUrl);
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${serverUrl}/v1/projects/${encodeURIComponent(analysisId)}/revisions`, { headers });
  const payload = await response.json().catch(() => ({})) as RemoteProjectRevisionsResponse | { status: 'error'; error: string };
  if (!response.ok || payload.status === 'error') {
    throw new Error(payload.status === 'error' ? payload.error : `Remote analyzer returned ${response.status}`);
  }
  return payload;
}

export function defaultAnalysisId(projectPath: string): string {
  return crypto.createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 24);
}

/** Default per-request timeout for uploads to the remote analyzer (ms).
 *  Analyze payloads can be large; this must comfortably exceed normal
 *  processing time while still turning a true hang into a retriable error
 *  instead of hanging the CLI forever. Overridable via
 *  KLAURO_REMOTE_REQUEST_TIMEOUT_MS (primarily for tests that need to
 *  exercise the timeout path without waiting the full production timeout). */
function remoteRequestTimeoutMs(): number {
  const override = Number(process.env.KLAURO_REMOTE_REQUEST_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : 120_000;
}

/** Retry schedule for transient failures talking to the remote analyzer
 *  (short exponential backoff): attempt 1 immediate, then wait ~1s, ~3s, ~9s
 *  before attempts 2-4. Total = 4 attempts. */
const REMOTE_RETRY_DELAYS_MS = [1_000, 3_000, 9_000];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Thrown when the remote analyzer's edge (e.g. Cloudflare) or the server
 *  itself misbehaves in a way that is worth retrying. Distinguishing this
 *  from a plain Error lets postRemote's retry loop tell "worth another try"
 *  apart from a definitive application-level failure (e.g. a 4xx from the
 *  analyzer itself, which retrying will not fix). */
class RetriableRemoteError extends Error {}

/** True for network-level failures (DNS, connection reset, TLS) that Node's
 *  fetch/undici surfaces as a rejected promise rather than a response. */
function isRetriableNetworkError(error: unknown): boolean {
  if (error instanceof RetriableRemoteError) return true;
  if (!(error instanceof Error)) return false;
  // AbortError comes from our own timeout (see withTimeout below) and is
  // always worth a retry: it means we gave up waiting, not that the server
  // definitively rejected the request.
  if (error.name === 'AbortError') return true;
  const cause = (error as { cause?: unknown }).cause;
  const causeCode = cause && typeof cause === 'object' ? (cause as { code?: string }).code : undefined;
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(causeCode || '')) {
    return true;
  }
  // undici's generic network-failure envelope: `TypeError: fetch failed` with
  // no more specific `cause.code` populated. Still a transient condition
  // (DNS hiccup, connection refused, TLS reset) worth retrying rather than
  // failing the whole upload on the first blip.
  return error.message === 'fetch failed';
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a remote analyzer response robustly: check content-type BEFORE
 *  attempting JSON.parse. A Cloudflare edge that intercepts the request
 *  (challenge page, 5xx error page, rate-limit page) returns
 *  `text/html` — JSON.parse-ing that produces an opaque
 *  `Unexpected token '<'` SyntaxError with no indication of what actually
 *  happened. Detect that case and raise an honest, retriable error instead. */
async function parseRemoteResponse(response: Response, endpoint: string): Promise<RemoteAnalyzerResponse> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const bodyText = await response.text().catch(() => '');
    const snippet = bodyText.slice(0, 200).replace(/\s+/g, ' ').trim();
    const isCloudflare = /cloudflare/i.test(bodyText) || /cloudflare/i.test(response.headers.get('server') || '');
    const edgeLabel = isCloudflare ? "The Klauro server's edge (Cloudflare)" : 'The Klauro server';
    throw new RetriableRemoteError(
      `${edgeLabel} returned a non-JSON response for ${endpoint} (HTTP ${response.status}, content-type "${contentType || 'none'}")` +
      (snippet ? `: ${snippet}` : '')
    );
  }
  try {
    return await response.json() as RemoteAnalyzerResponse;
  } catch (error) {
    // Content-type claimed JSON but the body didn't parse — treat as a
    // retriable edge glitch (e.g. truncated response) rather than crashing
    // with a raw SyntaxError.
    const detail = error instanceof Error ? error.message : String(error);
    throw new RetriableRemoteError(`The Klauro server returned malformed JSON for ${endpoint}: ${detail}`);
  }
}

async function postRemote(
  options: RemoteSyncOptions,
  endpoint: string,
  body: unknown,
  resolvedServerUrl?: string,
  timeoutMs: number = remoteRequestTimeoutMs(),
): Promise<RemoteAnalyzeResponse> {
  const serverUrl = (resolvedServerUrl || options.serverUrl || process.env.KLAURO_ANALYZER_URL || DEFAULT_KLAURO_CLOUD_URL).replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = connectorToken(options.token, serverUrl);
  if (token) headers.authorization = `Bearer ${token}`;
  const payloadBytes = Buffer.from(JSON.stringify(body), 'utf8');
  const requestBody = payloadBytes.length > 1024 ? gzipSync(payloadBytes) : payloadBytes;
  if (requestBody !== payloadBytes) {
    headers['content-encoding'] = 'gzip';
    headers['x-klauro-wire-format'] = 'json+gzip';
    headers['x-klauro-uncompressed-bytes'] = String(payloadBytes.length);
  } else {
    headers['x-klauro-wire-format'] = 'json';
  }

  const url = `${serverUrl}${endpoint}`;
  const maxAttempts = REMOTE_RETRY_DELAYS_MS.length + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchWithTimeout(url, { method: 'POST', headers, body: requestBody }, timeoutMs);
      // 5xx is always worth retrying (transient edge/origin failure); 4xx is
      // a definitive application-level rejection retrying will not fix.
      if (response.status >= 500) {
        const bodyText = await response.text().catch(() => '');
        const snippet = bodyText.slice(0, 200).replace(/\s+/g, ' ').trim();
        throw new RetriableRemoteError(
          `The Klauro server's edge returned HTTP ${response.status} for ${endpoint}` + (snippet ? `: ${snippet}` : '')
        );
      }
      const payload = await parseRemoteResponse(response, endpoint);
      if (!response.ok || payload.status === 'error') {
        // A well-formed JSON error from the application itself — not an edge
        // glitch, so do not retry.
        throw new Error(payload.status === 'error' ? payload.error : `Remote analyzer returned ${response.status}`);
      }
      return payload as RemoteAnalyzeResponse;
    } catch (error) {
      lastError = error;
      const retriable = isRetriableNetworkError(error);
      const isLastAttempt = attempt === maxAttempts;
      if (!retriable || isLastAttempt) {
        if (retriable) {
          // Exhausted retries on a transient condition: surface an honest
          // message naming the edge rather than the raw underlying error.
          const detail = error instanceof Error ? error.message : String(error);
          const timedOut = error instanceof Error && error.name === 'AbortError';
          const summary = timedOut
            ? `The Klauro server did not respond within ${Math.round(timeoutMs / 1000)}s for ${endpoint}`
            : detail;
          throw new Error(`${summary} (retried ${maxAttempts} times)`);
        }
        throw error;
      }
      await sleep(REMOTE_RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  // Unreachable, but keeps TypeScript satisfied.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function rewriteCasProjectName(response: RemoteAnalyzeResponse, projectPath: string): RemoteAnalyzeResponse {
  response.cas.system.name = path.basename(projectPath);
  return response;
}
