import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'fs-extra';
import { createReadStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { analyzeProjectIncremental, analyzeProjectDeferred, checkDoomedVersionRebuild, runAnalysis, runLayeredAnalysis } from './analyzer';
import { REMOTE_ANALYSIS_PROTOCOL_VERSION, clientUpgradeRequiredMessage, type AccountActivityEvent, type RemoteAnalyzeDiffRequest, type RemoteAnalyzeRequest, type RemoteAnalyzeResponse, type RemoteGreenfieldPreviewRequest, type RemoteProjectRevision, type RemoteProjectRevisionsResponse, type RemoteProposalPreviewRequest, type RemoteSyncRequest } from './remote-analyzer-protocol';
import type { BranchDiffContext, RemoteFileChange, RepoFacts, SourceManifest } from './remote-source';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildSourceSnapshot } from './remote-source';
import { previewCodebaseIteration, previewGreenfieldCodebase } from './proposal-preview';
import { isDirectCliInvocation } from './cli-invocation';
import { AccountHttpError, AccountStore, type AccountProject } from './account-store';
import { AccountWorkspaceAnalysisScheduler } from './account-workspace-analysis';
import { getGrants, heartbeatGrant, releaseGrant, requestGrant, type AgentKind, type DeclaredContract } from './coordination';
import { appendClaim, checkEditLock, describeCursorGap, getActiveClaims, getBoardInfo, getPresence, getStoreDir, readClaimLog, releaseAgentWithReason, releaseClaimById, warnIfEphemeralCoordDir, type ClaimLogEntry } from './coordination/local-store';
import { deriveActiveClaims } from './coordination/presence';
import { appendSecurityAudit, assertSameTenant, defaultSecretDenyPatterns, getSecurityStoreDir, redactInFlightChanges, TenantMismatchError } from './coordination/security';
import { detectConceptualConflicts, type AgentInFlightState, type ConceptualConflict, type ConflictCas, type SymbolChange } from './coordination/conceptual-conflict';
import { detectConceptualConflictsFromSubstrate } from './coordination/in-flight-substrate';
import { partitionTasks, type PartitionCas, type PartitionTask } from './coordination/partitioner';
import { planIntentMerge, type MergePlan } from './coordination/intent-merge';
import { ingestAndPersist, loadPersistedRuntimeFacts } from './telemetry-fusion';
import { backfillIngestedTelemetry, ingestTelemetryBatch, loadTelemetryObservations, summarizeRouteMetrics } from './telemetry-ingestion';
import { buildNodeRuntimeMetrics } from './product';
import { getAnalysis } from './analyzer';
import { buildSummary, getProductMap, getFlowConcepts, getArchitecturalConflicts, getParadigmConformance, getPerspectives, getCicdPipelines, getCommunicationSeams, buildOrientCapsule, getSemanticCoverage, getDataEntities } from './query';
import type { SemanticRole } from './semantic-roles';
import {
  getAnalysisEntry,
  getAnalysisFileFingerprint,
  loadAnalysis,
  loadAnalysisSectionManifest,
  loadAnalysisSections,
  resolveAnalysisExportArtifact,
  saveAnalysis,
  writeJsonAtomic,
} from './storage';
import { parseCasSectionNames, selectCasSections, type CasSectionName } from './cas-sections';
import { clearFreshnessSummaryCache } from './freshness';
import { descriptionStorePath } from './description-enrichment';
import { generateElementDescription } from './description-enrichment';
import { withAnalysisFocus } from './analysis-focus';
import { ResponseCache, responseCacheKey } from './response-cache';
import { getCachedDeployableAnalyses, scopeCasToSubCasNode } from './deployable-analysis';
import { initSelfTelemetry, instrumentHttpHandler, mapSdkEvent } from './self-telemetry';
import type { CasRuntimeEvent } from '../../../packages/klauro-sdk-js/src/types';
import { executeHostedProjectQuery, HOSTED_PROJECT_QUERY_TOOL_NAMES } from './hosted-project-query';
import { getBuildIdentity } from '../../../packages/analyzer-core/src/analyzer/core/build-identity';
import { getStageFingerprints } from '../../../packages/analyzer-core/src/analyzer/core/stage-fingerprint';
import {
  decideAnalyzerIdentityReuse,
  type AnalyzerIdentity,
  type AnalyzerIdentityDecision,
} from './analyzer-identity-reuse';
import { z } from 'zod';

const DEFAULT_PORT = 8787;
const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024;

/** Build-time version constant (esbuild `define` in scripts/build-bundle.mjs).
 *  Undefined when running unbundled via tsx — fall back to package.json. */
declare const __KLAURO_VERSION__: string | undefined;

/** Running service's version for /health — must reflect the deployed server, not the CLI dist manifest. */
const SERVICE_VERSION: string | null = (() => {
  try {
    if (typeof __KLAURO_VERSION__ === 'string' && __KLAURO_VERSION__) return __KLAURO_VERSION__;
  } catch { /* unbundled */ }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version || null;
  } catch {
    return null;
  }
})();
const SSE_HEARTBEAT_MS = 25_000;
/**
 * Default TTL for ADVISORY claims made over the WAN coordination API
 * (POST /v1/coordination/claim with mode:'advisory'). Deliberately shorter
 * than fab.ts's same-machine 6h default: a remote agent that dies (or loses
 * its network) can't be observed via local process/file signals, so its
 * claims must self-expire on the server within a bounded window. Heartbeat =
 * re-claiming the same claim_id (LWW supersede refreshes heartbeat_at); an
 * agent quiet for longer than this TTL drops out of /v1/coordination/active.
 */
const REMOTE_ADVISORY_DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * §WS-C-transport — minimal in-process pub/sub for the coordination SSE
 * stream. One `Set<ServerResponse>` per workspace holds every open
 * `GET /v1/coordination/stream?workspace=` connection; a claim/release/
 * heartbeat/in-flight mutation broadcasts a delta to that workspace's
 * subscribers only (never cross-workspace). Deliberately process-local —
 * multi-process/horizontal fanout is out of scope here (see WS-K notes on
 * Redis pub/sub tiering); a single analyzer-service process is the deployed
 * shape today. Cleared automatically as connections close (`response.on('close')`).
 */
const coordinationSubscribers = new Map<string, Set<http.ServerResponse>>();

/** Push one SSE event to every open subscriber of `workspace`. Never throws. */
function broadcastCoordinationEvent(workspace: string, event: string, data: unknown): void {
  const subscribers = coordinationSubscribers.get(workspace);
  if (!subscribers || subscribers.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const subscriber of subscribers) {
    try {
      subscriber.write(payload);
    } catch {
      // A dead/broken pipe here is cleaned up by its own 'close' handler;
      // never let one bad subscriber break the broadcast to the others.
    }
  }
}

interface RemoteAnalyzerServiceOptions {
  dataDir?: string;
  token?: string;
  maxBodyBytes?: number;
  rateLimitPerMinute?: number;
  /**
   * Opt-in progressive AI availability for POST /v1/analyze. When true, the
   * handler returns the DETERMINISTIC CAS immediately (ai_enrichment='pending')
   * and the slow AI enrichment upgrades the stored analysis in the background.
   * DEFAULT FALSE — the synchronous path is byte-for-byte unchanged, so the
   * in-process bench server used by tests stays synchronous.
   */
  deferAiEnrichment?: boolean;
}

interface RateLimitBucket {
  windowStart: number;
  count: number;
}

let legacyCwdDataDirSweepDone = false;

/**
 * One-shot cleanup of the LEGACY implicit data dir: before the tmpdir default,
 * an unconfigured analyzer-server dropped its whole data tree (uploaded source
 * mirrors + CASes, gigabytes) at `<cwd>/.klauro-remote-analyzer` — inside the
 * repo tree when launched from a checkout. Remove it whenever it exists, looks
 * like an analyzer data dir (workspaces/ or accounts.json inside — never an
 * arbitrary user dir), and is not the dir this server was explicitly told to
 * use. Best-effort and once per process.
 */
function removeLegacyCwdDataDir(resolvedDataDir: string): void {
  if (legacyCwdDataDirSweepDone) return;
  legacyCwdDataDirSweepDone = true;
  try {
    const legacy = path.join(process.cwd(), '.klauro-remote-analyzer');
    if (path.resolve(legacy) === resolvedDataDir) return;
    if (!fs.pathExistsSync(legacy)) return;
    const looksLikeDataDir =
      fs.pathExistsSync(path.join(legacy, 'workspaces')) || fs.pathExistsSync(path.join(legacy, 'accounts.json'));
    if (!looksLikeDataDir) return;
    fs.removeSync(legacy);
    console.error(`[klauro] removed legacy analyzer data dir ${legacy} (analysis data lives on the server; unconfigured runs now use tmpdir scratch)`);
  } catch {
    // best-effort only — never block server startup on cleanup
  }
}

export function createRemoteAnalyzerHttpServer(options: RemoteAnalyzerServiceOptions = {}): http.Server {
  // Data-dir doctrine: a server data dir holds full uploaded source mirrors +
  // CASes and belongs on an EXPLICIT durable location (the VPS sets
  // KLAURO_REMOTE_ANALYZER_DATA=/data). The old fallback —
  // process.cwd()/.klauro-remote-analyzer — silently grew a gigabytes-scale
  // mirror INSIDE whatever repo the dev happened to launch from (observed:
  // apps/mcp-server/.klauro-remote-analyzer, stale since 2026-07-12 and a
  // source of stale-source confusion in audits). Unconfigured dev/test runs
  // now get a per-user tmpdir scratch instead; anything durable must be asked
  // for via --data-dir / KLAURO_REMOTE_ANALYZER_DATA.
  const dataDir = path.resolve(
    options.dataDir
      || process.env.KLAURO_REMOTE_ANALYZER_DATA
      || path.join(os.tmpdir(), `klauro-remote-analyzer-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`)
  );
  removeLegacyCwdDataDir(dataDir);
  const token = options.token ?? process.env.KLAURO_ANALYZER_TOKEN;
  const maxBodyBytes = options.maxBodyBytes || resolveMaxBodyBytes();
  const rateLimitPerMinute = options.rateLimitPerMinute ?? Number(process.env.KLAURO_ANALYZER_RATE_LIMIT_PER_MINUTE || 120);
  const buckets = new Map<string, RateLimitBucket>();
  // §AUTH-LIFECYCLE — separate bucket map + budget for the unauthenticated
  // auth surfaces (login, reset redemption). Kept apart from `buckets`
  // (general /v1/* coordination traffic) so a burst of legitimate analyzer
  // pushes can never starve the auth budget, or vice versa.
  const authBuckets = new Map<string, RateLimitBucket>();
  const authRateLimitPerMinute = Number(process.env.KLAURO_AUTH_RATE_LIMIT_PER_MINUTE || 20);
  const activeCommittedSnapshots = new Map<string, string>();
  // Ops guard (durable board, wave 1): the 2026-07-21 incident was this server
  // writing its coordination board to the container's ephemeral overlay FS
  // (KLAURO_COORD_DIR unset) while the persistent /data volume went unused —
  // restart erased every claim and reset seq. Warn LOUDLY at startup whenever
  // the coord dir is not under this server's persistent data root.
  warnIfEphemeralCoordDir({ dataRoot: dataDir });
  // STRANDED-ANALYSIS (defect class #41 continuation): reap any analysis
  // attempt records left 'in-progress' by a PREVIOUS process incarnation
  // (this one has not started any background work yet, so any such record
  // found here is necessarily abandoned unless it's still within the
  // heartbeat staleness grace period — see reapAbandonedAttempt). Runs async,
  // fire-and-forget: must never delay server startup / port binding.
  void reapStaleAttemptRecordsOnStartup(dataDir);
  const accounts = new AccountStore(dataDir);
  // Server-side auto-refreshed workspace-level CAS: rebuilds are
  // debounced/coalesced per account workspace and run async — see
  // account-workspace-analysis.ts. notifyProjectAnalysisLandedForAnalysisId
  // below is the shared trigger both /v1/analyze and reanalyze use.
  const workspaceAnalyses = new AccountWorkspaceAnalysisScheduler(dataDir, accounts);
  const notifyProjectAnalysisLandedForAnalysisId = async (analysisId: string | undefined): Promise<void> => {
    if (!analysisId) return;
    try {
      const projects = await accounts.findProjectsByAnalysisId(analysisId);
      const workspaceIds = new Set(projects.map(project => project.workspace_id));
      for (const workspaceId of workspaceIds) workspaceAnalyses.notifyProjectAnalysisLanded(workspaceId);
    } catch (error) {
      // Never let workspace-analysis bookkeeping affect the analyze/reanalyze
      // response — it has already been computed successfully at this point.
      console.error(`[Klauro] failed to schedule workspace analysis rebuild for analysis ${analysisId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Self-telemetry (dogfooding): OFF unless KLAURO_SELF_TELEMETRY is truthy.
  // Init is crash-proof and a no-op when the gate is unset. See self-telemetry.ts.
  initSelfTelemetry();

  const requestHandler = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://localhost');
      const route = requestUrl.pathname;

      if (request.method === 'OPTIONS') {
        writeNoContent(response, 204);
        return;
      }

      if (request.method === 'GET' && route === '/health') {
        // git_sha is the sha that REPRODUCES this running process. Without it
        // on /health a deploy can report success while nobody can say which
        // code produced a given hosted analysis (prod ran an unreproducible
        // tree for hours under a version string that looked fine).
        const buildIdentity = getBuildIdentity();
        writeJson(response, 200, {
          status: 'ok',
          service: 'klauro-remote-analyzer',
          version: SERVICE_VERSION,
          // Lets `klauro doctor` check protocol compatibility with a plain,
          // side-effect-free GET instead of only learning about a mismatch
          // from a real analyze/sync submission's 426. Must stay equal to the
          // value enforced above and in clientUpgradeRequiredMessage.
          required_protocol_version: REMOTE_ANALYSIS_PROTOCOL_VERSION,
          build: {
            git_sha: buildIdentity.git_sha,
            build_time: buildIdentity.build_time ?? null,
            channel: buildIdentity.channel,
            dirty: buildIdentity.dirty === true,
            ...(buildIdentity.dirty ? { head_sha: buildIdentity.head_sha ?? null } : {}),
          },
        });
        return;
      }

      // Public installer script (no auth). Served verbatim from disk.
      // POSIX sh for macOS/Linux: `curl -fsSL <url>/install | sh`.
      if (request.method === 'GET' && (route === '/install' || route === '/install.sh')) {
        await serveInstallScript(response);
        return;
      }

      // Windows PowerShell installer (no auth): `irm <url>/install.ps1 | iex`.
      if (request.method === 'GET' && route === '/install.ps1') {
        await serveInstallPowershell(response);
        return;
      }

      // Public release manifest (no auth): version + tarball pointer for `klauro update`.
      if (request.method === 'GET' && route === '/dist/latest.json') {
        await serveLatestManifest(request, response);
        return;
      }

      // Public tarball download (no auth). Strict allowlist, no path traversal.
      if (request.method === 'GET' && (route === '/dist/klauro-latest.tgz' || route.startsWith('/dist/'))) {
        const requested = route === '/dist/klauro-latest.tgz'
          ? 'klauro-latest.tgz'
          : route.slice('/dist/'.length);
        await serveTarball(response, requested);
        return;
      }

      if (request.method === 'GET' && (route === '/' || route === '/app')) {
        writeJson(response, 200, {
          status: 'ok',
          service: 'klauro-api',
          app_url: process.env.KLAURO_APP_URL || 'https://app.klauro.com',
          api_docs: '/health',
          install: {
            macos_linux: `curl -fsSL ${publicBaseUrl(request)}/install | sh`,
            windows: `irm ${publicBaseUrl(request)}/install.ps1 | iex`,
          },
        });
        return;
      }

      if (request.method === 'POST' && route === '/api/auth/register') {
        const body = await readJsonBody<{ email: string; name?: string; password: string; workspace_name?: string }>(request, maxBodyBytes);
        const result = await accounts.register({
          email: body.email,
          name: body.name,
          password: body.password,
          workspaceName: body.workspace_name,
        });
        writeJson(response, 201, result);
        return;
      }

      // §AUTH-LIFECYCLE — per-IP throttle on the three unauthenticated
      // credential-guessing surfaces (login + reset redemption both accept a
      // secret from an anonymous caller). This is IN ADDITION to the
      // per-account exponential backoff inside AccountStore.login/
      // redeemPasswordResetToken: the account-level throttle protects one
      // account against sustained guessing, this protects the server against
      // one source hammering MANY accounts' login endpoints. Distinct,
      // stricter budget than the general coordination rate limit below (which
      // only applies to already-authenticated /v1/* traffic).
      if (request.method === 'POST' && (route === '/api/auth/login' || route === '/api/auth/reset-password/redeem')) {
        const ip = request.socket.remoteAddress || 'unknown';
        if (!withinRateLimit(authBuckets, `authip:${ip}`, authRateLimitPerMinute)) {
          await appendAuditLog(dataDir, { event: 'auth_ip_rate_limited', route, client: anonymizeClient(ip) });
          writeJson(response, 429, { status: 'error', error: 'Too many authentication attempts from this source. Try again shortly.' });
          return;
        }
      }

      if (request.method === 'POST' && route === '/api/auth/login') {
        const body = await readJsonBody<{ email: string; password: string }>(request, maxBodyBytes);
        const result = await accounts.login({ ...body, source: anonymizeClient(request.socket.remoteAddress || 'unknown') });
        writeJson(response, 200, result);
        return;
      }

      // Public (no Bearer): the whole point is to recover a signed-out,
      // password-forgotten account, so there is no valid session to require.
      // Authorization is the possession of the single-use token itself
      // (minted only by an operator — see AccountStore.mintPasswordResetToken),
      // not a Bearer header.
      if (request.method === 'POST' && route === '/api/auth/reset-password/redeem') {
        const body = await readJsonBody<{ token: string; new_password: string }>(request, maxBodyBytes);
        if (!body.token || !body.new_password) {
          writeJson(response, 400, { status: 'error', error: 'token and new_password are required' });
          return;
        }
        const result = await accounts.redeemPasswordResetToken({ token: body.token, newPassword: body.new_password });
        writeJson(response, 200, { status: 'success', user_id: result.userId, email: result.email });
        return;
      }

      // Ingest-path reconcile (P1): the @klauro/telemetry SDK a customer
      // installs POSTs batches to `/api/telemetry/runtime-events/:projectId`
      // (see packages/klauro-sdk-js/src/client.ts `ingestUrl()`), NOT to
      // `/v1/telemetry/ingest`. It carries its own telemetry `Authorization:
      // Bearer <apiKey>` — NOT an account session — so it must be handled
      // BEFORE the `/api/` account-session guard below (otherwise it 401s
      // "Sign in required"). It uses the same open-analyzer posture as
      // `/v1/telemetry/ingest`: gated only by authorizeAnalyzerRequest, which
      // we invoke inline here since this route sits above the shared
      // authorization block. The SDK's `{ events: CasRuntimeEvent[] }` body is
      // routed through the SAME observation ingest as the in-process self-loop
      // (self-telemetry.ts localIngestFetch), via the shared `mapSdkEvent`
      // translation. `:projectId` is the URL-encoded project/workspace path the
      // events attach to (and the read key for the observation/node-metrics
      // routes). `/v1/telemetry/ingest` is unchanged.
      if (request.method === 'POST' && route.startsWith('/api/telemetry/runtime-events/')) {
        const reconAuth = await authorizeAnalyzerRequest(accounts, request, token);
        if (!reconAuth.authorized) {
          writeJson(response, 401, { status: 'error', error: 'Unauthorized telemetry ingest request' });
          return;
        }
        const rawProjectId = route.slice('/api/telemetry/runtime-events/'.length);
        const projectId = decodeURIComponent(rawProjectId);
        if (!projectId) {
          writeJson(response, 400, { status: 'error', error: 'projectId path segment is required' });
          return;
        }
        const body = await readJsonBody<{ events?: CasRuntimeEvent[] }>(request, maxBodyBytes);
        const events = Array.isArray(body.events) ? body.events : [];
        // Keep ingest independent of CAS size and analyzer load. Raw events are
        // durable immediately; read/backfill correlates them once CAS is ready.
        const result = await ingestTelemetryBatch(null, projectId, events.map(mapSdkEvent), { persist: true });
        await appendAuditLog(dataDir, {
          event: 'telemetry_runtime_events',
          workspace: projectId,
          received: events.length,
          ingested: result.event_count,
          matched: result.correlation_summary.matched,
          unmatched: result.correlation_summary.unmatched,
        });
        writeJson(response, 200, { status: 'success', ...result });
        return;
      }

      if (route.startsWith('/api/')) {
        const apiAuthorization = await authorizeAccountApiRequest(accounts, request, token);
        if (!apiAuthorization.authorized) {
          writeJson(response, 401, {
            status: 'error',
            error: authRejectMessage(apiAuthorization.reason ?? 'no_token', 'api'),
            reason: apiAuthorization.reason ?? 'no_token',
          });
          return;
        }
        const accountResult = await handleAccountApi(accounts, apiAuthorization.userId, route, request, maxBodyBytes, apiAuthorization.sharedToken, dataDir, workspaceAnalyses);
        if (accountResult.stream) {
          response.writeHead(accountResult.statusCode, accountResult.stream.headers);
          const stream = createReadStream(accountResult.stream.filePath);
          stream.on('error', error => {
            if (!response.headersSent) writeJson(response, 500, { status: 'error', error: error.message });
            else response.destroy(error);
          });
          stream.pipe(response);
        } else if (accountResult.serializedBody !== undefined) {
          // Pre-serialized (cacheable) responses are written verbatim so a
          // cache hit is byte-identical to the fresh compute that produced it.
          writeText(response, accountResult.statusCode, 'application/json', accountResult.serializedBody);
        } else {
          writeJson(response, accountResult.statusCode, accountResult.body);
        }
        return;
      }

      const authorization = await authorizeAnalyzerRequest(accounts, request, token);
      if (!authorization.authorized) {
        writeJson(response, 401, {
          status: 'error',
          error: authRejectMessage(authorization.reason ?? 'no_token', 'coordination'),
          reason: authorization.reason ?? 'no_token',
        });
        return;
      }

      const clientId = authorization.clientId || request.socket.remoteAddress || 'unknown';
      if (requestConsumesMutationRateLimit(request.method) && !withinRateLimit(buckets, clientId, rateLimitPerMinute)) {
        await appendAuditLog(dataDir, {
          event: 'rate_limited',
          method: request.method,
          url: request.url,
          client: anonymizeClient(clientId),
        });
        writeJson(response, 429, { status: 'error', error: 'Remote analyzer rate limit exceeded' });
        return;
      }

      if (request.method === 'POST' && route === '/v1/analyze') {
        const body = await readJsonBody<RemoteAnalyzeRequest>(request, maxBodyBytes);
        if (body.protocol_version !== REMOTE_ANALYSIS_PROTOCOL_VERSION) {
          writeJson(response, 426, {
            status: 'error', code: 'client_upgrade_required',
            error: clientUpgradeRequiredMessage(),
            required_protocol_version: REMOTE_ANALYSIS_PROTOCOL_VERSION,
          });
          return;
        }

        if (!(await authorizeProjectWrite(accounts, authorization.clientId, body.project_id))) {
          writeJson(response, 404, { status: 'error', error: PROJECT_WRITE_DENIED_MESSAGE });
          return;
        }

        {
          // Progressive disclosure: persist the snapshot NOW, answer in
          // seconds, and run the entire analysis server-side in the
          // background. The background continuation performs the exact same
          // post-analyze steps as the synchronous path below (revision append,
          // account-project attach, audit log, workspace-level-CAS rebuild trigger); its
          // failures are logged + audited, never a hung/failed upload.
          if (!body.snapshot?.files?.length) {
            writeJson(response, 400, { status: 'error', error: 'Remote analyze requires a source snapshot with files' });
            return;
          }
          const rawAcceptedId = body.project_id || makeAnalysisId(body.project_path || body.snapshot.project_name);
          const acceptedAnalysisId = resolveStorageAnalysisId(rawAcceptedId, accountSaltFor(authorization.clientId));
          const visibleAnalysisId = clientVisibleAnalysisId(rawAcceptedId, acceptedAnalysisId, authorization.clientId);
          const acceptedWorkspace = workspacePath(dataDir, acceptedAnalysisId);
          const admission = await admitAccountAnalysisWorkspace(dataDir, authorization.clientId, rawAcceptedId, acceptedAnalysisId);
          if (!admission.admitted) {
            writeJson(response, 403, {
              status: 'error',
              error: `Storage limit reached: this account already has ${admission.count} distinct unbound analyses (limit ${admission.limit}). ` +
                `Bind this repo to an existing project (\`klauro init\`) instead of pushing another unbound checkout, or contact support to raise the limit.`,
            });
            return;
          }
          const snapshotIdentity = committedSnapshotIdentity(body.snapshot.manifest, body.snapshot.base_commit);
          const activeIdentity = activeCommittedSnapshots.get(acceptedAnalysisId);
          const revisions = await readProjectRevisions(dataDir, acceptedAnalysisId);
          const reusableRevision = revisions.revisions.find(revision => revisionMatchesSnapshot(revision, body.snapshot.manifest, body.snapshot.base_commit));
          const storedAnalysisExists = reusableRevision
            ? Boolean(await getAnalysisFileFingerprint(acceptedWorkspace, { track: 'main' }))
            : false;

          const analysisAlreadyRunning = Boolean(snapshotIdentity && activeIdentity === snapshotIdentity);
          const snapshotUnchanged = Boolean(reusableRevision && storedAnalysisExists);
          // ANALYZER IDENTITY is the second half of "unchanged". The source
          // snapshot matching only proves the INPUT is the same; it says
          // nothing about the analyzer that read it. Deduping on the snapshot
          // alone is why a customer who upgraded the CLI and re-ran `analyze`
          // silently got their old analysis back and no analyzer fix ever
          // reached them (see analyzer-identity-reuse.ts). An in-flight run is
          // exempt: it is being produced by THIS server right now.
          const identityDecision = snapshotUnchanged && !analysisAlreadyRunning
            ? await analyzerIdentityReuseDecisionFor(acceptedWorkspace)
            : null;
          // `--force` (task #132): the client explicitly asked to bypass the
          // reuse gate, so never take the "unchanged" shortcut for it — always
          // fall through to the full re-run below. This does NOT override
          // `analysisAlreadyRunning`: that guard exists to dedupe a second
          // upload of the exact same snapshot that races an in-flight run on
          // THIS server, not to serve a stale prior result, so forcing a
          // second concurrent rebuild of identical bytes would only waste a
          // worker slot without producing anything more "forced" than the
          // run already underway.
          const reuseStoredAnalysis = analysisAlreadyRunning
            || (!body.force && snapshotUnchanged && identityDecision?.reusable === true);

          if (reuseStoredAnalysis) {
            await linkAnalysisToAccountProject(
              accounts,
              authorization.clientId,
              body.project_id,
              acceptedAnalysisId,
              body.snapshot.manifest.git_remote,
              body.snapshot.manifest.repo_facts,
            );
            const reuseReason = analysisAlreadyRunning
              ? 'Analysis for this exact snapshot is already running on the server.'
              : identityDecision?.reason || 'Source snapshot and analyzer identity both unchanged.';
            await appendAuditLog(dataDir, {
              event: 'analyze_reused',
              analysis_id: acceptedAnalysisId,
              project_id: body.project_id,
              base_commit: body.snapshot.base_commit,
              reason: analysisAlreadyRunning ? 'already_running' : 'already_analyzed',
              analyzer_identity_tier: analysisAlreadyRunning ? 'in-flight' : identityDecision?.tier,
            });
            writeJson(response, 202, {
              status: 'accepted',
              protocol_version: REMOTE_ANALYSIS_PROTOCOL_VERSION,
              analysis_id: visibleAnalysisId,
              base_commit: body.snapshot.base_commit,
              manifest: body.snapshot.manifest,
              reused: true,
              analysis_type: 'unchanged',
              // `reused: true` with no reason is what made this invisible for
              // months. Always say WHY, and on which identity tier.
              reuse_decision: {
                reused: true,
                reason: reuseReason,
                source: 'unchanged',
                analyzer_identity_tier: analysisAlreadyRunning ? 'in-flight' : identityDecision?.tier || 'match',
                analyzer_build: currentAnalyzerIdentity().analyzer_build,
              },
            });
            return;
          }

          // Snapshot unchanged but the analyzer moved: re-analyze rather than
          // serve a stale result, and TELL the client which tier forced it.
          const analyzerUpgradeReanalysis = snapshotUnchanged && identityDecision?.reusable === false;
          if (analyzerUpgradeReanalysis && identityDecision) {
            await appendAuditLog(dataDir, {
              event: 'analyze_analyzer_upgrade',
              analysis_id: acceptedAnalysisId,
              project_id: body.project_id,
              base_commit: body.snapshot.base_commit,
              analyzer_identity_tier: identityDecision.tier,
              reason: identityDecision.reason,
            });
            console.error(
              `[Klauro] ${acceptedAnalysisId}: source snapshot unchanged but analyzer identity differs ` +
              `(tier=${identityDecision.tier}) — re-analyzing. ${identityDecision.reason}`
            );
          }

          if (snapshotIdentity) activeCommittedSnapshots.set(acceptedAnalysisId, snapshotIdentity);
          try {
            await fs.remove(acceptedWorkspace);
            await fs.ensureDir(acceptedWorkspace);
            await writeSnapshot(acceptedWorkspace, body.snapshot.files);
          } catch (error) {
            if (snapshotIdentity && activeCommittedSnapshots.get(acceptedAnalysisId) === snapshotIdentity) {
              activeCommittedSnapshots.delete(acceptedAnalysisId);
            }
            throw error;
          }
          // Would this request otherwise have hit the reuse shortcut above?
          // Only true when force is what's actually responsible for the
          // re-run — a genuinely changed snapshot or an analyzer upgrade get
          // their own, more specific reason text below.
          const forcedOverReuse = Boolean(body.force) && !analysisAlreadyRunning
            && snapshotUnchanged && identityDecision?.reusable === true;
          writeJson(response, 202, {
            status: 'accepted',
            protocol_version: REMOTE_ANALYSIS_PROTOCOL_VERSION,
            analysis_id: visibleAnalysisId,
            base_commit: body.snapshot.base_commit,
            manifest: body.snapshot.manifest,
            reused: false,
            ...(forcedOverReuse
              ? { analysis_type: 'forced' as const }
              : analyzerUpgradeReanalysis && identityDecision
                ? { analysis_type: 'analyzer_upgrade' as const }
                : {}),
            reuse_decision: {
              reused: false,
              reason: forcedOverReuse
                ? 'Client requested --force: source snapshot and analyzer identity are unchanged, but the reuse gate and AI response cache were bypassed on request.'
                : analyzerUpgradeReanalysis && identityDecision
                  ? identityDecision.reason
                  : 'Source snapshot differs from every stored revision.',
              source: forcedOverReuse ? 'forced' : analyzerUpgradeReanalysis ? 'analyzer_upgrade' : 'source_changed',
              analyzer_identity_tier: analyzerUpgradeReanalysis && identityDecision ? identityDecision.tier : 'match',
              analyzer_build: currentAnalyzerIdentity().analyzer_build,
              ...(body.force ? { ai_cache_bypassed: true } : {}),
            },
          });
          const backgroundClientId = authorization.clientId;
          setImmediate(async () => {
            let attachedEarly = false;
            // STRANDED-ANALYSIS (defect class #41 continuation): the FIRST
            // analyze async path historically wrote no attempt record at all
            // — only /reanalyze did — so a process death here (SIGTERM mid
            // background work, or any other crash before this function's own
            // catch runs) left GET .../status reporting 'populating' forever
            // with no error and nothing to reap it. Mirror the /reanalyze
            // pattern: write 'in-progress' now, heartbeat while the pipeline
            // runs, and always land a terminal 'succeeded'/'failed' write.
            const attemptRecordPath = projectAttemptRecordPath(acceptedWorkspace);
            const attemptStartedAt = new Date().toISOString();
            const attemptSnapshot: ReanalyzeAttemptRecord = {
              state: 'in-progress',
              trigger: 'analyze',
              started_at: attemptStartedAt,
            };
            await writeAttemptRecord(attemptRecordPath, { ...attemptSnapshot, heartbeat_at: attemptStartedAt });
            const stopHeartbeat = startAttemptHeartbeat(attemptRecordPath, attemptSnapshot);
            try {
              const displayName = resolveDisplayName(body.snapshot.project_name, body.project_path);

              // Loop-breaker pre-check (see analyzer.ts's
              // checkDoomedVersionRebuild): the workspace was just wiped
              // above, so this is almost always a cold first build with no
              // previous analysis to compare a cas_version against — the
              // check is a fast no-op in that common case, but guards the
              // rarer case (e.g. a re-push before the wipe landed) the same
              // way the /reanalyze path below does.
              const doomed = await checkDoomedVersionRebuild(acceptedWorkspace);
              if (doomed) throw new Error(doomed);

              // The layered pipeline (L0 index -> L1-4 deterministic pass ->
              // L5 AI enrichment) now runs INSIDE the heap-capped analysis
              // worker (see analyzer.ts's runLayeredAnalysis), not in this API
              // process — this is the fix for the 2026-07-18 incident where a
              // huge monorepo's in-process rebuild ballooned past the host's
              // RAM and got kernel-OOM-killed. This function's own resolved
              // value is only a small counts summary; the CAS itself is
              // reloaded from storage (getAnalysis) once each phase lands,
              // matching the 275e9dc7 pattern used by the sync routes.
              let l0Attach: Promise<void> | null = null;
              const summary = await runLayeredAnalysis(acceptedWorkspace, {
                displayName,
                // --force (task #132) bypasses the AI response cache too, not
                // just the snapshot reuse gate above — see
                // RunLayeredAnalysisOptions.forceAiRefresh.
                forceAiRefresh: body.force,
                // Root-cause structural fix (see analyzeProjectLayered's
                // forceFullRebuild doc): without this, the warm/incremental
                // path inside runLayeredAnalysis silently reused the
                // untouched previous CASOutput even after this handler
                // correctly decided not to reuse — a SECOND, independent
                // silent-reuse mechanism this task's fix would otherwise miss.
                forceFullRebuild: body.force,
                onPhase: (event) => {
                  // Progressive availability (task #112): attach the project +
                  // notify the workspace-level CAS the moment L0 (the fast index/inventory
                  // pre-pass) is persisted, not after the full deterministic
                  // pipeline finishes. This is what makes the web app show
                  // the project populating within seconds instead of after
                  // the full ~1-2.5min pass — the account-project record only
                  // needs an analysis_id to resolve to SOME stored CAS at
                  // acceptedWorkspace, and whichever layer is currently on
                  // disk there is what queries see (honestly, via that CAS's
                  // own layers_ready manifest).
                  if (event.phase === 'l0' && event.status === 'succeeded' && !l0Attach) {
                    l0Attach = (async () => {
                      try {
                        await linkAnalysisToAccountProject(accounts, backgroundClientId, body.project_id, acceptedAnalysisId, body.snapshot?.manifest?.git_remote, body.snapshot?.manifest?.repo_facts);
                        attachedEarly = true;
                        void notifyProjectAnalysisLandedForAnalysisId(acceptedAnalysisId);
                      } catch (attachError) {
                        const detail = attachError instanceof Error ? attachError.message : String(attachError);
                        console.error(`[Klauro] early L0 project attach failed for ${acceptedAnalysisId}: ${detail}`);
                      }
                    })();
                  }
                },
              });
              if (l0Attach) await l0Attach;

              const output = await getAnalysis(acceptedWorkspace);
              // repo_facts regression fix: the SYNCHRONOUS /v1/analyze path
              // (handleAnalyze) already stamps manifest.repo_facts onto the
              // CAS, but this async continuation (body.async===true — the
              // default push shape for large repos) never did, so every
              // async-pushed analysis shipped without contributors/codebase
              // age even though the client's manifest carried them.
              await stampRepoFacts(acceptedWorkspace, output, body.snapshot.manifest);
              const backgroundResult: RemoteAnalyzeResponse = {
                status: 'success',
                analysis_id: acceptedAnalysisId,
                analysis_revision: Date.now(),
                analysis_type: 'full',
                base_commit: body.snapshot.base_commit,
                manifest: body.snapshot.manifest,
                cas: output,
              };
              await appendProjectRevision(dataDir, backgroundResult, 'local_commit_submission');
              // Attach again (idempotent) in case the early L0 attach above
              // failed or was skipped — never leave the landed full analysis
              // unattached because of a transient early-attach error.
              if (!attachedEarly) {
                await linkAnalysisToAccountProject(accounts, backgroundClientId, body.project_id, acceptedAnalysisId, body.snapshot?.manifest?.git_remote, body.snapshot?.manifest?.repo_facts);
              }
              await appendAuditLog(dataDir, {
                event: 'analyze',
                analysis_id: acceptedAnalysisId,
                project_id: body.project_id,
                organization_id: body.organization_id,
                files: body.snapshot.manifest?.file_count,
                bytes: body.snapshot.manifest?.total_bytes,
                nodes: summary.nodes,
                edges: summary.edges,
                mode: 'async',
              });
              void notifyProjectAnalysisLandedForAnalysisId(acceptedAnalysisId);
              const attemptFinishedAt = new Date().toISOString();
              await writeAttemptRecord(attemptRecordPath, {
                state: 'succeeded',
                trigger: 'analyze',
                started_at: attemptStartedAt,
                finished_at: attemptFinishedAt,
                duration_ms: Date.parse(attemptFinishedAt) - Date.parse(attemptStartedAt),
              });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              console.error(`[Klauro] async analyze failed for ${acceptedAnalysisId}: ${detail}`);
              // Make the failure VISIBLE to pollers instead of leaving the
              // ladder 'pending' forever (see markBackgroundAnalysisFailed).
              await markBackgroundAnalysisFailed(acceptedWorkspace, detail);
              const attemptFinishedAt = new Date().toISOString();
              await writeAttemptRecord(attemptRecordPath, {
                state: 'failed',
                trigger: 'analyze',
                started_at: attemptStartedAt,
                finished_at: attemptFinishedAt,
                duration_ms: Date.parse(attemptFinishedAt) - Date.parse(attemptStartedAt),
                reason: detail.slice(0, 300),
              });
              await appendAuditLog(dataDir, {
                event: 'analyze_async_failed',
                analysis_id: acceptedAnalysisId,
                project_id: body.project_id,
                error: detail.slice(0, 500),
              }).catch(() => {});
            } finally {
              stopHeartbeat();
              if (snapshotIdentity && activeCommittedSnapshots.get(acceptedAnalysisId) === snapshotIdentity) {
                activeCommittedSnapshots.delete(acceptedAnalysisId);
              }
            }
          });
          return;
        }

      }

      const rawAnalysisStatusMatch = route.match(/^\/v1\/analyses\/([^/]+)\/status$/);
      if (request.method === 'GET' && rawAnalysisStatusMatch) {
        const analysisId = await resolveAuthorizedAnalysisReadId(
          accounts,
          authorization.clientId,
          decodeURIComponent(rawAnalysisStatusMatch[1]),
        );
        if (!analysisId) {
          writeJson(response, 404, { status: 'error', error: 'Analysis not found' });
          return;
        }
        const workspace = workspacePath(dataDir, analysisId);
        const attemptRecordPath = projectAttemptRecordPath(workspace);
        // STRANDED-ANALYSIS (defect class #41 continuation): reap lazily on
        // every poll too, not only at process startup — this is what
        // surfaces a restart-abandoned analysis to a poller within one
        // heartbeat-staleness window (see ATTEMPT_STALE_THRESHOLD_MS)
        // instead of waiting for someone to restart the server again before
        // the startup sweep gets another chance to look. Never touches a
        // record whose heartbeat is still fresh, and never fails a landed CAS.
        await reapAbandonedAttempt(workspace, attemptRecordPath);
        const entry = await getAnalysisEntry(workspace);
        const lastAttempt = await readAttemptRecord(attemptRecordPath);
        const layers = entry?.layers_ready?.layers || [];
        const failedLayers = layers.filter(layer => layer.status === 'error');
        const complete = Boolean(
          entry
          && (entry.layers_ready?.complete ?? true)
          && !activeCommittedSnapshots.has(analysisId),
        );
        // A first-analyze crash before L0 ever landed leaves NO CAS at all
        // (entry === null), so markBackgroundAnalysisFailed has no 'pending'
        // layer to flip to 'error' and failedLayers stays empty — the last
        // attempt's own terminal 'failed' state (written by the catch block
        // above, or by reapAbandonedAttempt just now) is the only signal of
        // that failure. Only consulted when there is no landed CAS
        // (complete is checked first) and no CAS-layer failure already
        // covers it, so a landed analysis is never overridden by a stale
        // attempt record.
        const abandonedWithNoCas = !complete && failedLayers.length === 0 && lastAttempt?.state === 'failed';
        writeJson(response, 200, {
          status: failedLayers.length > 0 ? 'failed' : complete ? 'ready' : abandonedWithNoCas ? 'failed' : 'populating',
          analysis_id: analysisId,
          ...(entry ? {
            summary: {
              name: entry.name,
              node_count: entry.node_count,
              edge_count: entry.edge_count,
              analyzed_at: entry.analyzed_at,
              layers_ready: entry.layers_ready,
            },
          } : {}),
          ...(lastAttempt ? { last_attempt: lastAttempt } : {}),
          ...(failedLayers.length > 0 ? { failed_layers: failedLayers } : {}),
        });
        return;
      }

      const rawAnalysisExportMatch = route.match(/^\/v1\/analyses\/([^/]+)\/cas\/export$/);
      if (request.method === 'GET' && rawAnalysisExportMatch) {
        const analysisId = await resolveAuthorizedAnalysisReadId(
          accounts,
          authorization.clientId,
          decodeURIComponent(rawAnalysisExportMatch[1]),
        );
        if (!analysisId) {
          writeJson(response, 404, { status: 'error', error: 'Analysis not found' });
          return;
        }
        const artifact = await resolveAnalysisExportArtifact(workspacePath(dataDir, analysisId));
        if (!artifact) {
          writeJson(response, 404, { status: 'error', error: 'Analysis is not ready' });
          return;
        }
        response.writeHead(200, {
          'content-type': artifact.codec === 'zstd' ? 'application/zstd' : 'application/json',
          'content-length': artifact.bytes,
          'x-klauro-cas-codec': artifact.codec,
          'x-klauro-analysis-id': analysisId,
          ...(artifact.codec === 'brotli' ? { 'content-encoding': 'br' } : {}),
        });
        createReadStream(artifact.filePath).pipe(response);
        return;
      }

      if (request.method === 'POST' && route === '/v1/analyze-diff') {
        const body = await readJsonBody<RemoteAnalyzeDiffRequest>(request, maxBodyBytes);
        if (!(await authorizeProjectWrite(accounts, authorization.clientId, body.project_id))) {
          writeJson(response, 404, { status: 'error', error: PROJECT_WRITE_DENIED_MESSAGE });
          return;
        }
        const result = await handleAnalyzeDiff(dataDir, body, accountSaltFor(authorization.clientId));
        await appendAuditLog(dataDir, {
          event: 'analyze_diff',
          analysis_id: result.analysis_id,
          project_id: body.project_id,
          organization_id: body.organization_id,
          base_branch: body.diff_context?.base_branch,
          target_branch: body.diff_context?.target_branch,
          files: result.manifest.file_count,
          bytes: result.manifest.total_bytes,
          nodes: result.cas.nodes.length,
          edges: result.cas.edges.length,
        });
        writeJson(response, 200, {
          ...result,
          analysis_id: clientVisibleAnalysisId(body.project_id || makeAnalysisId(body.project_path || body.diff_context.target_branch), result.analysis_id, authorization.clientId),
        });
        return;
      }

      if (request.method === 'POST' && route === '/v1/enrich-element') {
        const body = await readJsonBody<{
          analysis_id?: string;
          target?: string;
          target_kind?: 'node' | 'service' | 'entity' | 'capability' | 'entry_point' | 'exit_point' | 'flow';
          instructions?: string;
        }>(request, maxBodyBytes);
        if (!body.analysis_id || !body.target) {
          writeJson(response, 400, { status: 'error', error: 'Hosted element enrichment requires analysis_id and target' });
          return;
        }
        if (!(await authorizeProjectWrite(accounts, authorization.clientId, body.analysis_id))) {
          writeJson(response, 404, { status: 'error', error: PROJECT_WRITE_DENIED_MESSAGE });
          return;
        }
        const analysisId = resolveStorageAnalysisId(body.analysis_id, accountSaltFor(authorization.clientId));
        const workspace = workspacePath(dataDir, analysisId);
        if (!(await fs.pathExists(workspace))) {
          writeJson(response, 404, { status: 'error', error: `No uploaded analysis found for ${body.analysis_id}` });
          return;
        }
        const result = await withAnalysisFocus('ui-overview', () => generateElementDescription({
          projectPath: workspace,
          target: body.target!,
          targetKind: body.target_kind,
          instructions: body.instructions,
        }));
        writeJson(response, 200, {
          ...result,
          analysis_id: clientVisibleAnalysisId(body.analysis_id, analysisId, authorization.clientId),
        });
        return;
      }

      const revisionsMatch = route.match(/^\/v1\/projects\/([^/]+)\/revisions$/);
      if (request.method === 'GET' && revisionsMatch) {
        // Same resolveStorageAnalysisId salting as the write paths: a raw
        // client-computed bare-hash id must resolve to the CALLER's own
        // per-account revision file, never another account's, even if two
        // accounts happen to compute the identical unsalted hash (same repo
        // path). A prj_... id passes through unchanged, same as elsewhere.
        const requestedAnalysisId = decodeURIComponent(revisionsMatch[1]);
        const analysisId = resolveStorageAnalysisId(requestedAnalysisId, accountSaltFor(authorization.clientId));
        const result = await readProjectRevisions(dataDir, analysisId);
        writeJson(response, 200, {
          ...result,
          analysis_id: clientVisibleAnalysisId(requestedAnalysisId, analysisId, authorization.clientId),
        });
        return;
      }

      if (request.method === 'POST' && route === '/v1/sync') {
        const body = await readJsonBody<RemoteSyncRequest>(request, maxBodyBytes);
        if (body.protocol_version !== REMOTE_ANALYSIS_PROTOCOL_VERSION) {
          writeJson(response, 426, {
            status: 'error', code: 'client_upgrade_required',
            error: clientUpgradeRequiredMessage(),
            required_protocol_version: REMOTE_ANALYSIS_PROTOCOL_VERSION,
          });
          return;
        }
        // Sync's storage key is `analysis_id`, not `project_id` (see
        // prepareSync below) — that is the field to gate. `project_id` is
        // only used later for the account-attach step, which is already
        // membership-checked via linkAnalysisToAccountProject/recordCompletedSync.
        if (!(await authorizeProjectWrite(accounts, authorization.clientId, body.analysis_id))) {
          writeJson(response, 404, { status: 'error', error: PROJECT_WRITE_DENIED_MESSAGE });
          return;
        }
        if (body.async === true) {
          const prepared = await prepareSync(dataDir, body, accountSaltFor(authorization.clientId));
          const attemptRecordPath = projectAttemptRecordPath(prepared.workspace);
          const queuedAt = new Date().toISOString();
          await writeAttemptRecord(attemptRecordPath, {
            state: 'in-progress',
            trigger: 'sync',
            queued_at: queuedAt,
            started_at: queuedAt,
          });
          writeJson(response, 202, {
            status: 'accepted',
            protocol_version: REMOTE_ANALYSIS_PROTOCOL_VERSION,
            analysis_id: clientVisibleAnalysisId(body.analysis_id, prepared.analysisId, authorization.clientId),
            base_commit: body.changes.base_commit,
            manifest: prepared.manifest,
          });
          setImmediate(async () => {
            const startedAt = new Date().toISOString();
            const syncAttemptSnapshot: ReanalyzeAttemptRecord = {
              state: 'in-progress',
              trigger: 'sync',
              queued_at: queuedAt,
              started_at: startedAt,
            };
            await writeAttemptRecord(attemptRecordPath, { ...syncAttemptSnapshot, heartbeat_at: startedAt });
            // STRANDED-ANALYSIS: heartbeat while this sync's background work
            // runs, same as the analyze/reanalyze paths — see
            // startAttemptHeartbeat's doc comment for why a short heartbeat
            // interval is safe even for a long-running sync.
            const stopHeartbeat = startAttemptHeartbeat(attemptRecordPath, syncAttemptSnapshot);
            try {
              const result = await completeSync(prepared, body);
              await recordCompletedSync(dataDir, accounts, body, result, authorization.clientId);
              const finishedAt = new Date().toISOString();
              await writeAttemptRecord(attemptRecordPath, {
                state: 'succeeded',
                trigger: 'sync',
                queued_at: queuedAt,
                started_at: startedAt,
                finished_at: finishedAt,
                duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
              });
              void notifyProjectAnalysisLandedForAnalysisId(result.analysis_id);
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              console.error(`[Klauro] async sync failed for ${prepared.analysisId}: ${detail}`);
              const finishedAt = new Date().toISOString();
              await markBackgroundAnalysisFailed(prepared.workspace, detail);
              await writeAttemptRecord(attemptRecordPath, {
                state: 'failed',
                trigger: 'sync',
                queued_at: queuedAt,
                started_at: startedAt,
                finished_at: finishedAt,
                duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
                reason: detail.slice(0, 500),
              });
              await appendAuditLog(dataDir, {
                event: 'sync_async_failed',
                analysis_id: prepared.analysisId,
                project_id: body.project_id,
                error: detail.slice(0, 500),
              }).catch(() => {});
            } finally {
              stopHeartbeat();
            }
          });
          return;
        }
        const result = await handleSync(dataDir, body, accountSaltFor(authorization.clientId));
        await recordCompletedSync(dataDir, accounts, body, result, authorization.clientId);
        writeJson(response, 200, {
          ...result,
          analysis_id: clientVisibleAnalysisId(body.analysis_id, result.analysis_id, authorization.clientId),
        });
        // WORKSPACE-LEVEL-CAS AUTO-REBUILD REGRESSION FIX: /v1/analyze and /api/projects/:id/
        // reanalyze both call notifyProjectAnalysisLandedForAnalysisId after a
        // member CAS lands, but this route never did — so a workspace whose
        // members only ever get refreshed via incremental `sync_codebase_remote`
        // pushes (the common case once a project has an initial analysis_id)
        // never marked its account workspace dirty, and the server-side workspace-level CAS
        // silently sat stale until someone manually hit POST
        // /api/workspaces/{id}/reanalyze. Same fire-and-forget contract as the
        // other two call sites: never blocks or affects this response.
        void notifyProjectAnalysisLandedForAnalysisId(result.analysis_id);
        // repo_facts persistence: a dirty-tree sync's manifest carries its own
        // freshly-derived repo_facts (remote-source.ts deriveRepoFacts) — save
        // it on the linked project record (if any) so a later server-side
        // reanalyze with no client .git in reach has a last-known value to
        // fall back on (see stampRepoFactsFromLastKnownOrMarkAbsent).
        return;
      }

      if (request.method === 'POST' && route === '/v1/proposals/preview') {
        const body = await readJsonBody<RemoteProposalPreviewRequest>(request, maxBodyBytes);
        const result = await handleProposalPreview(dataDir, body, accountSaltFor(authorization.clientId));
        await appendAuditLog(dataDir, {
          event: 'proposal_preview',
          project_id: body.project_id,
          organization_id: body.organization_id,
          status: (result as any).status,
          preview_id: (result as any).preview?.id,
        });
        writeJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && route === '/v1/proposals/greenfield') {
        const body = await readJsonBody<RemoteGreenfieldPreviewRequest>(request, maxBodyBytes);
        const result = await previewGreenfieldCodebase({
          title: body.title,
          planText: body.plan_text,
          proposedFiles: body.proposed_files,
          organizationId: body.organization_id,
          projectId: body.project_id,
          previewBaseUrl: body.preview_base_url,
        });
        await appendAuditLog(dataDir, {
          event: 'greenfield_preview',
          project_id: body.project_id,
          organization_id: body.organization_id,
          status: (result as any).status,
          preview_id: (result as any).preview?.id,
        });
        writeJson(response, 200, result);
        return;
      }

      // §WS-C-transport / WS-A — coordination fabric + telemetry ingest over HTTP,
      // for cross-machine agents (same LOCAL store used by the MCP tools in
      // server.ts, keyed by `workspace`; the coordination/ modules are the
      // committed pure core). Fabric v2 WS2: claim/release/heartbeat/state now
      // route through the ENFORCED grant-manager (requestGrant/releaseGrant/
      // heartbeatGrant/getGrants), the same path server.ts's MCP tools use, so
      // cross-machine/HTTP clients get real grant/queue enforcement too.
      if (request.method === 'POST' && route === '/v1/coordination/claim') {
        // ENFORCED grant path (Fabric v2 WS2 — see coordination/grant-manager.ts):
        // cross-machine/HTTP callers get the same grant/queue/redirect semantics
        // MCP's claim_work tool does, not just advisory arbitration. §1.6
        // SPEC-COORDINATION-FABRIC-V2: a queued verdict is awareness-rich (holder
        // intent + lease_status + options), never a bare "denied".
        const body = await readJsonBody<{
          workspace: string; agent_id: string; intent: string; agent_kind?: AgentKind;
          paths?: string[]; symbols?: string[]; capability?: string; ttl_ms?: number;
          base_commit?: string; branch?: string; claim_id?: string;
          /** 'advisory' = fabric awareness claim (fab.ts parity: never blocks,
           *  never queues, always succeeds, returns overlap warnings inline).
           *  Absent/'grant' = the ENFORCED grant path below (unchanged). */
          mode?: 'advisory' | 'grant';
          /** Durable-board protocol (write-through replication from a client's
           *  local log): lifecycle status + writer-owned per-claim version +
           *  event kind, echoed VERBATIM into this board so cross-store LWW
           *  keys on the writer's version (never this board's arrival seq) and
           *  a replicated RELEASE stays a release. Absent on plain advisory
           *  claims from older clients — legacy behavior unchanged. */
          status?: 'active' | 'released';
          version?: number;
          kind?: ClaimLogEntry['kind'];
          /** Coordination Engine §3 structured intent, additive on the wire:
           *  contracts this lane will create/change, and the contract names it
           *  builds against. Old clients send neither and behave exactly as
           *  before; old servers ignore them (§16 migration). */
          produces?: DeclaredContract[];
          consumes?: string[];
        }>(request, maxBodyBytes);

        // ADVISORY fabric path (cross-machine mirror of fab.ts claim /
        // fab_claim_work): append to the SERVER's per-workspace claim log
        // (same local-store primitives, server dataDir's KLAURO_COORD_DIR) so
        // agents on DIFFERENT machines see each other. Awareness-first: the
        // claim always succeeds; overlap with another agent's active claim is
        // returned as `conflicts` + `warning`, never a queue or a denial.
        // Server-assigned `seq` + `server_time` are authoritative for
        // cross-machine ordering (client clocks are not trusted).
        // TTL: WAN-appropriate default of 30 minutes (a remote agent that
        // dies stops re-claiming and expires via the same heartbeat_at+ttl_ms
        // model presence.ts applies to local claims). Re-claiming the same
        // claim_id refreshes heartbeat_at (LWW supersede) = the heartbeat.
        if (body.mode === 'advisory') {
          const workspace = body.workspace;
          const claimPaths = body.paths || [];
          const conflicts = claimPaths.length ? await checkEditLock(workspace, claimPaths, body.agent_id) : [];
          const now = new Date().toISOString();
          const entry = await appendClaim(workspace, {
            claim_id: body.claim_id || `${workspace}:${body.agent_id}`,
            workspace_id: workspace,
            agent_id: body.agent_id,
            agent_kind: body.agent_kind || 'other',
            scope: { repo: workspace, paths: claimPaths, symbols: body.symbols || [], capability: body.capability },
            intent: body.intent,
            // Durable-board protocol: honor a replicated lifecycle status and
            // ECHO the writer-owned version verbatim (appendClaim preserves a
            // supplied version; only mints one when absent). Legacy callers
            // send neither — behavior identical to before.
            status: body.status === 'released' ? 'released' : 'active',
            version: typeof body.version === 'number' ? body.version : undefined,
            kind: body.kind,
            created_at: now,
            ttl_ms: body.ttl_ms ?? REMOTE_ADVISORY_DEFAULT_TTL_MS,
            heartbeat_at: now,
            base_commit: body.base_commit,
            branch: body.branch,
            ...(body.produces?.length ? { produces: body.produces } : {}),
            ...(body.consumes?.length ? { consumes: body.consumes } : {}),
          });
          const board = await getBoardInfo(workspace);
          broadcastCoordinationEvent(workspace, 'claim', {
            claim_id: entry.claim_id,
            agent_id: body.agent_id,
            verdict: 'granted',
            mode: 'advisory',
          });
          writeJson(response, 200, {
            claim_id: entry.claim_id,
            seq: entry.seq,
            version: entry.version,
            epoch: board.epoch,
            min_retained_seq: board.min_retained_seq,
            verdict: 'granted',
            mode: 'advisory',
            ttl_ms: entry.ttl_ms,
            server_time: now,
            conflicts,
            warning: conflicts.length
              ? `ADVISORY: ${conflicts.length} other agent(s) already claim overlapping paths (${conflicts.map((c) => c.agent_id).join(', ')}). Your claim still succeeded — coordinate before writing.`
              : undefined,
          });
          return;
        }

        const result = await requestGrant({
          workspace_id: body.workspace,
          agent_id: body.agent_id,
          agent_kind: body.agent_kind || 'other',
          scope: { repo: body.workspace, paths: body.paths || [], symbols: body.symbols || [], capability: body.capability },
          intent: body.intent,
          ttl_ms: body.ttl_ms,
        });

        let freeHint: { free_paths: string[]; free_symbols: string[] } | undefined;
        let holder: GrantHolderContext | undefined;
        let options: string[] | undefined;
        if (result.verdict === 'queued') {
          const { active } = await getGrants(body.workspace);
          const heldPaths = new Set(active.flatMap((g) => g.scope.paths));
          const heldSymbols = new Set(active.flatMap((g) => g.scope.symbols));
          freeHint = {
            free_paths: (body.paths || []).filter((p) => !heldPaths.has(p)),
            free_symbols: (body.symbols || []).filter((s) => !heldSymbols.has(s)),
          };
          const holderId = result.conflict?.holder_agent_id;
          if (holderId) {
            const holders = await describeGrantHolders(body.workspace, [holderId]);
            holder = holders[holderId];
          }
          options = ['wait_and_heartbeat_poll', 'proceed_with_awareness_if_compatible'];
          if (freeHint.free_paths.length > 0 || freeHint.free_symbols.length > 0) options.push('redirect_to_free_scope');
          if (holder && holder.lease_status !== 'active') options.push('take_over_stale_lease');
        }

        broadcastCoordinationEvent(body.workspace, 'claim', {
          claim_id: result.grant_id,
          agent_id: body.agent_id,
          verdict: result.verdict,
        });
        writeJson(response, 200, {
          claim_id: result.grant_id,
          verdict: result.verdict,
          grant_id: result.grant_id,
          lease_expires_at: result.lease_expires_at,
          queue_position: result.queue_position,
          conflict: result.conflict,
          holder,
          options,
          redirect_hint: result.redirect_hint,
          free_scope_hint: freeHint,
          base_commit: body.base_commit,
          branch: body.branch,
        });
        return;
      }

      if (request.method === 'POST' && route === '/v1/coordination/release') {
        const body = await readJsonBody<{ workspace: string; claim_id?: string; agent_id?: string }>(request, maxBodyBytes);
        if (!body.agent_id) {
          writeJson(response, 400, { status: 'error', error: 'agent_id is required to release a grant', claim_id: body.claim_id });
          return;
        }
        // ADVISORY release-all (fab.ts `release <agent>` parity, cross-machine):
        // no claim_id means "drop EVERY active advisory claim this agent holds
        // in this workspace" — same releaseAgent semantics as the local fabric,
        // applied to the server-side per-workspace claim log.
        if (!body.claim_id) {
          // releaseAgentWithReason: a released_count of 0 must say WHY
          // (double-release no-op vs never-claimed vs workspace-id mismatch
          // with the live claim elsewhere) — V3 §6.3's released_count:0 finding.
          const outcome = await releaseAgentWithReason(body.workspace, body.agent_id);
          const released = outcome.released;
          broadcastCoordinationEvent(body.workspace, 'release', {
            agent_id: body.agent_id,
            released_count: released.length,
            status: 'released',
            mode: 'advisory',
          });
          writeJson(response, 200, {
            status: 'released',
            mode: 'advisory',
            agent_id: body.agent_id,
            released_count: released.length,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
            released: released.map((r) => ({ claim_id: r.claim_id, intent: r.intent, paths: r.scope.paths })),
            server_time: new Date().toISOString(),
          });
          return;
        }
        // A claim_id alone doesn't say which store it belongs to: advisory
        // claims and enforced grants share one claims.jsonl under different
        // key shapes (grant ids are always `grant_<...>`). Must try both
        // tiers by exact id and report which matched, or say so if neither did —
        // never answer 'released' without having found and released a match.
        const advisoryReleased = await releaseClaimById(body.workspace, body.agent_id, body.claim_id);
        if (advisoryReleased) {
          broadcastCoordinationEvent(body.workspace, 'release', {
            claim_id: body.claim_id,
            agent_id: body.agent_id,
            status: 'released',
            mode: 'advisory',
          });
          writeJson(response, 200, { status: 'released', claim_id: body.claim_id, mode: 'advisory', tier: 'claim-log' });
          return;
        }
        const grantOutcome = await releaseGrant(body.workspace, body.agent_id, body.claim_id);
        if (grantOutcome.released) {
          broadcastCoordinationEvent(body.workspace, 'release', {
            claim_id: body.claim_id,
            agent_id: body.agent_id,
            status: 'released',
            mode: 'grant',
          });
          writeJson(response, 200, { status: 'released', claim_id: body.claim_id, mode: 'grant', tier: 'grant-manager' });
          return;
        }
        // Checked both tiers of the SAME store and found nothing active under
        // this exact claim_id for this agent_id — never silently report
        // "released" (the #57 defect). Mirrors releaseAgentWithReason's
        // never-a-silent-zero contract for the release-all path above.
        writeJson(response, 200, {
          status: 'not_found',
          claim_id: body.claim_id,
          agent_id: body.agent_id,
          reason:
            `No ACTIVE claim "${body.claim_id}" for agent "${body.agent_id}" in workspace "${body.workspace}" ` +
            `— checked both the advisory claim log and the enforced grant-manager store. Already released/` +
            `superseded/expired, an unknown/mistyped id, or a workspace-id mismatch. To release EVERY advisory ` +
            `claim this agent holds regardless of claim_id, call again with no claim_id.`,
        });
        return;
      }

      if (request.method === 'POST' && route === '/v1/coordination/heartbeat') {
        const body = await readJsonBody<{ workspace: string; claim_id: string }>(request, maxBodyBytes);
        const result = await heartbeatGrant(body.workspace, body.claim_id);
        if (!result.ok) {
          writeJson(response, 200, { status: 'not_found', claim_id: body.claim_id });
          return;
        }
        broadcastCoordinationEvent(body.workspace, 'heartbeat', {
          claim_id: body.claim_id,
          lease_expires_at: result.lease_expires_at,
        });
        writeJson(response, 200, { status: 'heartbeat', claim_id: body.claim_id, lease_expires_at: result.lease_expires_at });
        return;
      }

      // ADVISORY read-only preflight, cross-machine (fab.ts `check` /
      // fab_check_collision parity): do `paths` overlap any OTHER active
      // claim in the server-side workspace log? Never a gate — returns the
      // conflicting claims (agent + intent + overlapping paths) so the caller
      // coordinates before writing. `agent_id` excludes the caller's own
      // claims from the scan.
      if (request.method === 'POST' && route === '/v1/coordination/check') {
        const body = await readJsonBody<{ workspace: string; agent_id?: string; paths?: string[] }>(request, maxBodyBytes);
        if (!body.workspace) {
          writeJson(response, 400, { status: 'error', error: 'workspace is required' });
          return;
        }
        const conflicts = await checkEditLock(body.workspace, body.paths || [], body.agent_id);
        writeJson(response, 200, {
          workspace: body.workspace,
          paths: body.paths || [],
          ok: conflicts.length === 0,
          conflicts,
          server_time: new Date().toISOString(),
        });
        return;
      }

      // ADVISORY active-claims view, cross-machine (fab.ts `active` /
      // fab_list_active_work parity): every active (non-expired) claim in the
      // workspace, LWW-reduced. A thin subset of GET /v1/coordination/state
      // for clients that only want the awareness surface.
      if (request.method === 'GET' && route === '/v1/coordination/active') {
        const workspace = requestUrl.searchParams.get('workspace') || '';
        if (!workspace) {
          writeJson(response, 400, { status: 'error', error: 'workspace query param is required' });
          return;
        }
        const log = await readClaimLog(workspace);
        const active = await getActiveClaims(workspace);
        const board = await getBoardInfo(workspace);
        writeJson(response, 200, {
          workspace,
          count: active.length,
          max_seq: log.reduce((max, entry) => Math.max(max, entry.seq), 0),
          epoch: board.epoch,
          min_retained_seq: board.min_retained_seq,
          server_time: new Date().toISOString(),
          active: active.map((c) => ({
            claim_id: c.claim_id,
            seq: c.seq,
            agent_id: c.agent_id,
            agent_kind: c.agent_kind,
            status: c.status,
            intent: c.intent,
            paths: c.scope.paths,
            symbols: c.scope.symbols,
            heartbeat_at: c.heartbeat_at,
            ttl_ms: c.ttl_ms,
          })),
        });
        return;
      }

      if (request.method === 'GET' && route === '/v1/coordination/state') {
        const workspace = requestUrl.searchParams.get('workspace') || '';
        const sinceParam = requestUrl.searchParams.get('since');
        const since = sinceParam ? Number(sinceParam) : undefined;
        if (!workspace) {
          writeJson(response, 400, { status: 'error', error: 'workspace query param is required' });
          return;
        }
        // Poll fallback, kept alongside the SSE stream below for clients that
        // can't hold a long-lived connection (or as a resync-on-reconnect path).
        // Now also returns the ENFORCED grant projection (active + queued) so
        // cross-machine/HTTP clients see the same live grant state MCP's
        // get_active_agents tool does.
        const log = await readClaimLog(workspace);
        const claims = await getActiveClaims(workspace);
        const presence = await getPresence(workspace);
        const grants = await getGrants(workspace);
        const board = await getBoardInfo(workspace);
        const holderCtx = await describeGrantHolders(workspace, grants.active.map((g) => g.agent_id));
        const maxSeq = log.reduce((max, entry) => Math.max(max, entry.seq), 0);
        // Compaction delivery floor: a `since` cursor below min_retained_seq
        // can no longer get a complete replay — say so EXPLICITLY (gap notice),
        // never silence. Epoch lets the client detect a board reset and drop
        // its cursor instead of polling a "future" seq forever.
        const gap = Number.isFinite(since) ? describeCursorGap(since as number, board) : undefined;
        writeJson(response, 200, {
          workspace,
          max_seq: maxSeq,
          epoch: board.epoch,
          min_retained_seq: board.min_retained_seq,
          ...(gap ? { gap } : {}),
          claims: Number.isFinite(since) ? claims.filter((c) => c.seq > (since as number)) : claims,
          presence,
          grants: grants.active.map((g) => ({ ...g, intent: holderCtx[g.agent_id]?.intent, lease_status: holderCtx[g.agent_id]?.lease_status })),
          queued: grants.queued,
        });
        return;
      }

      // §WS-C-transport — live coordination stream. Keeps the response open as
      // `text/event-stream` and pushes claim/release/heartbeat/in-flight deltas
      // for `workspace` as they happen (see `broadcastCoordinationEvent`). Emits
      // an initial `state` event with the current snapshot so a fresh subscriber
      // doesn't have to race a separate GET /v1/coordination/state call, then a
      // `:heartbeat` comment every ~25s to keep intermediaries (proxies, load
      // balancers) from closing the idle connection. Cleans up its subscriber-set
      // entry on close (client disconnect, server shutdown, or network drop).
      if (request.method === 'GET' && route === '/v1/coordination/stream') {
        const workspace = requestUrl.searchParams.get('workspace') || '';
        if (!workspace) {
          writeJson(response, 400, { status: 'error', error: 'workspace query param is required' });
          return;
        }
        response.writeHead(200, corsHeaders({
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        }));
        response.write(': connected\n\n');

        const claims = await getActiveClaims(workspace);
        const presence = await getPresence(workspace);
        const board = await getBoardInfo(workspace);
        response.write(
          `event: state\ndata: ${JSON.stringify({ workspace, epoch: board.epoch, min_retained_seq: board.min_retained_seq, claims, presence })}\n\n`
        );

        let subscribers = coordinationSubscribers.get(workspace);
        if (!subscribers) {
          subscribers = new Set();
          coordinationSubscribers.set(workspace, subscribers);
        }
        subscribers.add(response);

        const heartbeatTimer = setInterval(() => {
          try {
            response.write(': heartbeat\n\n');
          } catch {
            // connection is going/gone; the 'close' handler below finishes cleanup.
          }
        }, SSE_HEARTBEAT_MS);

        const cleanup = (): void => {
          clearInterval(heartbeatTimer);
          const set = coordinationSubscribers.get(workspace);
          set?.delete(response);
          if (set && set.size === 0) coordinationSubscribers.delete(workspace);
        };
        request.on('close', cleanup);
        response.on('close', cleanup);
        response.on('error', cleanup);
        return;
      }

      // §1.7 SPEC-COORDINATION-FABRIC-V2 — cross-machine mirror of the MCP
      // `check_conceptual_conflicts` tool (server.ts). Same agent-reported
      // design and same `__conceptual__` marker technique (a WorkClaim.intent
      // JSON marker on the existing claim log, exactly like `__grant__`) so
      // HTTP/cross-machine callers get the identical crown-jewel detector MCP
      // callers do — no separate store, no separate detection logic (the
      // pure `detectConceptualConflicts` core is called the same way).
      if (request.method === 'POST' && route === '/v1/coordination/conceptual-conflicts') {
        const body = await readJsonBody<{
          workspace: string; agent_id: string; agent_kind?: AgentKind;
          intent: string; changes?: SymbolChange[];
        }>(request, maxBodyBytes);
        if (!body.workspace || !body.agent_id) {
          writeJson(response, 400, { status: 'error', error: 'workspace and agent_id are required' });
          return;
        }
        const requesterChanges: SymbolChange[] = Array.isArray(body.changes) ? body.changes : [];
        await reportConceptualChangesHttp(body.workspace, body.agent_id, body.agent_kind || 'other', body.intent || '', requesterChanges);

        const others = await otherAgentConceptualStatesHttp(body.workspace, body.agent_id);
        const cas = await conceptualConflictCasForWorkspaceHttp(body.workspace);
        const requesterState: AgentInFlightState = { agent_id: body.agent_id, intent: body.intent || '', changes: requesterChanges };
        const gitBasedConflicts = detectConceptualConflicts([requesterState, ...others], cas);
        // W0 SUBSTRATE PATH (SPEC-COORDINATION-FABRIC-V3 §3) — same additive
        // merge as the MCP tool in server.ts: attributed committed-vs-in-flight
        // track deltas, never git-diff-derived; dedupe by (kind, agents, symbol);
        // no in-flight track / no claims => no-op, never a request failure.
        let substrateConflicts: ConceptualConflict[] = [];
        let substrateInfo: { participants: number; unattributed: number } | undefined;
        try {
          const substrate = await detectConceptualConflictsFromSubstrate(body.workspace, cas);
          substrateConflicts = substrate.conflicts;
          substrateInfo = {
            participants: substrate.attributed.participants.length,
            unattributed: substrate.attributed.unattributed.length,
          };
        } catch {
          /* substrate unavailable — additive path only */
        }
        const conflictDedupeKey = (c: ConceptualConflict) => `${c.kind}|${[...c.agents].sort().join(',')}|${c.symbol}`;
        const seenConflicts = new Set(gitBasedConflicts.map(conflictDedupeKey));
        const allConflicts = [
          ...gitBasedConflicts,
          ...substrateConflicts.filter((c) => !seenConflicts.has(conflictDedupeKey(c))),
        ];
        const conflicts = allConflicts.filter((c) => c.agents.includes(body.agent_id));

        broadcastCoordinationEvent(body.workspace, 'conceptual-conflict-report', {
          agent_id: body.agent_id,
          conflicts_found: conflicts.length,
        });
        writeJson(response, 200, {
          status: 'reported',
          workspace: body.workspace,
          agent_id: body.agent_id,
          other_agents_considered: others.length,
          substrate: substrateInfo,
          conflicts,
        });
        return;
      }

      // P6 work-partitioner (§1.5 SPEC-COORDINATION-FABRIC-V2) over HTTP, for
      // cross-machine orchestrators that can't reach the MCP tool directly.
      // Same handler path as server.ts's `plan_parallel_work` tool: load the
      // CAS best-effort for `path` (blast-radius expansion + intent
      // inference), call the pure `partitionTasks`, return the same
      // PartitionResult shape plus a human-readable `summary`.
      if (request.method === 'POST' && route === '/v1/coordination/plan-parallel-work') {
        const body = await readJsonBody<{
          tasks: PartitionTask[]; path?: string; include_blast_radius?: boolean;
        }>(request, maxBodyBytes);
        if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
          writeJson(response, 400, { status: 'error', error: 'tasks (non-empty array) is required' });
          return;
        }
        // Shape-validate before handing tasks to partitionTasks: it (via
        // inferFootprintFromIntent) calls `.match` directly on each task's
        // `intent` with no guard, so a wrong field name (e.g. `description`
        // instead of `intent`) previously reached that call as `undefined`
        // and crashed with a raw, unhelpful
        // "Cannot read properties of undefined (reading 'match')" 500. The
        // MCP tool surface (server.ts `plan_parallel_work`) gets this check
        // for free from its zod schema; this HTTP route has no schema layer,
        // so it needs the same guard by hand.
        const shapeErrors: string[] = [];
        (body.tasks as unknown[]).forEach((t, i) => {
          if (!t || typeof t !== 'object') {
            shapeErrors.push(`tasks[${i}] must be an object with fields { id, intent, target_symbols?, target_paths?, flow_id?, capability_id? }`);
            return;
          }
          const task = t as Record<string, unknown>;
          if (typeof task.id !== 'string' || task.id.length === 0) {
            shapeErrors.push(`tasks[${i}].id must be a non-empty string`);
          }
          if (typeof task.intent !== 'string' || task.intent.length === 0) {
            shapeErrors.push(`tasks[${i}].intent must be a non-empty string (free-text description of the task's work — did you mean to send this as \`intent\` instead of \`description\`?)`);
          }
          if (task.target_symbols !== undefined && !Array.isArray(task.target_symbols)) {
            shapeErrors.push(`tasks[${i}].target_symbols, if present, must be an array of strings`);
          }
          if (task.target_paths !== undefined && !Array.isArray(task.target_paths)) {
            shapeErrors.push(`tasks[${i}].target_paths, if present, must be an array of strings`);
          }
        });
        if (shapeErrors.length > 0) {
          writeJson(response, 400, {
            status: 'error',
            error: 'Invalid task shape. Expected fields per task: id (string), intent (string), target_symbols? (string[]), target_paths? (string[]), flow_id? (string), capability_id? (string).',
            details: shapeErrors,
          });
          return;
        }
        const cas = body.path ? await partitionCasForPathHttp(body.path) : { nodes: [], edges: [] };
        const includeBlastRadius = body.include_blast_radius ?? true;
        const result = partitionTasks(body.tasks, cas, { includeBlastRadius });

        const batchSummaries = result.batches.map(
          (b) => `batch ${b.batch_index + 1} runs [${b.task_ids.join(', ')}] in parallel`
        );
        const summary = `${body.tasks.length} tasks -> ${result.batches.length} parallel batch${result.batches.length === 1 ? '' : 'es'}, factor ${result.parallelism_factor.toFixed(2)}; ${batchSummaries.join('; ')}`;

        writeJson(response, 200, {
          ...result,
          summary,
          fidelity_note: body.path
            ? undefined
            : 'No `path` supplied: partitioned on declared target_symbols/target_paths only — no CAS blast-radius expansion, no intent inference. Pass `path` for full fidelity.',
        });
        return;
      }

      // POST /v1/coordination/intent-merge — cross-machine mirror of
      // server.ts's `plan_intent_merge` MCP tool (git-ambient path only: this
      // process has no checkout of the caller's repo, so there is no ambient
      // diff to capture here — same honest reduction the
      // conceptual-conflicts route above already makes). Reconciles by INTENT
      // rather than textual diff: reuses the SAME persisted
      // `__conceptual__` claim-log state that
      // /v1/coordination/conceptual-conflicts populates (via
      // otherAgentConceptualStatesHttp), so callers should report their
      // changes there at least once before calling this. Explicit `states` in
      // the body bypasses the persisted-state lookup entirely, matching the
      // MCP tool's own `states` override.
      if (request.method === 'POST' && route === '/v1/coordination/intent-merge') {
        const body = await readJsonBody<{
          workspace: string; agent_id: string; states?: AgentInFlightState[];
        }>(request, maxBodyBytes);
        if (!body.workspace || !body.agent_id) {
          writeJson(response, 400, { status: 'error', error: 'workspace and agent_id are required' });
          return;
        }
        const explicitStates = Array.isArray(body.states) && body.states.length > 0;
        const cas = await conceptualConflictCasForWorkspaceHttp(body.workspace);
        const planStates: AgentInFlightState[] = explicitStates
          ? (body.states as AgentInFlightState[])
          : await otherAgentConceptualStatesHttp(body.workspace, body.agent_id);
        const plan: MergePlan = planIntentMerge(planStates, cas);
        writeJson(response, 200, {
          workspace: body.workspace,
          attribution_source: 'git-ambient',
          agents_considered: [...new Set(planStates.map((s) => s.agent_id))],
          plan,
          note: planStates.length === 0
            ? 'No agent states found (none passed explicitly, none persisted for this workspace). Call /v1/coordination/conceptual-conflicts first, or pass `states` explicitly.'
            : undefined,
        });
        return;
      }

      // §WS-B in-flight publish — persists the latest (workspace, agent_id)
      // in-flight snapshot, tenant-gated (§WS-F) and audited. Mirrors the
      // /v1/coordination/claim handler's shape: read body -> authz -> persist
      // -> audit -> respond `{status:'success'}`. Storage is a sibling
      // append-only log (`in-flight.jsonl`) alongside `claims.jsonl` in the
      // same per-workspace coordination store dir, read back reduced to
      // latest-per-(workspace,agent_id) the same way /coordination/state
      // reduces claims.jsonl to the active set.
      //
      // `changes` (optional, Fabric-v2 §1.7 cross-machine ambient capture):
      // the same `SymbolChange[]` shape as same-machine `InFlightSnapshot.changes`
      // (types.ts), produced client-side by `in-flight-capture.ts`'s
      // `captureInFlightChanges` and already redacted once by the publishing
      // client (`in-flight-sync.ts`'s `publishInFlight`, via
      // `redactInFlightChanges`). The server applies the SAME redaction gate
      // again here as defense-in-depth (§WS-F hard gate: security must not
      // depend solely on a well-behaved client) — using only the built-in
      // secret-pattern deny-list (`defaultSecretDenyPatterns`), since the
      // server has no checkout of the project to read a `.klauroignore` from;
      // the client-side pass already applied `.klauroignore` on top of that.
      if (request.method === 'POST' && route === '/v1/coordination/in-flight') {
        const body = await readJsonBody<{
          workspace: string; agent_id: string; org_id?: string;
          base_commit?: string; branch?: string; diff_context: string;
          changes?: SymbolChange[];
        }>(request, maxBodyBytes);
        if (!body.workspace || !body.agent_id) {
          writeJson(response, 400, { status: 'error', error: 'workspace and agent_id are required' });
          return;
        }
        // Derive the requester's claimed tenant from the authenticated
        // clientId plus the body's own org scoping (this deployment's
        // AccountStore has no separate org tier yet — workspace is the
        // tenancy boundary — so the requester is "whatever org/workspace the
        // authenticated caller asserts", exactly like /v1/coordination/claim
        // today). assertSameTenant still enforces that a snapshot published
        // under one org_id cannot be silently read/overwritten by a request
        // asserting a different org_id for the same workspace.
        const requesterIdentity = { org_id: body.org_id, workspace_id: body.workspace };
        try {
          assertSameTenant({ org_id: body.org_id, workspace_id: body.workspace }, requesterIdentity);
        } catch (err) {
          if (err instanceof TenantMismatchError) {
            writeJson(response, 403, { status: 'error', error: err.message });
            return;
          }
          throw err;
        }

        let redactedChanges: SymbolChange[] | undefined;
        let droppedChangeCount = 0;
        if (Array.isArray(body.changes) && body.changes.length > 0) {
          const { kept, dropped } = redactInFlightChanges(body.changes, {
            secretPatterns: defaultSecretDenyPatterns(),
            ignorePatterns: [],
          });
          redactedChanges = kept;
          droppedChangeCount = dropped.length;
        }

        const snapshot: InFlightSnapshotRecord = {
          workspace: body.workspace,
          agent_id: body.agent_id,
          org_id: body.org_id,
          base_commit: body.base_commit || '',
          branch: body.branch,
          diff_context: body.diff_context,
          updated_at: new Date().toISOString(),
          ...(redactedChanges !== undefined ? { changes: redactedChanges } : {}),
        };
        await appendInFlightSnapshot(body.workspace, snapshot);
        broadcastCoordinationEvent(body.workspace, 'in-flight', {
          agent_id: snapshot.agent_id,
          base_commit: snapshot.base_commit,
          branch: snapshot.branch,
          updated_at: snapshot.updated_at,
          changes_count: redactedChanges?.length,
        });
        await appendSecurityAudit(getSecurityStoreDir(body.workspace), {
          ts: snapshot.updated_at,
          actor: body.agent_id,
          action: 'publish_in_flight',
          workspace: body.workspace,
          scope: body.org_id ? `org:${body.org_id}` : 'org:(none)',
        });
        await appendAuditLog(dataDir, {
          event: 'coordination_in_flight',
          workspace: body.workspace,
          agent_id: body.agent_id,
          bytes: body.diff_context.length,
          changes_kept: redactedChanges?.length ?? 0,
          changes_dropped: droppedChangeCount,
        });
        writeJson(response, 200, { status: 'success' });
        return;
      }

      if (request.method === 'POST' && route === '/v1/telemetry/ingest') {
        const body = await readJsonBody<{ workspace: string; spans: any[]; window?: string }>(request, maxBodyBytes);
        if (!body.workspace || !Array.isArray(body.spans)) {
          writeJson(response, 400, { status: 'error', error: 'workspace and spans[] are required' });
          return;
        }
        const cas = await getAnalysis(body.workspace);
        const result = await ingestAndPersist(dataDir, body.workspace, cas, body.spans, { window: body.window });
        await appendAuditLog(dataDir, {
          event: 'telemetry_ingest',
          workspace: body.workspace,
          matched: result.facts.length,
          unmatched: result.unmatched.length,
          total_facts: result.total_facts,
        });
        writeJson(response, 200, { status: 'success', ...result });
        return;
      }

      // ---------------------------------------------------------------------
      // Telemetry read-back (dogfood surface). The deployed service only ever
      // ACCEPTED telemetry (POST .../ingest, POST .../runtime-events); nothing
      // let an agent read its own runtime observations back over HTTP. These
      // two GETs close that loop so `get_runtime_observations`-style data is
      // reachable from any HTTP client keyed only on the workspace path.
      //
      // Read-only, same auth as the sibling coordination/telemetry routes
      // (already gated above by authorizeAnalyzerRequest). Best-effort CAS:
      // observations are stored keyed by project path and do NOT require an
      // analysis to read — a missing/unreadable CAS degrades gracefully rather
      // than 500ing.
      // ---------------------------------------------------------------------
      if (request.method === 'GET' && route === '/v1/telemetry/observations') {
        const workspace = requestUrl.searchParams.get('workspace') || '';
        if (!workspace) {
          writeJson(response, 400, { status: 'error', error: 'workspace query param is required' });
          return;
        }
        const limitParam = requestUrl.searchParams.get('limit');
        const limit = limitParam ? Number(limitParam) : undefined;
        const traceId = requestUrl.searchParams.get('trace_id') || undefined;
        const loadObservations = () => loadTelemetryObservations(workspace, {
          source: 'ingested',
          ...(traceId ? { traceId } : {}),
          ...(limit && Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        });
        let set = await loadObservations();
        // Lazy self-heal (mirrors MCP get_runtime_observations): if the loaded
        // set still carries pre-analysis `unmatched` observations and a CAS now
        // exists for this workspace, re-correlate + upgrade them so HTTP reads
        // populate node-level metrics too. Best-effort, non-blocking, idempotent.
        try {
          const hasUnmatched = (set.observations || []).some(
            (observation: any) => observation?.correlation?.status === 'unmatched');
          if (hasUnmatched) {
            const cas = await getAnalysis(workspace).catch(() => null);
            if (cas) {
              const backfill = await backfillIngestedTelemetry(cas, workspace).catch(() => null);
              if (backfill && backfill.upgraded > 0) set = await loadObservations();
            }
          }
        } catch {
          /* self-heal is best-effort — never fail the read */
        }
        // Surface any fused runtime facts persisted via /v1/telemetry/ingest for
        // the same workspace, additive — mirrors the MCP get_runtime_observations
        // shape so this HTTP read is a faithful stand-in.
        const fused = await loadPersistedRuntimeFacts(dataDir, workspace).catch(() => null);
        // Raw per-route+method traffic/latency, aggregated CAS-free so it is
        // visible even before the workspace has any analysis. Additive.
        const routeMetrics = summarizeRouteMetrics(set.observations || []);
        writeJson(response, 200, {
          status: 'success',
          workspace,
          ...set,
          route_metrics: routeMetrics,
          route_metrics_guidance:
            'Per route+method request_count/error_rate/p50/p95/p99 aggregated from raw observations. Available with or without an analysis; correlate to CAS via /v1/telemetry/node-metrics once the workspace is analyzed.',
          ...(fused?.facts?.length ? { fused_runtime_facts: fused.facts, fused_updated_at: fused.updated_at } : {}),
        });
        return;
      }

      // CAS read surfaces — HTTP/API parity with the MCP reads. Each wraps the
      // SAME query builder as its MCP tool + CLI subcommand (no logic fork), so
      // all three channels return identical data for a given analyzed workspace.
      if (request.method === 'GET' && route === '/v1/orient') {
        const workspace = requestUrl.searchParams.get('workspace') || '';
        if (!workspace) {
          writeJson(response, 400, { status: 'error', error: 'workspace query param is required' });
          return;
        }
        const cas = await getAnalysis(workspace).catch(() => null);
        if (!cas) {
          writeJson(response, 200, { status: 'success', workspace, note: 'no analysis for workspace' });
          return;
        }
        writeJson(response, 200, { status: 'success', workspace, ...buildOrientCapsule(cas) });
        return;
      }

      if (request.method === 'GET' && route === '/v1/cicd') {
        const workspace = requestUrl.searchParams.get('workspace') || '';
        if (!workspace) {
          writeJson(response, 400, { status: 'error', error: 'workspace query param is required' });
          return;
        }
        const cas = await getAnalysis(workspace).catch(() => null);
        if (!cas) {
          writeJson(response, 200, { status: 'success', workspace, note: 'no analysis for workspace', pipelines: [] });
          return;
        }
        const limitParam = requestUrl.searchParams.get('limit');
        const offsetParam = requestUrl.searchParams.get('offset');
        const result = getCicdPipelines(cas, {
          provider: requestUrl.searchParams.get('provider') || undefined,
          deployOnly: requestUrl.searchParams.get('deploy_only') === 'true',
          limit: limitParam ? Number(limitParam) : undefined,
          offset: offsetParam ? Number(offsetParam) : undefined,
        });
        writeJson(response, 200, { status: 'success', workspace, ...result });
        return;
      }

      if (request.method === 'GET' && route === '/v1/communication-seams') {
        const workspace = requestUrl.searchParams.get('workspace') || '';
        if (!workspace) {
          writeJson(response, 400, { status: 'error', error: 'workspace query param is required' });
          return;
        }
        const cas = await getAnalysis(workspace).catch(() => null);
        if (!cas) {
          writeJson(response, 200, { status: 'success', workspace, note: 'no analysis for workspace', seams: [] });
          return;
        }
        const limitParam = requestUrl.searchParams.get('limit');
        const offsetParam = requestUrl.searchParams.get('offset');
        const result = getCommunicationSeams(cas, {
          modality: (requestUrl.searchParams.get('modality') as any) || undefined,
          level: (requestUrl.searchParams.get('level') as any) || undefined,
          limit: limitParam ? Number(limitParam) : undefined,
          offset: offsetParam ? Number(offsetParam) : undefined,
        });
        writeJson(response, 200, { status: 'success', workspace, ...result });
        return;
      }

      if (request.method === 'GET' && route === '/v1/product-map') {
        const workspace = requestUrl.searchParams.get('workspace') || '';
        if (!workspace) {
          writeJson(response, 400, { status: 'error', error: 'workspace query param is required' });
          return;
        }
        const cas = await getAnalysis(workspace).catch(() => null);
        if (!cas) {
          writeJson(response, 200, { status: 'success', workspace, note: 'no analysis for workspace' });
          return;
        }
        const result = getProductMap(cas, { section: requestUrl.searchParams.get('section') || undefined });
        writeJson(response, 200, { status: 'success', workspace, ...result });
        return;
      }

      if (request.method === 'GET' && route === '/v1/telemetry/node-metrics') {
        const workspace = requestUrl.searchParams.get('workspace') || '';
        if (!workspace) {
          writeJson(response, 400, { status: 'error', error: 'workspace query param is required' });
          return;
        }
        const loadObservations = () =>
          loadTelemetryObservations(workspace, { source: 'ingested', limit: 5000 });
        let set = await loadObservations();
        let cas: any = null;
        try {
          cas = await getAnalysis(workspace);
        } catch {
          cas = null;
        }
        if (!cas) {
          writeJson(response, 200, { status: 'success', workspace, node_metrics: [], note: 'no analysis for workspace' });
          return;
        }
        // Lazy self-heal: raw observations ingested pre-analysis land `unmatched`
        // and never correlate to a CAS node, so node_metrics read empty. Now that
        // a CAS exists, re-correlate + upgrade them here so the node-metrics read
        // populates on demand (this is what makes VPS self-telemetry node-metrics
        // fill in on read). Best-effort, idempotent; reload to reflect upgrades.
        try {
          const hasUnmatched = (set.observations || []).some(
            (observation: any) => observation?.correlation?.status === 'unmatched');
          if (hasUnmatched) {
            const backfill = await backfillIngestedTelemetry(cas, workspace).catch(() => null);
            if (backfill && backfill.upgraded > 0) set = await loadObservations();
          }
        } catch {
          /* self-heal is best-effort — never fail the read */
        }
        const nodeMetrics = buildNodeRuntimeMetrics(cas, set.observations || []);
        writeJson(response, 200, {
          status: 'success',
          workspace,
          observation_count: set.observations?.length ?? 0,
          node_metrics: nodeMetrics,
          node_metrics_guidance:
            'Per-node traffic/error-rate/latency correlated to CAS static_id. Use static_id as the target for get_coding_context before editing a hot or erroring node.',
        });
        return;
      }

      writeJson(response, 404, { status: 'error', error: 'Not found' });
    } catch (error) {
      if (error instanceof AccountHttpError) {
        writeJson(response, error.statusCode, { status: 'error', error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, 500, { status: 'error', error: message });
    }
  };

  // instrumentHttpHandler returns requestHandler UNCHANGED when the gate is
  // unset (zero wrapping / zero overhead); wraps it with SDK request
  // instrumentation only when KLAURO_SELF_TELEMETRY is truthy.
  return http.createServer(instrumentHttpHandler(requestHandler));
}

/**
 * §1.7 SPEC-COORDINATION-FABRIC-V2 helpers for `/v1/coordination/conceptual-conflicts`,
 * mirroring server.ts's MCP-side `check_conceptual_conflicts` wiring exactly
 * (same `__conceptual__` marker technique, same claim log, same pure
 * detector). See server.ts's `reportConceptualChanges` doc comment for the
 * full honest-design writeup (agent-reported, not ambient — the live claim
 * log/InFlightSnapshot don't carry per-symbol before/after shape).
 */
const CONCEPTUAL_CLAIM_TTL_MS_HTTP = 30 * 60 * 1000;

interface ConceptualMarkerHttp {
  __conceptual__: { intent: string; changes: SymbolChange[]; reported_at: string };
}

function conceptualClaimIdHttp(workspaceId: string, agentId: string): string {
  return `conceptual:${workspaceId}:${agentId}`;
}

function decodeConceptualMarkerHttp(intent: string): ConceptualMarkerHttp['__conceptual__'] | undefined {
  try {
    const parsed = JSON.parse(intent);
    if (parsed && typeof parsed === 'object' && parsed.__conceptual__) {
      return parsed.__conceptual__ as ConceptualMarkerHttp['__conceptual__'];
    }
  } catch {
    // not a conceptual-conflict report; ignore.
  }
  return undefined;
}

async function reportConceptualChangesHttp(
  workspace: string,
  agentId: string,
  agentKind: AgentKind,
  intent: string,
  changes: SymbolChange[]
): Promise<void> {
  const now = new Date().toISOString();
  await appendClaim(workspace, {
    claim_id: conceptualClaimIdHttp(workspace, agentId),
    workspace_id: workspace,
    agent_id: agentId,
    agent_kind: agentKind,
    scope: { repo: workspace, paths: [], symbols: changes.map((c) => c.symbol_id) },
    intent: JSON.stringify({ __conceptual__: { intent, changes, reported_at: now } } satisfies ConceptualMarkerHttp),
    status: 'active',
    created_at: now,
    ttl_ms: CONCEPTUAL_CLAIM_TTL_MS_HTTP,
    heartbeat_at: now,
  });
}

async function otherAgentConceptualStatesHttp(workspace: string, excludeAgentId: string): Promise<AgentInFlightState[]> {
  const log = await readClaimLog(workspace);
  const active = deriveActiveClaims(log, Date.now()).filter((c) => c.workspace_id === workspace);
  const states: AgentInFlightState[] = [];
  for (const claim of active) {
    if (claim.agent_id === excludeAgentId) continue;
    const marker = decodeConceptualMarkerHttp(claim.intent);
    if (!marker) continue;
    states.push({ agent_id: claim.agent_id, intent: marker.intent, changes: marker.changes });
  }
  return states;
}

async function conceptualConflictCasForWorkspaceHttp(workspace: string): Promise<ConflictCas> {
  try {
    const cas = await getAnalysis(workspace);
    return {
      nodes: (cas.nodes || []).map((n: any) => ({ id: n.id, name: n.name })),
      edges: (cas.edges || [])
        .filter((e: any) => e.type === 'calls')
        .map((e: any) => ({ source: e.source, target: e.target, type: e.type })),
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

/** Cross-machine mirror of server.ts's `partitionCasForPath` — same shape,
 *  same tolerance for `path` not resolving to an analyzable project. */
async function partitionCasForPathHttp(path: string): Promise<PartitionCas> {
  try {
    const cas = await getAnalysis(path);
    const files = new Set<string>();
    for (const n of (cas.nodes || []) as any[]) {
      const f = n?.source?.file;
      if (typeof f === 'string' && f.length > 0) files.add(f);
    }
    return {
      nodes: (cas.nodes || []).map((n: any) => ({ id: n.id, name: n.name })),
      edges: (cas.edges || [])
        .filter((e: any) => e.type === 'calls')
        .map((e: any) => ({ source: e.source, target: e.target, type: e.type })),
      files: [...files],
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

/**
 * Best-effort CAS edges for blast-radius arbitration (§WS-C). `workspace` may
 * not be an analyzable project path in every deployment, so failures fall
 * back to an empty edge set rather than rejecting the coordination request.
 */
async function casEdgesForWorkspace(workspace: string): Promise<Array<{ id: string; source: string; target: string; type: string }>> {
  try {
    const cas = await getAnalysis(workspace);
    return (cas.edges || []).map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: edge.type }));
  } catch {
    return [];
  }
}

/**
 * Awareness-rich holder context for a conflicting/held grant (§1.6
 * SPEC-COORDINATION-FABRIC-V2 — "awareness is the primitive"), mirroring the
 * same helper in server.ts so cross-machine/HTTP callers get the same
 * holder id + intent + lease-staleness signal MCP callers get. Reads the raw
 * claim log rather than grant-manager internals, decoding the `__grant__`
 * JSON marker locally so this stays a read-only, additive projection.
 */
interface GrantHolderContext {
  agent_id: string;
  intent: string;
  granted_at: string;
  lease_expires_at: string;
  lease_status: 'active' | 'near_expiry' | 'expired';
}

async function describeGrantHolders(
  workspace: string,
  agentIds: string[]
): Promise<Record<string, GrantHolderContext>> {
  if (agentIds.length === 0) return {};
  const wanted = new Set(agentIds);
  const active = await getActiveClaims(workspace);
  const out: Record<string, GrantHolderContext> = {};
  const nowMs = Date.now();
  for (const claim of active) {
    if (!wanted.has(claim.agent_id) || out[claim.agent_id]) continue;
    let markerIntent: string | undefined;
    try {
      const parsed = JSON.parse(claim.intent);
      if (parsed && typeof parsed === 'object' && parsed.__grant__?.kind === 'granted') {
        markerIntent = parsed.__grant__.intent;
      }
    } catch {
      // not a grant-manager claim; skip.
    }
    if (markerIntent === undefined) continue;
    const leaseMs = Date.parse(claim.heartbeat_at) + claim.ttl_ms;
    const remainingMs = leaseMs - nowMs;
    out[claim.agent_id] = {
      agent_id: claim.agent_id,
      intent: markerIntent,
      granted_at: claim.created_at,
      lease_expires_at: new Date(leaseMs).toISOString(),
      lease_status: remainingMs <= 0 ? 'expired' : remainingMs < 30_000 ? 'near_expiry' : 'active',
    };
  }
  return out;
}

/** Only a real authenticated account yields a salt for makeAnalysisId's fallback hash — shared-token/anonymous callers have no per-account keyspace to collapse into. */
function accountSaltFor(clientId: string | undefined): string | undefined {
  return clientId && clientId.startsWith('user:') ? clientId : undefined;
}

/** Keep tenant-salted storage keys private while preserving a stable client
 * handle. Authenticated callers address the same raw handle on every request;
 * the server deterministically maps it into that caller's isolated keyspace. */
function clientVisibleAnalysisId(requestedId: string, storageId: string, clientId: string | undefined): string {
  return clientId?.startsWith('user:') && storageId.startsWith('acct_')
    ? requestedId
    : storageId;
}

async function resolveAuthorizedAnalysisReadId(
  accounts: AccountStore,
  clientId: string | undefined,
  requestedId: string,
): Promise<string | null> {
  if (!clientId?.startsWith('user:')) {
    return resolveStorageAnalysisId(requestedId, accountSaltFor(clientId));
  }
  if (requestedId.startsWith('acct_')) return null;
  if (requestedId.startsWith('prj_')) {
    const userId = clientId.slice('user:'.length);
    try {
      const project = await accounts.getProjectForUser(userId, requestedId);
      if (!project) return null;
    } catch {
      return null;
    }
  }
  return resolveStorageAnalysisId(requestedId, clientId);
}

/** Shared rejection-reason classification so /v1/coordination/* and /api/* report the same cause for the same failure. */
export type AuthRejectReason = 'no_token' | 'not_recognized';

export function authRejectMessage(reason: AuthRejectReason, surface: 'coordination' | 'api'): string {
  const what = surface === 'coordination' ? 'remote analyzer' : 'account API';
  if (reason === 'no_token') {
    return `Unauthorized ${what} request: no Bearer token was presented. Run \`klauro login\` (or set KLAURO_ANALYZER_TOKEN) and retry.`;
  }
  return `Unauthorized ${what} request: the Bearer token was not recognized. This means EITHER it expired (session TTL is 14 days — run \`klauro login\` to refresh), OR the session was dropped by a server-side account-store issue unrelated to anything you did — retry once; if it recurs, re-run \`klauro login\` to mint a fresh session.`;
}

async function authorizeAnalyzerRequest(accounts: AccountStore, request: http.IncomingMessage, sharedToken: string | undefined): Promise<{ authorized: boolean; clientId?: string; reason?: AuthRejectReason }> {
  const token = bearerToken(request);
  if (sharedToken && token && token === sharedToken) return { authorized: true, clientId: 'shared-token' };
  // Must attempt account auth even with no shared token configured, or every
  // push looks anonymous and can never attach to the pushing user's project.
  if (token) {
    const user = await accounts.authenticate(token);
    if (user) return { authorized: true, clientId: `user:${user.id}` };
  }
  if (!sharedToken) return { authorized: true, clientId: request.socket.remoteAddress || 'anonymous' };
  return { authorized: false, reason: token ? 'not_recognized' : 'no_token' };
}

async function authorizeAccountApiRequest(accounts: AccountStore, request: http.IncomingMessage, sharedToken: string | undefined): Promise<{ authorized: boolean; userId: string; sharedToken?: boolean; reason?: AuthRejectReason }> {
  const token = bearerToken(request);
  if (sharedToken && token && token === sharedToken) {
    return { authorized: true, userId: 'shared-token', sharedToken: true };
  }
  const user = await accounts.authenticate(token);
  if (user) return { authorized: true, userId: user.id };
  return { authorized: false, userId: '', reason: token ? 'not_recognized' : 'no_token' };
}

/** Same collapsed-404 message every membership-gated read path already uses
 * (see /api/projects/:id and friends) — never distinguishes "no such
 * project" from "not a member" so a write attempt can't be used to probe for
 * the existence of a project in someone else's workspace. */
const PROJECT_WRITE_DENIED_MESSAGE =
  'Project not found, or your account is not a member of its workspace. Verify the project_id and that you are signed in to the account that owns it.';

/**
 * Server-side membership gate for every write path that persists data under
 * a client-supplied project/analysis id (`/v1/analyze`, `/v1/analyze-diff`,
 * `/v1/sync`, `/v1/enrich-element`).
 *
 * WHY THIS EXISTS: `resolveStorageAnalysisId` passes `prj_...` ids through
 * UNCHANGED (see its own doc comment — "already globally unique +
 * auth-checked"), but nothing upstream of it actually checked that the
 * CALLING account is a member of the workspace that owns that project id.
 * Before this gate, any authenticated (or even anonymous, since the
 * pass-through does not consult clientId at all) caller who sent a
 * well-formed `prj_...` id got `workspacePath(dataDir, thatId)` handed back
 * as their write target verbatim — for `/v1/analyze` that includes an
 * unconditional `fs.remove(workspace)` before the re-write, so a guessed or
 * observed foreign project id was not just readable, it was overwritable.
 * `linkAnalysisToAccountProject` (below) already enforced membership before
 * attaching the write to an ACCOUNT RECORD, but that runs after the bytes
 * already landed on disk and only gates the account's pointer to the
 * analysis, not the underlying storage write itself. This closes that gap by
 * checking membership BEFORE any write happens, using the same
 * `getProjectForUser` primitive the read paths already trust (see
 * `resolveAuthorizedAnalysisReadId` above and the /api/projects/:id family).
 *
 * Anonymous/shared-token callers (`clientId` not `user:...`) can never write
 * under a `prj_` id — there is no account identity to check membership
 * against, so denying is the only safe answer. The deploy smoke
 * (analysis-smoke.mjs) never reaches this: it calls the analyzer in-process,
 * not over HTTP. Non-`prj_` ids (bare path hashes) are unaffected by this
 * gate — `resolveStorageAnalysisId` already folds those into the caller's
 * own `acct_` keyspace before they ever reach disk, which is the pre-existing
 * fix for the 2026-07-06 cross-tenant bleed (see
 * remote-analyzer-tenant-isolation.test.ts) and remains sufficient on its
 * own; only the `prj_` pass-through case was unguarded.
 */
async function authorizeProjectWrite(accounts: AccountStore, clientId: string | undefined, projectId: string | undefined): Promise<boolean> {
  if (!projectId || !/^prj_/.test(projectId)) return true;
  if (!clientId?.startsWith('user:')) return false;
  const userId = clientId.slice('user:'.length);
  try {
    const project = await accounts.getProjectForUser(userId, projectId);
    return Boolean(project);
  } catch {
    return false;
  }
}

/**
 * §THE-SEAM fix — evidence-gated attach of a landed `/v1/analyze` push to the
 * account project record it belongs to. Without this, `AccountStore.
 * setProjectAnalysisId` is only ever called at project *creation* (the
 * `klauro init` reconnect flow) — every subsequent CLI push just re-analyzes
 * into `workspacePath(analysis_id)` with no link back, so the web app shows
 * "Analysis: Not run" forever even though pushes are succeeding.
 *
 * Evidence-gated, never a guess:
 *  - `clientId` must be a real authenticated user (`user:<id>` from
 *    authorizeAnalyzerRequest) — an anonymous/shared-token push has no
 *    resolvable membership, so it is never attached to anyone's project.
 *  - Primary path: `projectId` looks like an AccountStore project id
 *    (`prj_...`) — the CLI sends this once `.klaurorc` is bound to a project
 *    (see remote-sync-client.ts resolveAnalysisId). Attach directly.
 *  - Fallback path: `projectId` is a bare analysisId (sha256 of the local
 *    path — unbound repo, no `.klaurorc` project binding yet). Look up the
 *    pushed snapshot's git remote against every project the user can access
 *    (AccountStore.findProjectsByRepoUrlForUser); attach ONLY when exactly
 *    one project matches. Zero matches (no such project) or more than one
 *    (ambiguous — e.g. a forked/mirrored remote shared by two projects)
 *    both mean "do not attach," logged with the reason.
 *  - `setProjectAnalysisId` itself re-checks workspace membership
 *    (`requireMembership`) — a project id from a different user's workspace
 *    throws 404, which is caught and logged, never attached.
 *
 * Never throws: analysis already landed and was already written to disk by
 * the time this runs, so a linking failure must never fail the response.
 */
async function linkAnalysisToAccountProject(
  accounts: AccountStore,
  clientId: string | undefined,
  projectId: string | undefined,
  analysisId: string | undefined,
  gitRemote: string | undefined,
  repoFacts?: RepoFacts,
): Promise<void> {
  if (!analysisId) return;
  if (!clientId || !clientId.startsWith('user:')) {
    // Anonymous / shared-token push: no user identity to check membership
    // against, so there is nothing safe to attach — log why, never guess.
    console.error(`[Klauro] skip analysis attach: push was not from an authenticated user (clientId=${clientId ?? 'none'})`);
    return;
  }
  const userId = clientId.slice('user:'.length);

  if (projectId && /^prj_/.test(projectId)) {
    try {
      await accounts.setProjectAnalysisId(userId, projectId, analysisId);
      // Persist this push's client-derived repo_facts (if any) on the project
      // record — see AccountProject.repo_facts's doc comment. A later
      // server-side reanalyze (no client .git in reach) re-stamps the CAS
      // from this last-known value instead of dropping the keys.
      await accounts.setProjectRepoFacts(projectId, repoFacts);
    } catch (error) {
      // 404 (project/workspace not found or not a member) is the expected
      // shape of "ambiguous or foreign — do not attach"; log and move on.
      const detail = error instanceof AccountHttpError ? error.message : (error instanceof Error ? error.message : String(error));
      console.error(`[Klauro] skip analysis attach for project ${projectId} (user ${userId}): ${detail}`);
    }
    return;
  }

  // No `.klaurorc` project binding on this push (projectId is a bare
  // analysisId, or absent) — try the by-remote fallback, but only attach on
  // an unambiguous single match.
  if (!gitRemote) return;
  try {
    const matches = await accounts.findProjectsByRepoUrlForUser(userId, gitRemote);
    if (matches.length !== 1) {
      if (matches.length > 1) {
        console.error(`[Klauro] skip analysis attach by remote "${gitRemote}" (user ${userId}): ${matches.length} projects share this remote — ambiguous, not attaching.`);
      }
      return; // 0 matches: no project for this remote — nothing to attach.
    }
    await accounts.setProjectAnalysisId(userId, matches[0].id, analysisId);
    await accounts.setProjectRepoFacts(matches[0].id, repoFacts);
  } catch (error) {
    const detail = error instanceof AccountHttpError ? error.message : (error instanceof Error ? error.message : String(error));
    console.error(`[Klauro] skip analysis attach by remote "${gitRemote}" (user ${userId}): ${detail}`);
  }
}

/**
 * Response cache for the pure-function-of-the-stored-CAS read endpoints
 * (/conceptual, /semantic-coverage). See response-cache.ts for the honesty
 * invariant (cached body byte-identical to fresh compute) and the whale-CAS
 * starvation rationale (TASK: Cloudflare 524s during re-analysis). Few
 * entries: payloads are ~100KB and only actively-viewed projects benefit.
 */
const casReadResponseCache = new ResponseCache(8);

/**
 * /conceptual flow-page sizing (P0 rank-before-truncate).
 *
 * MEASURED, not guessed: with the compact projection this route already
 * applies (facet_provenance + step code_mappings stripped), a RANKED page
 * costs ~6-11 KB per flow on real stored CASes, against ~2.4-3.4 KB for the
 * old significance-blind window — because a ranked page carries DEEP flows
 * instead of 1-step leaves. That is the whole point of the fix, and it is why
 * the numbers below come from measurement:
 *   - the jump in payload comes from RANKING, not from page size: at the OLD
 *     default of 20 a ranked page is already ~128-228 KB, and going 20 -> 25
 *     adds only ~18-21% for 25% more flows, while per-flow cost keeps falling
 *     as the page extends into shallower flows. 25 is where the marginal flow
 *     is still substantive;
 *   - the 100 ceiling bounds a single page's compute/transfer footprint
 *     WITHOUT bounding what is reachable, because `offset` now pages through
 *     the full ranked set. The old "max 50" hint advertised a remedy capped at
 *     the same number as the complaint; the remedy is now offset.
 */
const CONCEPTUAL_DEFAULT_MAX_FLOWS = 25;
const CONCEPTUAL_MAX_FLOWS_CEILING = 100;
/**
 * DEFECT (measured live, three repos): this endpoint's `capabilities` never
 * carried a `description` at all — 0/5, 0/10, 0/13 capabilities described vs.
 * get_product_map's 5/5, 8/10, 13/13 on the exact SAME capability ids from
 * the exact same analysis. An agent using the conceptual surface (the one
 * the product's own orientation text points at) got named capabilities with
 * no explanation of what they do. get_product_map already computes
 * `description`/`description_source` at analysis time (product-map.ts); this
 * endpoint now surfaces the same fields rather than re-deriving them.
 *
 * Shipped by DEFAULT, not opt-in: capability/surface counts are small
 * (tens, not the hundreds that flows/nodes reach), so the added payload is
 * bounded even without a query flag. But this route carries NO
 * RESPONSE_BUDGET_BYTES enforcement at all (unlike the /query-routed MCP
 * tools — see response-budget.ts) and was separately measured large/slow on
 * a whale CAS, so each description is truncated to a short excerpt (same
 * technique as machine-gauntlet.ts's `description_excerpt`) — enough to
 * answer "what does this do," never enough to multiply payload size by
 * capability count.
 */
const CONCEPTUAL_DESCRIPTION_EXCERPT_CHARS = 280;

function conceptualDescriptionFields(item: { description?: string; description_source?: string }): {
  description?: string;
  description_source?: string;
} {
  if (!item.description) return {};
  return {
    description: item.description.length > CONCEPTUAL_DESCRIPTION_EXCERPT_CHARS
      ? `${item.description.slice(0, CONCEPTUAL_DESCRIPTION_EXCERPT_CHARS)}…`
      : item.description,
    description_source: item.description_source || 'deterministic',
  };
}

/** Test/ops probe: lets the endpoint tests assert deterministically that a
 * repeat GET was served from the cache (not merely byte-identical by luck). */
export function getCasReadResponseCacheStats(): { hits: number; misses: number; size: number } {
  return casReadResponseCache.stats;
}

/**
 * Version fingerprint of everything getAnalysis() folds into a read response:
 * the stored analysis file (rewritten by every saveAnalysis — each reanalyze
 * layer stamp included) plus the element-description store joined on by
 * applyStoredElementDescriptions. Null → caller must bypass the cache.
 */
async function storedAnalysisVersion(workspace: string): Promise<string | null> {
  const analysisFingerprint = await getAnalysisFileFingerprint(workspace);
  if (!analysisFingerprint) return null;
  let descriptions = 'none';
  try {
    const stat = await fs.stat(descriptionStorePath(workspace));
    descriptions = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // No description store yet — 'none' participates in the key so its later
    // appearance changes the fingerprint.
  }
  return `${analysisFingerprint}|${descriptions}`;
}

async function handleAccountApi(
  accounts: AccountStore,
  userId: string,
  route: string,
  request: http.IncomingMessage,
  maxBodyBytes: number,
  sharedToken = false,
  dataDir?: string,
  workspaceAnalyses?: AccountWorkspaceAnalysisScheduler,
): Promise<{
  statusCode: number;
  body: unknown;
  serializedBody?: string;
  stream?: { filePath: string; headers: Record<string, string | number> };
}> {
  if (request.method === 'GET' && route === '/api/me') {
    if (sharedToken) {
      return {
        statusCode: 200,
        body: {
          user: {
            id: 'shared-token',
            email: 'shared-token@klauro.local',
            name: 'Klauro Shared Analyzer Token',
          },
          entitlement: {
            status: 'active',
            plan: 'alpha-shared-analyzer',
            source: 'shared-analyzer-token',
          },
        },
      };
    }
    const user = await accounts.requireUser(bearerToken(request));
    return {
      statusCode: 200,
      body: {
        user,
        entitlement: {
          status: 'active',
          plan: 'alpha',
          source: 'account-store',
        },
      },
    };
  }

  // Change Activity feed for the Home frame: reverse-chronological events
  // across EVERY workspace this user belongs to. Built entirely from data
  // already persisted for other reasons (project revisions, reanalyze
  // attempt sidecars, the server-side workspace-level-CAS record) — see
  // collectAccountActivityEvents below — so an account with no analyses yet
  // honestly returns {events:[]}, never a fabricated placeholder.
  // §AUTH-LIFECYCLE — signed-in password change. Requires the current
  // password (see AccountStore.changePassword's doc comment) and is not
  // available on a shared-token request (there is no individual user
  // identity/password behind a shared analyzer token).
  if (request.method === 'POST' && route === '/api/auth/change-password') {
    if (sharedToken) throw new AccountHttpError(400, 'Password change is not available for shared-token requests');
    const body = await readJsonBody<{ current_password: string; new_password: string }>(request, maxBodyBytes);
    if (!body.current_password || !body.new_password) {
      throw new AccountHttpError(400, 'current_password and new_password are required');
    }
    const result = await accounts.changePassword(userId, bearerToken(request), {
      currentPassword: body.current_password,
      newPassword: body.new_password,
    });
    return { statusCode: 200, body: result };
  }

  if (request.method === 'GET' && route === '/api/account/activity') {
    if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
    const limit = clampActivityLimit(new URL(request.url || '', 'http://localhost').searchParams.get('limit'));
    const workspaces = await accounts.listWorkspaces(userId);
    const events: AccountActivityEvent[] = [];
    for (const workspace of workspaces) {
      const projects = await accounts.listProjects(userId, workspace.id);
      for (const project of projects) {
        events.push(...await collectProjectActivityEvents(dataDir, project, workspace.id));
      }
      events.push(...await collectWorkspaceActivityEvents(workspaceAnalyses, dataDir, workspace.id, workspace.name));
    }
    events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { statusCode: 200, body: { events: events.slice(0, limit), next_cursor: null } };
  }

  if (request.method === 'GET' && route === '/api/workspaces') {
    return { statusCode: 200, body: { workspaces: await accounts.listWorkspaces(userId) } };
  }

  if (request.method === 'POST' && route === '/api/workspaces') {
    const body = await readJsonBody<{ name: string }>(request, maxBodyBytes);
    return { statusCode: 201, body: { workspace: await accounts.createWorkspace(userId, body) } };
  }

  const workspaceUsersMatch = route.match(/^\/api\/workspaces\/([^/]+)\/users$/);
  if (workspaceUsersMatch) {
    const workspaceId = decodeURIComponent(workspaceUsersMatch[1]);
    if (request.method === 'GET') {
      return { statusCode: 200, body: { users: await accounts.listWorkspaceUsers(userId, workspaceId) } };
    }
    if (request.method === 'POST') {
      const body = await readJsonBody<{ email: string; role?: 'owner' | 'admin' | 'member' }>(request, maxBodyBytes);
      return { statusCode: 201, body: { membership: await accounts.addWorkspaceUser(userId, workspaceId, body) } };
    }
  }

  const workspaceProjectsMatch = route.match(/^\/api\/workspaces\/([^/]+)\/projects$/);
  if (workspaceProjectsMatch) {
    const workspaceId = decodeURIComponent(workspaceProjectsMatch[1]);
    if (request.method === 'GET') {
      return { statusCode: 200, body: { projects: await accounts.listProjects(userId, workspaceId) } };
    }
    if (request.method === 'POST') {
      // Same endpoint, two shapes: { project_id } attaches (moves) an EXISTING
      // project into this workspace; { name, ... } creates a brand-new one
      // (unchanged behavior). AccountProject.workspace_id is a single required
      // foreign key, not a join table, so "attach" here is necessarily a MOVE
      // out of whatever workspace the project previously belonged to — see
      // AccountStore.attachProjectToWorkspace for the membership gates.
      const body = await readJsonBody<{
        name?: string;
        repo_url?: string;
        local_path?: string;
        analysis_id?: string;
        project_id?: string;
      }>(request, maxBodyBytes);
      if (body.project_id) {
        const result = await accounts.attachProjectToWorkspace(userId, workspaceId, body.project_id);
        // Rebuild is scheduled through the SAME background path POST
        // /api/workspaces/{id}/reanalyze uses, for the target workspace (whose
        // membership just grew) and, since this is a move rather than an
        // additive attach, for the source workspace too (whose membership just
        // shrank and whose cached workspace-level CAS is now stale). Idempotent re-attach is a
        // true no-op: no workspace's membership changed, so nothing is scheduled.
        if (!result.already_attached) {
          scheduleWorkspaceReanalyze(workspaceAnalyses, dataDir, workspaceId);
          if (result.moved_from_workspace_id) scheduleWorkspaceReanalyze(workspaceAnalyses, dataDir, result.moved_from_workspace_id);
        }
        return {
          statusCode: 200,
          body: {
            attached: true,
            already_attached: result.already_attached,
            project: result.project,
            semantics: 'move',
            ...(result.moved_from_workspace_id ? { moved_from_workspace_id: result.moved_from_workspace_id } : {}),
            was_rebuild: result.already_attached ? 'unchanged' : 'scheduled',
          },
        };
      }
      if (!body.name) throw new AccountHttpError(400, 'name is required to create a new project');
      if (body.analysis_id?.startsWith('acct_') || body.analysis_id?.startsWith('prj_')) {
        throw new AccountHttpError(400, 'analysis_id must be the client analysis handle returned for this repository, not an internal storage or project id');
      }
      const storedBody = body.analysis_id
        ? { ...body, analysis_id: resolveStorageAnalysisId(body.analysis_id, `user:${userId}`) }
        : body;
      const project = await accounts.createProject(
        userId,
        workspaceId,
        storedBody as { name: string; repo_url?: string; local_path?: string; analysis_id?: string },
      );
      // Membership is itself a workspace-analysis input change. When an
      // already-analyzed repository is attached, an unchanged follow-up push
      // may be legitimately reused and emit no new analysis landing event, so
      // creation must schedule the workspace-level-CAS rebuild directly.
      if (project.analysis_id) scheduleWorkspaceReanalyze(workspaceAnalyses, dataDir, workspaceId);
      return {
        statusCode: 201,
        body: { project },
      };
    }
    // No DELETE /api/workspaces/{id}/projects/{projectId} (detach) here by
    // design: AccountProject.workspace_id is a required single foreign key —
    // there is no "no workspace" state for a project to fall back to, and no
    // structurally distinct "default" workspace to return it to (the
    // workspace created at registration is a plain AccountWorkspace like any
    // other). Detaching a project would have to either delete it or leave it
    // pointing at a workspace_id that no longer has it as a member, both of
    // which violate the existing model rather than working within it. If a
    // detach target is needed later, attach the project to a different
    // workspace instead (POST here with { project_id }) — that is a supported
    // move.
  }

  const workspaceAnalysisMatch = route.match(/^\/api\/workspaces\/([^/]+)\/analysis$/);
  if (workspaceAnalysisMatch && request.method === 'GET') {
    const workspaceId = decodeURIComponent(workspaceAnalysisMatch[1]);
    // requireMembership-equivalent: listProjects throws 404 for non-members,
    // which is exactly the access check this route needs before returning
    // any workspace-scoped data.
    await accounts.listProjects(userId, workspaceId);
    if (!workspaceAnalyses) {
      return { statusCode: 200, body: { status: 'none', workspace_id: workspaceId } };
    }
    const record = await workspaceAnalyses.load(workspaceId);
    const pending = workspaceAnalyses.isPending(workspaceId);
    // Additive last-attempt visibility (defect #41): a background reanalyze
    // that throws leaves `record` untouched (still the OLD graph, or absent),
    // so surface the last reanalyze attempt's lifecycle alongside it.
    const workspaceLastAttempt = dataDir
      ? await readAttemptRecord(workspaceAttemptRecordPath(dataDir, workspaceId))
      : null;
    if (!record) {
      return {
        statusCode: 200,
        body: {
          status: pending ? 'pending' : 'none',
          workspace_id: workspaceId,
          ...(workspaceLastAttempt ? { last_attempt: workspaceLastAttempt } : {}),
        },
      };
    }
    return {
      statusCode: 200,
      body: {
        status: pending ? 'pending' : 'ready',
        workspace_id: record.workspace_id,
        workspace_name: record.workspace_name,
        generated_at: record.generated_at,
        member_project_ids: record.member_project_ids,
        member_project_names: record.member_project_names,
        // Terminal-honest AI narrative state ('ai' | 'degraded' | 'skipped' |
        // 'error' | 'pending'); absent on records persisted before enrichment
        // was attached to server-side workspace-level-CAS rebuilds.
        enrichment: record.enrichment,
        analysis: record.graph,
        ...(workspaceLastAttempt ? { last_attempt: workspaceLastAttempt } : {}),
      },
    };
  }

  // Workspace-scoped Change Activity (the Workspace frame's sibling of
  // /api/account/activity above): same event sources, narrowed to this one
  // workspace's own member projects + workspace-level-CAS rebuild history. Membership-gated
  // the same way GET .../analysis is — listProjects throws 404 for
  // non-members before any workspace-scoped data is touched.
  const workspaceActivityMatch = route.match(/^\/api\/workspaces\/([^/]+)\/activity$/);
  if (workspaceActivityMatch && request.method === 'GET') {
    if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
    const workspaceId = decodeURIComponent(workspaceActivityMatch[1]);
    const projects = await accounts.listProjects(userId, workspaceId);
    const limit = clampActivityLimit(new URL(request.url || '', 'http://localhost').searchParams.get('limit'));
    const workspaceMeta = await accounts.getWorkspaceById(workspaceId);
    const events: AccountActivityEvent[] = [];
    for (const project of projects) {
      events.push(...await collectProjectActivityEvents(dataDir, project, workspaceId));
    }
    events.push(...await collectWorkspaceActivityEvents(workspaceAnalyses, dataDir, workspaceId, workspaceMeta?.name || workspaceId));
    events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { statusCode: 200, body: { workspace_id: workspaceId, events: events.slice(0, limit), next_cursor: null } };
  }

  // POST /api/workspaces/{id}/reanalyze — recompute the server-side workspace-level CAS for
  // this workspace from the STORED member analyses, WITH the AI narrative
  // enrichment pass, and persist. Mirrors POST /api/projects/{id}/reanalyze:
  // answer 202 immediately and run in the background (a multi-repo workspace-level-CAS build
  // + AI narrative can exceed the Cloudflare edge and client POST timeouts),
  // then let clients poll GET /api/workspaces/{id}/analysis for
  // status:'ready' + enrichment.status. This is the product surface for
  // refreshing a workspace whose auto-built narrative landed degraded.
  const workspaceReanalyzeMatch = route.match(/^\/api\/workspaces\/([^/]+)\/reanalyze$/);
  if (workspaceReanalyzeMatch && request.method === 'POST') {
    const workspaceId = decodeURIComponent(workspaceReanalyzeMatch[1]);
    // Workspace isolation: same membership gate as GET /analysis above —
    // listProjects throws 404 for non-members BEFORE any workspace-scoped
    // work is scheduled, so a user can only reanalyze their own workspace.
    await accounts.listProjects(userId, workspaceId);
    scheduleWorkspaceReanalyze(workspaceAnalyses, dataDir, workspaceId);
    return {
      statusCode: 202,
      body: { status: 'accepted', workspace_id: workspaceId },
    };
  }

  // Recognition lookup for `klauro init`: has this Git remote already been
  // connected to a project by this user? Returns the matched project plus its
  // workspace so the CLI can offer a one-keystroke reconnect (or null when the
  // remote is new). Placed before the `/api/projects/:id` matcher so the
  // literal `by-remote` segment is not read as a project id.
  if (request.method === 'GET' && route === '/api/projects/by-remote') {
    if (sharedToken) return { statusCode: 200, body: { match: null } };
    const repoUrl = new URL(request.url || '', 'http://localhost').searchParams.get('repo_url') || '';
    if (!repoUrl.trim()) throw new AccountHttpError(400, 'repo_url query parameter is required');
    const found = await accounts.findProjectByRepoUrl(userId, repoUrl);
    if (!found) return { statusCode: 200, body: { match: null } };
    return {
      statusCode: 200,
      body: {
        match: {
          project: found.project,
          workspace: { id: found.workspace.id, name: found.workspace.name, role: found.role },
        },
      },
    };
  }

  const projectMatch = route.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && request.method === 'GET') {
    const project = await accounts.getProjectForUser(userId, decodeURIComponent(projectMatch[1]));
    if (!project) throw new AccountHttpError(404, 'Project not found');
    return { statusCode: 200, body: { project } };
  }

  const projectQueryMatch = route.match(/^\/api\/projects\/([^/]+)\/query$/);
  if (projectQueryMatch && request.method === 'POST') {
    if (sharedToken) throw new AccountHttpError(403, 'A signed-in Klauro account is required for project intelligence queries');
    if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
    const project = await accounts.getProjectForUser(userId, decodeURIComponent(projectQueryMatch[1]));
    if (!project) throw new AccountHttpError(404, 'Project not found');
    if (!project.analysis_id) throw new AccountHttpError(409, 'Project has no completed analysis');
    const body = await readJsonBody<{ tool?: string; args?: unknown }>(request, maxBodyBytes);
    if (!body.tool || !HOSTED_PROJECT_QUERY_TOOL_NAMES.includes(body.tool as any)) {
      throw new AccountHttpError(400, `Unsupported hosted query tool '${body.tool || ''}'`);
    }
    try {
      const workspace = workspacePath(dataDir, project.analysis_id);
      const cas = await getAnalysis(workspace);
      const result = await executeHostedProjectQuery({
        cas,
        tool: body.tool,
        args: body.args,
        projectPath: workspace,
      });
      return {
        statusCode: 200,
        body: {
          status: 'ready',
          project_id: project.id,
          analysis_id: project.analysis_id,
          analysis_timestamp: cas.analysis_timestamp,
          tool: body.tool,
          result,
        },
      };
    } catch (error) {
      if (error instanceof z.ZodError) throw new AccountHttpError(400, error.message);
      throw error;
    }
  }

  const projectAnalysisStatusMatch = route.match(/^\/api\/projects\/([^/]+)\/analysis-status$/);
  if (projectAnalysisStatusMatch && request.method === 'GET') {
    if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
    const project = await accounts.getProjectForUser(userId, decodeURIComponent(projectAnalysisStatusMatch[1]));
    if (!project) throw new AccountHttpError(404, 'Project not found');
    if (!project.analysis_id) {
      return { statusCode: 200, body: { status: 'no_analysis', project_id: project.id } };
    }
    const analysisWorkspace = workspacePath(dataDir, project.analysis_id);
    // STRANDED-ANALYSIS (defect class #41 continuation): lazily reap on every
    // poll, same as GET /v1/analyses/:id/status and GET .../analysis below —
    // this route was the one omission (task #129 audit), so a crashed
    // background analysis queried through THIS surface never self-healed the
    // way the other two do.
    await reapAbandonedAttempt(analysisWorkspace, projectAttemptRecordPath(analysisWorkspace));
    const entry = await getAnalysisEntry(analysisWorkspace);
    const lastAttempt = await readAttemptRecord(projectAttemptRecordPath(analysisWorkspace));
    // #129 — "status: fresh" on a stale, foreign-looking analysis. `entry` is
    // a STATIC on-disk snapshot read by path, keyed by `project.analysis_id`
    // (itself a deterministic hash of the repo path, not this project's own
    // identity — see resolveAnalysisId). If a NEW analysis is actively being
    // written into this same workspace right now (lastAttempt.state ===
    // 'in-progress' — written the moment a push is accepted, well before the
    // CAS itself lands), `entry` still reflects whatever was landed BEFORE
    // this attempt started: a previous run of this project, or — if the path
    // was ever reused/reinitialized — a genuinely different project's
    // leftover analysis. Either way, reporting that stale entry as 'ready'/
    // fresh here is exactly the "told fresh when it isn't" defect: the
    // customer polls mid-write and is handed a timestamp from before the run
    // they just kicked off. `/v1/analyses/:id/status` avoids this the same
    // way via `activeCommittedSnapshots` (an in-memory, per-analysis "a write
    // is landing right now" flag scoped to the request-handling closure this
    // route cannot see); `lastAttempt.state === 'in-progress'` is the durable
    // on-disk equivalent of that exact signal, already being read on the line
    // above — so an in-progress attempt must win over a landed-but-stale
    // entry, not the other way around, regardless of whether `entry` exists.
    if (lastAttempt?.state === 'in-progress') {
      const structural = structuralReadinessDuringAttempt(entry, lastAttempt);
      if (structural) {
        // TASK #143: this used to ship only a handful of counts (name/
        // node_count/edge_count) — technically non-'populating' but useless
        // for an actual query (no capabilities, no entry points), so a
        // caller polling during this genuinely-queryable L0-L4-ready/
        // L5-pending window still saw nothing worth reading and kept
        // waiting for the full L5 tail anyway. L1-4 have already landed a
        // real CAS on disk at this point (analyzer.ts's layered pipeline
        // saves right after the 'rest' phase) — build the SAME compact
        // summary the 'ready'/'degraded' path below serves, so a customer
        // polling at ~T+20s gets the real architecture/capability answer,
        // not just a progress counter.
        return {
          statusCode: 200,
          body: {
            status: 'queryable',
            project_id: project.id,
            analysis_id: project.analysis_id,
            last_attempt: lastAttempt,
            summary: await buildQueryableSummary(analysisWorkspace, entry!),
          },
        };
      }
      return {
        statusCode: 200,
        body: {
          status: 'populating',
          project_id: project.id,
          analysis_id: project.analysis_id,
          last_attempt: lastAttempt,
        },
      };
    }
    if (!entry) {
      return {
        statusCode: 200,
        body: {
          status: 'no_analysis',
          project_id: project.id,
          analysis_id: project.analysis_id,
          ...(lastAttempt ? { last_attempt: lastAttempt } : {}),
        },
      };
    }
    const layers = entry.layers_ready?.layers || [];
    const structuralErrors = layers.filter(layer => layer.layer !== 'L5' && layer.status === 'error');
    const pending = layers.some(layer => layer.status === 'pending');
    // Same honesty rule as /analysis below: a terminal L5 'error' means the
    // comprehension layer degraded, so this listing must not read 'ready'.
    const l5Errored = layers.some(layer => layer.layer === 'L5' && layer.status === 'error');
    const status = structuralErrors.length > 0
      ? 'failed'
      : pending
        ? 'populating'
        : l5Errored
          ? 'degraded'
          : 'ready';
    return {
      statusCode: 200,
      body: {
        status,
        project_id: project.id,
        analysis_id: project.analysis_id,
        ...(lastAttempt ? { last_attempt: lastAttempt } : {}),
        ...(l5Errored && structuralErrors.length === 0 ? { degraded_layers: ['L5'] } : {}),
        ...(structuralErrors.length > 0 ? { failed_layers: structuralErrors.map(layer => layer.layer) } : {}),
        summary: {
          name: entry.name,
          analysis_timestamp: entry.analyzed_at,
          node_count: entry.node_count,
          edge_count: entry.edge_count,
          cas_version: entry.cas_version,
          layers_ready: entry.layers_ready,
        },
      },
    };
  }

  const projectAnalysisMatch = route.match(/^\/api\/projects\/([^/]+)\/analysis$/);
  if (projectAnalysisMatch && request.method === 'GET') {
    if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
    const project = await accounts.getProjectForUser(userId, decodeURIComponent(projectAnalysisMatch[1]));
    if (!project) throw new AccountHttpError(404, 'Project not found');
    if (!project.analysis_id) {
      return { statusCode: 200, body: { status: 'no_analysis', project_id: project.id } };
    }
    const analysisWorkspace = workspacePath(dataDir, project.analysis_id);
    // STRANDED-ANALYSIS (defect class #41 continuation): lazily reap on every
    // poll, same as GET /v1/analyses/:id/status — this is the account/web
    // path's equivalent read, so it needs the same fast (no-restart-required)
    // recovery. Never touches a record whose heartbeat is still fresh, and
    // never fails a landed CAS (see reapAbandonedAttempt's doc comment).
    await reapAbandonedAttempt(analysisWorkspace, projectAttemptRecordPath(analysisWorkspace));
    // #129 — same "told fresh when it isn't" defect as GET .../analysis-status
    // above, same fix: `getAnalysis` below reads whatever CAS is currently
    // landed on disk, which — while a new attempt is actively writing into
    // this same workspace (lastAttempt.state === 'in-progress', set the
    // moment a push is accepted) — is necessarily the PREVIOUS run's data,
    // not the one this caller just triggered. Short-circuit on that signal
    // before doing the (heavier) CAS read/status computation below, so a
    // mid-write poll reports 'populating' instead of a stale 'ready'.
    const earlyLastAttempt = await readAttemptRecord(projectAttemptRecordPath(analysisWorkspace));
    if (earlyLastAttempt?.state === 'in-progress') {
      // Same progressive-readiness overlay as GET .../analysis-status (see
      // structuralReadinessDuringAttempt's doc comment): a lightweight entry
      // check gates whether this window applies at all, so a repo still mid
      // L0-L4 (or a stale/foreign entry — #129) pays no extra cost and falls
      // straight through to 'populating' below. Only once the gate passes —
      // genuinely this attempt's own fresh L0-L4 landing, L5 still pending —
      // is the heavier `getAnalysis`+buildSummary read (buildQueryableSummary)
      // worth its cost: TASK #143 found the previous counts-only summary here
      // technically satisfied "not populating" but gave a polling caller
      // nothing actually queryable (no capabilities, no entry points), which
      // defeated the entire point of this early-readiness window.
      const earlyEntry = await getAnalysisEntry(analysisWorkspace).catch(() => null);
      const structural = structuralReadinessDuringAttempt(earlyEntry, earlyLastAttempt);
      if (structural) {
        return {
          statusCode: 200,
          body: {
            status: 'queryable',
            project_id: project.id,
            analysis_id: project.analysis_id,
            last_attempt: earlyLastAttempt,
            summary: await buildQueryableSummary(analysisWorkspace, earlyEntry!),
          },
        };
      }
      return {
        statusCode: 200,
        body: { status: 'populating', project_id: project.id, analysis_id: project.analysis_id, last_attempt: earlyLastAttempt },
      };
    }
    try {
      const cas = await getAnalysis(analysisWorkspace);
      const summary = buildSummary(cas, { detail: 'compact' });
      // sub_cas_nodes (docs/cas/SPECIFICATION.md §0.4): this endpoint is the
      // FAST hosted-summary path get_summary takes by default (server.ts's
      // hostedSummaryPayload, hit whenever a caller passes no scope/detail=
      // full/runtime/exclude_sections — i.e. the common case). Without
      // attaching it here, sub_cas_nodes only ever reached a caller that fell
      // through to the slower full-CAS-mirror branch (buildSummaryWithSubCasNodeIndex
      // in server.ts) or hit the dedicated /api/projects/{id}/das route
      // directly — so a fresh promoted analysis queried the normal way never
      // saw its sub-CAS nodes. Attach it onto `summary` (not a sibling of it)
      // so hostedSummaryPayload's `{ ...state.summary, hosted_status }` spread
      // flattens it to the same top-level `sub_cas_nodes` key
      // buildSummaryWithSubCasNodeIndex already produces.
      const das = getCachedDeployableAnalyses(cas);
      (summary as Record<string, unknown>).sub_cas_nodes = das.sub_cas_nodes;
      const productMap = getProductMap(cas);
      // Progressive availability (task #112): a project attached during its
      // L0-only window is real and queryable, just not fully layered yet — the
      // web app's live progress ladder distinguishes 'populating' (some
      // layers still pending) from 'ready' (every layer landed) using the
      // same layers_ready manifest surfaced in `summary`, rather than the
      // caller having to infer it from node counts.
      // 'populating' ONLY while a layer is genuinely still coming. A layer in
      // terminal 'error' (the L5 AI comprehension pass failed its model call
      // or grounding gate) keeps layers_ready.complete false forever — before
      // this distinction, a project whose L5 errored read as 'populating'
      // indefinitely (prod: multiple live customer projects stuck "populating"
      // with description_source null). The structure IS complete and final, so
      // the project is 'ready', with an explicit degraded ai_enrichment
      // indicator + the underlying rejection reason so the failure is VISIBLE.
      const ladderLayers = cas.layers_ready?.layers || [];
      const hasPendingLayer = ladderLayers.some(layer => layer.status === 'pending');
      const erroredLayers = ladderLayers.filter(layer => layer.status === 'error');
      // A STRUCTURAL layer (L1..L4) in 'error' means the deterministic analysis
      // itself crashed — there is no usable structure, so this is neither
      // 'populating' (nothing is still coming) nor 'ready' (nothing landed).
      // Report it as the terminal 'failed' it is, with the reason. Before this,
      // a crashed background analysis left L1..L5 'pending' and read
      // 'populating' FOREVER with errors:0 (prod, 2026-07-16: a torn deploy
      // killed every analysis and no surface said so). L5 stays separate: its
      // failure degrades comprehension only, the structure is still real.
      const structuralErrors = erroredLayers.filter(layer => layer.layer !== 'L5');
      const aiDegraded = cas.ai_enrichment === 'error'
        || (erroredLayers.some(layer => layer.layer === 'L5') && !hasPendingLayer);
      // COMPREHENSION DEGRADATION is a status, not a footnote. An L5 failure
      // used to be reported as `status: 'ready'` with an `ai_enrichment` field
      // beside it — and what shipped under that 'ready' was 228 un-enriched
      // structural placeholders where a healthy run produced 13 coherent
      // capabilities. A client that branches on `status` had no way to know.
      // 'degraded' says the structure is real and queryable but comprehension
      // is not what it should be; the machine-readable detail follows.
      const naming = cas.enhanced_system_purpose?.capability_naming_coverage;
      const nameDegradations = cas.enhanced_system_purpose?.capability_name_degradations || [];
      const descriptionDegradations = cas.enhanced_system_purpose?.capability_description_degradations || [];
      // A structure-only deployment (comprehension never configured) is a mode,
      // not a degradation — only judge naming coverage when the pass actually
      // ran. A pass that ran and authored NOTHING is the audited failure.
      const comprehensionAttempted = cas.ai_enrichment === 'ready'
        || cas.ai_enrichment === 'synchronous'
        || cas.ai_enrichment === 'error';
      // TASK #143: 'degraded' as a TERMINAL status must mean the comprehension
      // PASS ITSELF failed (aiDegraded — provider/grounding failure, no
      // deterministic fallback exists) — that is a real, complete failure a
      // customer needs to know about and possibly retry. A PARTIAL shortfall
      // (the pass ran, most capabilities were AI-named, a handful were not —
      // "2 of 12 capabilities shipped without AI enrichment") is a different
      // thing entirely: the structure is complete, comprehension mostly
      // succeeded, and the analysis is fully usable. Before this split, both
      // cases reported the identical terminal 'degraded', so a customer had
      // no way to tell "the AI never ran" from "the AI ran and got 10/12" —
      // and a budget-pressured repo that legitimately finished 10/12 read
      // exactly as broken as one where AI enrichment failed outright. See
      // docs/cas/SPECIFICATION.md's honesty vocabulary and the latency
      // doctrine: a budget must never be met by delivering an incomplete
      // analysis that LOOKS complete — the fix here is the opposite defect
      // (a mostly-complete analysis that looked terminally broken).
      const { comprehensionFailed, comprehensionPartial } = classifyComprehensionOutcome({
        aiDegraded,
        comprehensionAttempted,
        namingTotal: naming?.total,
        namingAuthored: naming?.authored,
        nameDegradationCount: nameDegradations.length,
        descriptionDegradationCount: descriptionDegradations.length,
      });
      const comprehensionDegraded = comprehensionFailed || comprehensionPartial;
      // Enrichment has TWO independent dimensions — name and description — and
      // this list used to report only names. Measured live on a 92,582-node repo
      // (2026-08-10): all 8 names were AI-authored, so this came back EMPTY and
      // `capability_naming_coverage` read `{total: 8, authored: 8, un_enriched: 0}`
      // — while one capability's DESCRIPTION was deterministic machinery text
      // ("sends Sessions, SessionsPatch, GatewaySessionEntry through 12 CLI
      // commands"). The customer therefore saw `partial: true` sitting next to
      // "8 of 8 authored, 0 un-enriched" and no named gap: three fields that
      // contradict each other, which reads as a broken product rather than an
      // honest shortfall. Name the capability whose enrichment fell short on
      // EITHER dimension, and say which one.
      const isEnriched = (source: string | undefined): boolean =>
        source === 'ai' || source === 'manual' || source === 'reused';
      const unenrichedCapabilityDetails = comprehensionPartial
        ? (cas.system_capabilities || [])
            .map(capability => {
              const nameShort = !isEnriched(capability.name_source);
              const descriptionShort = !isEnriched(capability.description_source);
              if (!nameShort && !descriptionShort) return undefined;
              const missing = nameShort && descriptionShort ? 'name and description'
                : nameShort ? 'name' : 'description';
              return capability.name ? { name: capability.name, missing } : undefined;
            })
            .filter((entry): entry is { name: string; missing: string } => Boolean(entry))
        : [];
      const unenrichedCapabilityNames = unenrichedCapabilityDetails.map(entry => entry.name);
      const status = structuralErrors.length > 0
        ? 'failed'
        : cas.layers_ready && !cas.layers_ready.complete && hasPendingLayer
          ? 'populating'
          : comprehensionFailed
            ? 'degraded'
            : 'ready';
      // Additive last-attempt visibility (defect #41): a reanalyze of an
      // already-'ready' analysis that throws leaves the CAS above completely
      // untouched (no pending layer for markBackgroundAnalysisFailed to flip),
      // so `status` alone would still read 'ready' with no signal a fresher
      // attempt failed. Surface the sidecar attempt record alongside it —
      // lets a poller see last_attempt.state==='failed' (with reason) or
      // 'in-progress' (with started_at, resolving the "still running or
      // dead?" ambiguity) even though `summary` is unchanged from before.
      const lastAttempt = await readAttemptRecord(projectAttemptRecordPath(analysisWorkspace));
      return {
        statusCode: 200,
        body: {
          status,
          ...(lastAttempt ? { last_attempt: lastAttempt } : {}),
          ...(structuralErrors.length > 0
            ? {
                analysis_error:
                  structuralErrors.find(layer => layer.error)?.error ||
                  'The analysis failed before structure could be produced.',
                failed_layers: structuralErrors.map(layer => layer.layer),
              }
            : {}),
          ...(comprehensionFailed
            ? {
                ai_enrichment: 'error',
                ai_enrichment_error:
                  cas.ai_enrichment_error ||
                  erroredLayers.find(layer => layer.layer === 'L5' && layer.error)?.error ||
                  'AI comprehension pass failed; comprehension is AI-only (no deterministic fallback)',
              }
            : {}),
          ...(comprehensionDegraded
            ? {
                comprehension: {
                  // TASK #143: 'degraded' here is the per-item detail flag
                  // (kept for existing consumers), NOT the top-level
                  // `status` — a comprehensionPartial result reports
                  // `status: 'ready'`, never terminal 'degraded'.
                  // `degraded` was hardcoded `true` here, so a PARTIAL result —
                  // the pass ran, structure is complete, one description fell
                  // back — published `degraded: true, partial: true` together.
                  // A customer reads "degraded" as "this analysis is bad", which
                  // is wrong and is the single most alarming field in the whole
                  // payload. Terminal `status` already distinguishes the two
                  // (see below); this detail flag must agree with it, so it now
                  // means what it says: the comprehension PASS failed.
                  degraded: comprehensionFailed,
                  partial: comprehensionPartial,
                  ...(naming ? { capability_naming_coverage: naming } : {}),
                  capability_name_degradations: nameDegradations.length,
                  capability_description_degradations: descriptionDegradations.length,
                  // TASK #143 item 2: honest gaps name exactly which
                  // capabilities lack enrichment — never a generic count
                  // alone, never a silent/placeholder name. Now carries WHICH
                  // dimension fell short per capability, because name and
                  // description degrade independently and reporting only one
                  // produced a payload whose own fields disagreed.
                  ...(unenrichedCapabilityDetails.length > 0
                    ? { unenriched_capabilities: unenrichedCapabilityDetails }
                    : {}),
                  detail: comprehensionFailed
                    ? 'The AI comprehension pass failed; capability names and descriptions are un-enriched deterministic facts.'
                    : unenrichedCapabilityDetails.length > 0
                      ? `${unenrichedCapabilityDetails.length} of ${naming?.total ?? '?'} capabilities fell short of full AI enrichment (${unenrichedCapabilityDetails.map(e => `${e.name}: ${e.missing}`).join('; ')}); those fields carry deterministic evidence text, not authored comprehension. The analysis is otherwise complete and fully queryable.`
                      : 'Part of the capability catalog could not be AI-enriched; those entries carry deterministic evidence text, not authored comprehension.',
                },
              }
            : {}),
          project_id: project.id,
          analysis_id: project.analysis_id,
          summary,
          product_map: productMap,
        },
      };
    } catch (error) {
      const lastAttemptOnError = await readAttemptRecord(projectAttemptRecordPath(analysisWorkspace));
      return {
        statusCode: 200,
        body: {
          status: 'no_analysis',
          project_id: project.id,
          analysis_id: project.analysis_id,
          error: error instanceof Error ? error.message : String(error),
          ...(lastAttemptOnError ? { last_attempt: lastAttemptOnError } : {}),
        },
      };
    }
  }

  const projectCasManifestMatch = route.match(/^\/api\/projects\/([^/]+)\/cas\/manifest$/);
  if (projectCasManifestMatch && request.method === 'GET') {
    if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
    const project = await accounts.getProjectForUser(userId, decodeURIComponent(projectCasManifestMatch[1]));
    if (!project) throw new AccountHttpError(404, 'Project not found');
    if (!project.analysis_id) return { statusCode: 200, body: { status: 'no_analysis', project_id: project.id } };
    const workspace = workspacePath(dataDir, project.analysis_id);
    const manifest = await loadAnalysisSectionManifest(workspace);
    if (!manifest) return { statusCode: 200, body: { status: 'no_analysis', project_id: project.id } };
    return {
      statusCode: 200,
      body: { status: 'ready', project_id: project.id, analysis_id: project.analysis_id, manifest },
    };
  }

  const projectCasSectionsMatch = route.match(/^\/api\/projects\/([^/]+)\/cas\/sections$/);
  if (projectCasSectionsMatch && request.method === 'GET') {
    if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
    const project = await accounts.getProjectForUser(userId, decodeURIComponent(projectCasSectionsMatch[1]));
    if (!project) throw new AccountHttpError(404, 'Project not found');
    if (!project.analysis_id) return { statusCode: 200, body: { status: 'no_analysis', project_id: project.id } };
    const url = new URL(request.url || '', 'http://localhost');
    let sections;
    try {
      sections = parseCasSectionNames(url.searchParams.get('sections'));
    } catch (error) {
      throw new AccountHttpError(400, error instanceof Error ? error.message : String(error));
    }
    if (sections.length === 0) throw new AccountHttpError(400, 'At least one CAS section is required');
    const workspace = workspacePath(dataDir, project.analysis_id);
    const sectionsSubCasNodeId = url.searchParams.get('sub_cas_node_id') || undefined;

    // Sub-CAS-node-scoped sections (?sub_cas_node_id=<id>): the scope used to be accepted
    // and silently IGNORED here, so `?sections=comprehension&sub_cas_node_id=X`
    // returned the whole repo's capability and flow set — flows whose own ids
    // name other deployables — while looking like a scoped answer. Slicing
    // needs the layers the closure is derived from (graph/calls) plus the ship
    // evidence itself (runtime) and the entry/exit/entity layer
    // (supplemental), so those are loaded regardless of what was requested and
    // then projected back down to exactly the requested sections.
    if (sectionsSubCasNodeId) {
      const version = await storedAnalysisVersion(workspace);
      const cacheKey = version === null ? null : responseCacheKey({
        endpoint: 'das-cas-sections',
        projectId: project.id,
        analysisId: project.analysis_id,
        version,
        params: { sub_cas_node_id: sectionsSubCasNodeId, sections: sections.join(',') },
      });
      if (cacheKey) {
        const cached = casReadResponseCache.get(cacheKey);
        if (cached !== undefined) return { statusCode: 200, body: JSON.parse(cached), serializedBody: cached };
      }
      const sliceInputSections = [...new Set<CasSectionName>([
        ...sections,
        'graph',
        'calls',
        'runtime',
        'supplemental',
        'comprehension',
      ])];
      const fullEnough = await loadAnalysisSections(workspace, sliceInputSections);
      if (!fullEnough) return { statusCode: 200, body: { status: 'no_analysis', project_id: project.id } };
      let scopedCas;
      try {
        // loadAnalysisSections returns Partial<CASOutput> by design (it loaded a
        // named subset); the slicer only reads the fields requested above.
        scopedCas = scopeCasToSubCasNode(fullEnough as CASOutput, { sub_cas_node_id: sectionsSubCasNodeId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new AccountHttpError(message.startsWith('Unknown scope.sub_cas_node_id') ? 404 : 400, message);
      }
      const body = {
        status: 'ready',
        project_id: project.id,
        analysis_id: project.analysis_id,
        analysis_timestamp: scopedCas.analysis_timestamp || null,
        sections,
        sub_cas_node_id: sectionsSubCasNodeId,
        cas: selectCasSections(scopedCas, sections),
      };
      const serializedBody = JSON.stringify(body);
      if (cacheKey) casReadResponseCache.set(cacheKey, serializedBody);
      return { statusCode: 200, body, serializedBody };
    }

    const cas = await loadAnalysisSections(workspace, sections);
    if (!cas) return { statusCode: 200, body: { status: 'no_analysis', project_id: project.id } };
    return {
      statusCode: 200,
      body: {
        status: 'ready',
        project_id: project.id,
        analysis_id: project.analysis_id,
        analysis_timestamp: cas.analysis_timestamp || null,
        sections,
        cas,
      },
    };
  }

  const projectCasExportMatch = route.match(/^\/api\/projects\/([^/]+)\/cas\/export$/);
  if (projectCasExportMatch && request.method === 'GET') {
    if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
    const project = await accounts.getProjectForUser(userId, decodeURIComponent(projectCasExportMatch[1]));
    if (!project) throw new AccountHttpError(404, 'Project not found');
    if (!project.analysis_id) return { statusCode: 200, body: { status: 'no_analysis', project_id: project.id } };
    const artifact = await resolveAnalysisExportArtifact(workspacePath(dataDir, project.analysis_id));
    if (!artifact) return { statusCode: 200, body: { status: 'no_analysis', project_id: project.id } };
    const extension = artifact.codec === 'brotli' ? 'json.br' : artifact.codec === 'zstd' ? 'json.zst' : 'json';
    return {
      statusCode: 200,
      body: null,
      stream: {
        filePath: artifact.filePath,
        headers: {
          'content-type': artifact.codec === 'zstd' ? 'application/zstd' : 'application/json',
          'content-length': artifact.bytes,
          'content-disposition': `attachment; filename="${project.id}.${extension}"`,
          'x-klauro-cas-codec': artifact.codec,
          'x-klauro-analysis-id': project.analysis_id,
          ...(artifact.codec === 'brotli' ? { 'content-encoding': 'br' } : {}),
        },
      },
    };
  }

  // Sub-CAS-node-scoped CAS remains a query response. Unscoped full-CAS access is an
  // explicit compressed stream at /cas/export; normal MCP clients hydrate
  // named sections and never mirror the entire customer graph.
  //
  // Sub-CAS-node-scoped variant (?sub_cas_node_id=<id>): the web UI's deployable page was
  // approximating deployable-analysis.ts's phase-2 scoping (getCachedDeploy-
  // ableAnalyses / scopeCasToSubCasNode) client-side because the real scoped
  // surface — already wired into 5 MCP tools via server.ts's
  // buildSummaryWithSubCasNodeIndex-style `scope` param — was never exposed over
  // HTTP. Unlike the full-CAS path above, a slice IS worth caching: it is a
  // pure function of the stored CAS + sub_cas_node_id, and (unlike the
  // once-per-client mirror pull) a UI page can re-request the same unit
  // repeatedly as the user navigates.
  const projectCasMatch = route.match(/^\/api\/projects\/([^/]+)\/cas$/);
  if (projectCasMatch && request.method === 'GET') {
    if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
    const project = await accounts.getProjectForUser(userId, decodeURIComponent(projectCasMatch[1]));
    if (!project) throw new AccountHttpError(404, 'Project not found');
    if (!project.analysis_id) {
      return { statusCode: 200, body: { status: 'no_analysis', project_id: project.id } };
    }
    const workspace = workspacePath(dataDir, project.analysis_id);
    const url = new URL(request.url || '', 'http://localhost');
    const subCasNodeId = url.searchParams.get('sub_cas_node_id') || undefined;

    if (subCasNodeId) {
      const version = await storedAnalysisVersion(workspace);
      const cacheKey = version === null ? null : responseCacheKey({
        endpoint: 'das-cas-slice',
        projectId: project.id,
        analysisId: project.analysis_id,
        version,
        params: { sub_cas_node_id: subCasNodeId },
      });
      if (cacheKey) {
        const cached = casReadResponseCache.get(cacheKey);
        if (cached !== undefined) {
          return { statusCode: 200, body: JSON.parse(cached), serializedBody: cached };
        }
      }
      let cas;
      try {
        cas = await getAnalysis(workspace);
      } catch (error) {
        return {
          statusCode: 200,
          body: {
            status: 'no_analysis',
            project_id: project.id,
            analysis_id: project.analysis_id,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
      // scopeCasToSubCasNode throws a caller-facing Error — never a silent empty
      // result — for a repo that hasn't promoted (fewer than 2 tier-qualified
      // ship units) or an id that doesn't match any current unit (naming the
      // ids that DO exist so a caller can self-correct). These are REQUEST
      // errors, not "no analysis exists", so they surface as 4xx JSON via
      // AccountHttpError like every other validation failure in this
      // handler — not folded into the 200 no_analysis shape above.
      let scopedCas;
      try {
        scopedCas = scopeCasToSubCasNode(cas, { sub_cas_node_id: subCasNodeId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode = message.startsWith('Unknown scope.sub_cas_node_id') ? 404 : 400;
        throw new AccountHttpError(statusCode, message);
      }
      const body = {
        status: 'ready',
        project_id: project.id,
        analysis_id: project.analysis_id,
        analysis_timestamp: scopedCas.analysis_timestamp || null,
        sub_cas_node_id: subCasNodeId,
        cas: scopedCas,
      };
      const serializedBody = JSON.stringify(body);
      if (cacheKey) casReadResponseCache.set(cacheKey, serializedBody);
      return { statusCode: 200, body, serializedBody };
    }

    return {
      statusCode: 410,
      body: {
        status: 'gone',
        error: 'Full CAS JSON responses are disabled. Request named sections or use the compressed export stream.',
        manifest_url: `/api/projects/${encodeURIComponent(project.id)}/cas/manifest`,
        sections_url: `/api/projects/${encodeURIComponent(project.id)}/cas/sections`,
        export_url: `/api/projects/${encodeURIComponent(project.id)}/cas/export`,
      },
    };
  }

  // sub-CAS-node index: units + counts + orphan accounting WITHOUT the
  // multi-MB `cas` body — the cheap discovery call a UI makes before ever
  // requesting a scoped slice (mirrors get_summary's sub_cas_nodes attachment
  // in server.ts's buildSummaryWithSubCasNodeIndex). Cacheable for the same reason
  // the slice above is: a pure function of the stored CAS, no scope param to
  // vary on.
  const projectDasMatch = route.match(/^\/api\/projects\/([^/]+)\/das$/);
  if (projectDasMatch && request.method === 'GET') {
    if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
    const project = await accounts.getProjectForUser(userId, decodeURIComponent(projectDasMatch[1]));
    if (!project) throw new AccountHttpError(404, 'Project not found');
    if (!project.analysis_id) {
      return { statusCode: 200, body: { status: 'no_analysis', project_id: project.id } };
    }
    try {
      const workspace = workspacePath(dataDir, project.analysis_id);
      const version = await storedAnalysisVersion(workspace);
      const cacheKey = version === null ? null : responseCacheKey({
        endpoint: 'das-index',
        projectId: project.id,
        analysisId: project.analysis_id,
        version,
      });
      if (cacheKey) {
        const cached = casReadResponseCache.get(cacheKey);
        if (cached !== undefined) {
          return { statusCode: 200, body: JSON.parse(cached), serializedBody: cached };
        }
      }
      const cas = await getAnalysis(workspace);
      const das = getCachedDeployableAnalyses(cas);
      const body = {
        status: 'ready',
        project_id: project.id,
        analysis_id: project.analysis_id,
        analysis_timestamp: cas.analysis_timestamp || null,
        sub_cas_nodes: das.sub_cas_nodes,
      };
      const serializedBody = JSON.stringify(body);
      if (cacheKey) casReadResponseCache.set(cacheKey, serializedBody);
      return { statusCode: 200, body, serializedBody };
    } catch (error) {
      return {
        statusCode: 200,
        body: {
          status: 'no_analysis',
          project_id: project.id,
          analysis_id: project.analysis_id,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  // Semantic coverage over HTTP (docs/SEMANTIC-MODEL.md "Coverage invariants").
  // get_summary omits inline coverage on large repos (query.ts guard) and points
  // at the get_semantic_coverage MCP tool — which a web-only customer can't call.
  // This route serves the SAME payload so the pointer is followable from the web.
  const projectCoverageMatch = route.match(/^\/api\/projects\/([^/]+)\/semantic-coverage$/);
  if (projectCoverageMatch && request.method === 'GET') {
    if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
    const project = await accounts.getProjectForUser(userId, decodeURIComponent(projectCoverageMatch[1]));
    if (!project) throw new AccountHttpError(404, 'Project not found');
    if (!project.analysis_id) {
      return { statusCode: 200, body: { status: 'no_analysis', project_id: project.id } };
    }
    try {
      const workspace = workspacePath(dataDir, project.analysis_id);
      // Response cache: this payload is a pure function of the stored CAS —
      // on a hit we never load the (potentially whale-sized) analysis at all.
      const version = await storedAnalysisVersion(workspace);
      const cacheKey = version === null ? null : responseCacheKey({
        endpoint: 'semantic-coverage',
        projectId: project.id,
        analysisId: project.analysis_id,
        version,
      });
      if (cacheKey) {
        const cached = casReadResponseCache.get(cacheKey);
        if (cached !== undefined) {
          return { statusCode: 200, body: JSON.parse(cached), serializedBody: cached };
        }
      }
      const cas = await getAnalysis(workspace);
      const body = {
        status: 'ready',
        project_id: project.id,
        analysis_id: project.analysis_id,
        semantic_coverage: getSemanticCoverage(cas),
      };
      const serializedBody = JSON.stringify(body);
      if (cacheKey) casReadResponseCache.set(cacheKey, serializedBody);
      return { statusCode: 200, body, serializedBody };
    } catch (error) {
      return {
        statusCode: 200,
        body: {
          status: 'no_analysis',
          project_id: project.id,
          analysis_id: project.analysis_id,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  // Domain data entities over HTTP (E1 entity_description.v1 — see orchestrator
  // applyAIInterpretation's last-stage entity pass, ecf8a604). The compact
  // GET /api/projects/{id}/analysis summary exposes database_entities as a
  // bare name array (query.ts buildSummary) — no field, role, relation, or
  // description data at all — so a web-only customer had no way to read what
  // the entity-description pass produced. This route reuses getDataEntities
  // (query.ts), the SAME projection the get_data_entities MCP tool serves,
  // paginated (default limit 25) so a whale repo's 100+ entities don't blow
  // the response budget in one shot.
  const projectEntitiesMatch = route.match(/^\/api\/projects\/([^/]+)\/entities$/);
  if (projectEntitiesMatch && request.method === 'GET') {
    if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
    const project = await accounts.getProjectForUser(userId, decodeURIComponent(projectEntitiesMatch[1]));
    if (!project) throw new AccountHttpError(404, 'Project not found');
    if (!project.analysis_id) {
      return { statusCode: 200, body: { status: 'no_analysis', project_id: project.id } };
    }
    try {
      const workspace = workspacePath(dataDir, project.analysis_id);
      const url = new URL(request.url || '', 'http://localhost');
      const entityName = url.searchParams.get('entity_name') || undefined;
      const role = (url.searchParams.get('role') || undefined) as SemanticRole | undefined;
      const limitParamRaw = url.searchParams.get('limit');
      const limitParam = limitParamRaw !== null ? Number(limitParamRaw) : undefined;
      // Bounded to 100: the compact-per-entity projection (10 fields + 10
      // relations sampled, no lifecycle/invariant detail beyond counts) keeps
      // per-entity weight small, but an unbounded HTTP request is still a
      // bigger CAS-compute footprint than the MCP tool surface's own budget
      // assumes (mirrors the /conceptual max_flows precedent above).
      const limit = limitParam !== undefined && Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(Math.floor(limitParam), 100)
        : 25;
      const offsetParamRaw = url.searchParams.get('offset');
      const offsetParam = offsetParamRaw !== null ? Number(offsetParamRaw) : undefined;
      const offset = offsetParam !== undefined && Number.isFinite(offsetParam) && offsetParam >= 0
        ? Math.floor(offsetParam)
        : 0;
      // Response cache: pure function of the stored CAS + (entity_name, role,
      // limit, offset) — a hit skips the CAS load + role-classification pass
      // entirely.
      const version = await storedAnalysisVersion(workspace);
      const cacheKey = version === null ? null : responseCacheKey({
        endpoint: 'entities',
        projectId: project.id,
        analysisId: project.analysis_id,
        version,
        params: { entityName: entityName || '', role: role || '', limit: String(limit), offset: String(offset) },
      });
      if (cacheKey) {
        const cached = casReadResponseCache.get(cacheKey);
        if (cached !== undefined) {
          return { statusCode: 200, body: JSON.parse(cached), serializedBody: cached };
        }
      }
      const cas = await getAnalysis(workspace);
      const dataEntities = getDataEntities(cas, { entityName, role, limit, offset });
      const body = {
        status: 'ready',
        project_id: project.id,
        analysis_id: project.analysis_id,
        ...dataEntities,
      };
      const serializedBody = JSON.stringify(body);
      if (cacheKey) casReadResponseCache.set(cacheKey, serializedBody);
      return { statusCode: 200, body, serializedBody };
    } catch (error) {
      return {
        statusCode: 200,
        body: {
          status: 'no_analysis',
          project_id: project.id,
          analysis_id: project.analysis_id,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  const projectConceptualMatch = route.match(/^\/api\/projects\/([^/]+)\/conceptual$/);
  if (projectConceptualMatch && request.method === 'GET') {
    if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
    const project = await accounts.getProjectForUser(userId, decodeURIComponent(projectConceptualMatch[1]));
    if (!project) throw new AccountHttpError(404, 'Project not found');
    if (!project.analysis_id) {
      return { statusCode: 200, body: { status: 'no_analysis', project_id: project.id } };
    }
    try {
      const workspace = workspacePath(dataDir, project.analysis_id);
      const url = new URL(request.url || '', 'http://localhost');
      const target = url.searchParams.get('target') || undefined;
      const include = url.searchParams.get('include') || undefined;
      // Honor an explicit max_flows query param (previously the gap text told
      // callers to "Pass max_flows" but this route hardcoded maxFlows: 20 and
      // ignored anything the caller sent — ship the param for real. Bounded:
      // this projection already strips the heavy evidence tiers below, but an
      // unbounded HTTP request is still a bigger CAS-compute footprint than
      // the MCP tool surface's own budgeting assumes.
      //
      // P0 (rank before truncating): the ceiling was never the bug — the ORDER
      // was. The window used to be whatever derivation produced first, which
      // correlates with SHALLOW, and there was no page 2 at all, so flow #51+
      // was unreachable through this route by any means. Flows are now RANKED
      // by significance before the cap applies (query.getFlowConcepts ->
      // rankStoredFlowRefs) and `offset` pages through that same ranked order,
      // so the ceiling bounds a PAGE rather than bounding the product.
      const maxFlowsParamRaw = url.searchParams.get('max_flows');
      const maxFlowsParam = maxFlowsParamRaw !== null ? Number(maxFlowsParamRaw) : undefined;
      const maxFlows = maxFlowsParam !== undefined && Number.isFinite(maxFlowsParam) && maxFlowsParam > 0
        ? Math.min(Math.floor(maxFlowsParam), CONCEPTUAL_MAX_FLOWS_CEILING)
        : CONCEPTUAL_DEFAULT_MAX_FLOWS;
      const offsetParamRaw = url.searchParams.get('offset');
      const offsetParam = offsetParamRaw !== null ? Number(offsetParamRaw) : undefined;
      const offset = offsetParam !== undefined && Number.isFinite(offsetParam) && offsetParam > 0
        ? Math.floor(offsetParam)
        : 0;
      // Response cache (TASK: whale-CAS /conceptual 524s): the payload below is
      // a pure function of the stored CAS + (target, include). Fresh compute on
      // a 45k-node CAS costs seconds of synchronous CPU (CAS JSON parse +
      // getFlowConcepts + getArchitecturalConflicts + getParadigmConformance +
      // getPerspectives) — exactly what starves the loop during a re-analysis.
      // On a hit we skip ALL of it and replay the byte-identical body.
      const version = await storedAnalysisVersion(workspace);
      const cacheKey = version === null ? null : responseCacheKey({
        endpoint: 'conceptual',
        projectId: project.id,
        analysisId: project.analysis_id,
        version,
        // maxFlows must be in the cache key: two requests differing only by
        // max_flows produce different flow counts/truncation and must not
        // share a cached body (would silently serve a stale-cap response).
        // offset joins maxFlows in the cache key for the identical reason: two
        // requests differing only by page must not share a cached body.
        params: { target, include, maxFlows: String(maxFlows), offset: String(offset) },
      });
      if (cacheKey) {
        const cached = casReadResponseCache.get(cacheKey);
        if (cached !== undefined) {
          return { statusCode: 200, body: JSON.parse(cached), serializedBody: cached };
        }
      }
      const cas = await getAnalysis(workspace);
      // Must forward include as detail — getFlowConcepts strips facet_provenance/code_mappings
      // by default regardless of the HTTP-layer include=full strip being skipped.
      // TELEMETRY facet (ICELOT facet 6): join persisted runtime metrics onto
      // flow/step contracts, evidence-gated — omitted (not fabricated) when no
      // observation matches. This endpoint previously never loaded or passed
      // runtime metrics into getFlowConcepts at all, unlike the MCP
      // `get_flow_concepts` tool (server.ts runtimeMetricsForContract), so
      // every flow/step contract read through the web UI / cross-project HTTP
      // surface was silently missing facet 6 even when real production
      // telemetry existed. `workspace` is the SAME key `cas` was just loaded
      // under, so it is also the correct key to read this project's telemetry
      // under (loadTelemetryObservations / ingestTelemetryBatch key their
      // store off this identical projectPath string). Computed only on the
      // cache-miss path below (cas is already in memory here at zero extra
      // parse cost); a cache-HIT response intentionally skips this — see the
      // response-cache comment above this block — so it stays as fast as
      // before for a whale CAS, at the cost of serving telemetry that is only
      // as fresh as the last cache-invalidating CAS version bump.
      const runtimeMetrics = await (async () => {
        try {
          const loadObservations = () => loadTelemetryObservations(workspace);
          let result = await loadObservations();
          if (result.observations.some(o => o?.correlation?.status === 'unmatched')) {
            const backfill = await backfillIngestedTelemetry(cas, workspace).catch(() => null);
            if (backfill && backfill.upgraded > 0) result = await loadObservations();
          }
          if (!result.observations || result.observations.length === 0) return [];
          return buildNodeRuntimeMetrics(cas, result.observations);
        } catch {
          return [];
        }
      })();
      const flowConcepts = getFlowConcepts(cas, { target, maxFlows, offset, surface: 'http', detail: include === 'full' ? 'full' : 'compact', runtimeMetrics });
      // Endpoint projection (re-validation F1): D2 facet_provenance + D1
      // code_mappings inflated per-flow weight ~3-4x (whale payload 96KB+ at 20
      // flows). The web UI renders neither yet — strip them from THIS projection
      // only; the full data stays on the MCP tool surface (get_flow_concepts),
      // which carries its own budget. `include=full` opts back in.
      if (url.searchParams.get('include') !== 'full' && Array.isArray((flowConcepts as { flows?: unknown[] }).flows)) {
        const stripContract = (contract: Record<string, unknown> | undefined) => {
          if (!contract || typeof contract !== 'object') return contract;
          const { facet_provenance: _fp, ...rest } = contract as Record<string, unknown>;
          return rest;
        };
        (flowConcepts as { flows: Array<Record<string, unknown>> }).flows =
          (flowConcepts as { flows: Array<Record<string, unknown>> }).flows.map(flow => ({
            ...flow,
            contract: stripContract(flow.contract as Record<string, unknown> | undefined),
            steps: Array.isArray(flow.steps)
              ? (flow.steps as Array<Record<string, unknown>>).map(step => {
                  const { code_mappings: _cm, code_mappings_truncated: _cmt, ...rest } = step;
                  return { ...rest, contract: stripContract(step.contract as Record<string, unknown> | undefined) };
                })
              : flow.steps,
          }));
      }
      const architectural = getArchitecturalConflicts(cas, { limit: 25 });
      const paradigms = getParadigmConformance(cas);
      const perspectives = getPerspectives(cas);
      // Capability <-> flow linkage, BOTH directions readable, M:N with the
      // ROLE ON THE EDGE (docs/SEMANTIC-MODEL.md: flow roles are RELATIONAL,
      // not intrinsic): each flow carries capability_relationships (plus the
      // back-compat primary capability_id); the capability side carries
      // related_flows — one {flow_id, role, rationale} edge per returned flow
      // that relates to it — so the UI can render the capability -> flow
      // hierarchy (with roles) without joining client-side.
      const flowEdgesByCapability = new Map<string, Array<{ flow_id: string; role: string; rationale: string }>>();
      for (const flow of (flowConcepts.flows || []) as Array<{
        flow_id: string;
        capability_relationships?: Array<{ capability_id: string; role: string; rationale: string }>;
      }>) {
        for (const rel of flow.capability_relationships || []) {
          const list = flowEdgesByCapability.get(rel.capability_id) || [];
          list.push({ flow_id: flow.flow_id, role: rel.role, rationale: rel.rationale });
          flowEdgesByCapability.set(rel.capability_id, list);
        }
      }
      // PREFER the analysis-time-persisted, un-capped `related_flows` (see
      // orchestrator.ts's deriveEntryPointContractAndCapability) over the
      // per-request derivation above, which only sees `flowConcepts.flows` —
      // itself capped by `maxFlows` (default 20, bounded 50 even with an
      // explicit param). Before this, a capability whose real flows didn't
      // land inside that capped browse window showed 0 flows here even
      // though the relationship genuinely existed — the "most capabilities
      // show 0 flows" bug. Only take this shortcut for the untargeted browse
      // case: a `target` query is deliberately asking "what relates to THIS
      // entry point," and the per-request derivation above already answers
      // that narrowly and correctly; an older analysis that predates this
      // fix simply has no persisted `related_flows` and falls through to the
      // capped per-request derivation as before (degraded, not broken).
      const capabilities = (cas.system_capabilities || []).map(capability => ({
        id: capability.id,
        name: capability.name,
        ...conceptualDescriptionFields(capability),
        category: capability.category,
        criticality: capability.criticality,
        related_flows: (!target && capability.related_flows && capability.related_flows.length > 0)
          ? capability.related_flows
          : (flowEdgesByCapability.get(capability.id) || []),
      }));
      // GHOST FIX (klauro-surfaces-exposure): a flow's capability_relationships
      // may legitimately point at a behavior_surfaces entry, not just a
      // system_capabilities one — buildTerminalFlows (flow-concepts.ts) derives
      // relationships against system_capabilities ∪ behavior_surfaces on
      // purpose, since a flow rooted at a registered command/event/mcp-tool
      // handler is genuinely owned by that surface (SURFACES ARE NOT
      // CAPABILITIES — docs/SEMANTIC-MODEL.md). Before this fix, this endpoint
      // only serialized `capabilities` from cas.system_capabilities, so any
      // capability_id resolving to a surface (e.g. Klauro's own
      // cap_mcp_tool_surface, ~44 MCP-tool flows) was a dangling id a consumer
      // could never resolve — the edge existed in flowEdgesByCapability but its
      // node was never in the response. Serialize surfaces as their own
      // (compact, navigation-tier) array alongside capabilities rather than
      // merging them into `capabilities`, preserving the same tier separation
      // get_summary/get_system_overview already enforce.
      const behaviorSurfaces = (cas.behavior_surfaces || []).map(surface => ({
        id: surface.id,
        name: surface.structural_label || surface.name,
        ...conceptualDescriptionFields(surface),
        category: surface.category,
        evidence_kind: surface.evidence_kind,
        entry_points: surface.operations?.length || 0,
        // Same persisted-first preference as `capabilities` above — surfaces
        // get related_flows written by the same analysis-time pass.
        related_flows: (!target && surface.related_flows && surface.related_flows.length > 0)
          ? surface.related_flows
          : (flowEdgesByCapability.get(surface.id) || []),
      }));
      const body = {
        status: 'ready',
        project_id: project.id,
        analysis_id: project.analysis_id,
        capabilities,
        ...(behaviorSurfaces.length ? { behavior_surfaces: behaviorSurfaces } : {}),
        flows: flowConcepts,
        structural: {
          architectural,
          paradigms,
          perspectives,
        },
      };
      const serializedBody = JSON.stringify(body);
      if (cacheKey) casReadResponseCache.set(cacheKey, serializedBody);
      return { statusCode: 200, body, serializedBody };
    } catch (error) {
      return {
        statusCode: 200,
        body: {
          status: 'no_analysis',
          project_id: project.id,
          analysis_id: project.analysis_id,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  const projectReanalyzeMatch = route.match(/^\/api\/projects\/([^/]+)\/reanalyze$/);
  if (projectReanalyzeMatch && request.method === 'POST') {
    if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
    const project = await accounts.getProjectForUser(userId, decodeURIComponent(projectReanalyzeMatch[1]));
    if (!project) throw new AccountHttpError(404, 'Project not found');

    // Product model: the client (laptop) reads its own repo and uploads a
    // compressed snapshot; the server analyzes and discards. `local_path` is
    // the USER'S laptop path — it is never meaningful on this host, so
    // reanalyze must never read from it. Instead, re-run analysis on the
    // last-uploaded snapshot already persisted at workspacePath(analysis_id)
    // (the same workspace handleAnalyze/handleSync write to and keep).
    if (!project.analysis_id) {
      return {
        statusCode: 409,
        body: {
          status: 'no_snapshot',
          project_id: project.id,
          error: 'No uploaded snapshot yet for this project. Run `klauro analyze` in the repo (or `klauro init`) to push an analysis before reanalyzing.',
        },
      };
    }
    const analysisId = project.analysis_id;
    const workspace = workspacePath(dataDir, analysisId);
    let sourceRoot = workspace;
    if (!(await fs.pathExists(workspace))) {
      return {
        statusCode: 409,
        body: {
          status: 'no_snapshot',
          project_id: project.id,
          analysis_id: analysisId,
          error: 'No uploaded snapshot found for this project on the server. Run `klauro analyze` in the repo (or `klauro init`) to push an analysis before reanalyzing.',
        },
      };
    }
    const displayName = resolveDisplayName(undefined, project.name);
    const dataDirForBackground = dataDir;
    const workspaceIdForBackground = project.workspace_id;

    // Must answer 202 and run analyzeProjectLayered in the background — a full
    // rebuild can take minutes, well past the edge/client request timeout, so
    // awaiting it synchronously drops the connection before the analysis lands.
    let manifestForResponse: SourceManifest;
    let baseCommitForResponse: string | undefined;
    if (sourceRoot === workspace) {
      manifestForResponse = await buildWorkspaceManifest(workspace);
    } else {
      // Operator fallback: source exists on this host — rebuild the snapshot
      // from it and refresh the stored workspace BEFORE the background analysis
      // reads it (must complete before we answer so the workspace is coherent).
      const snapshot = await buildSourceSnapshot(sourceRoot);
      await fs.remove(workspace);
      await fs.ensureDir(workspace);
      await writeSnapshot(workspace, snapshot.files);
      manifestForResponse = snapshot.manifest;
      baseCommitForResponse = snapshot.base_commit;
    }

    const attemptRecordPath = projectAttemptRecordPath(workspace);
    // Queue visibility (instrumentation only, see the workspace-reanalyze
    // handler above for the full rationale): queued_at/queue_position are
    // captured NOW, at accept time; started_at is captured separately below,
    // inside the setImmediate callback, once execution genuinely begins.
    const attemptQueuedAt = new Date().toISOString();
    const attemptQueuePosition = inFlightReanalyzeCount;
    inFlightReanalyzeCount += 1;
    setImmediate(async () => {
      const attemptStartedAt = new Date().toISOString();

      // Loop-breaker pre-check (analyzer.ts's checkDoomedVersionRebuild) MUST
      // run BEFORE the 'in-progress' write just below — both this handler and
      // analyzer.ts's internal version-rebuild tracking share the exact same
      // sidecar file (see ReanalyzeAttemptRecord.stored_version's doc
      // comment). Writing 'in-progress' first would erase the failed +
      // version-stamped record the guard depends on before it ever got read,
      // so a doomed rebuild would repeat every time regardless of the guard
      // living inside analyzeProjectIncremental.
      const doomedReason = await checkDoomedVersionRebuild(workspace).catch(() => null);
      if (doomedReason) {
        console.error(`[Klauro] async reanalyze REFUSED for ${analysisId}: ${doomedReason}`);
        await markBackgroundAnalysisFailed(workspace, doomedReason);
        await writeAttemptRecord(attemptRecordPath, {
          state: 'failed',
          trigger: 'reanalyze',
          queued_at: attemptQueuedAt,
          queue_position: attemptQueuePosition,
          started_at: attemptStartedAt,
          finished_at: attemptStartedAt,
          duration_ms: 0,
          reason: doomedReason.slice(0, 300),
        });
        inFlightReanalyzeCount = Math.max(0, inFlightReanalyzeCount - 1);
        if (dataDirForBackground) {
          await appendAuditLog(dataDirForBackground, {
            event: 'reanalyze_async_failed',
            analysis_id: analysisId,
            project_id: project.id,
            error: doomedReason.slice(0, 500),
          }).catch(() => {});
        }
        return;
      }

      const reanalyzeAttemptSnapshot: ReanalyzeAttemptRecord = {
        state: 'in-progress',
        trigger: 'reanalyze',
        queued_at: attemptQueuedAt,
        queue_position: attemptQueuePosition,
        started_at: attemptStartedAt,
      };
      await writeAttemptRecord(attemptRecordPath, { ...reanalyzeAttemptSnapshot, heartbeat_at: attemptStartedAt });
      // STRANDED-ANALYSIS: heartbeat while this reanalyze's background work
      // runs. The per-phase writes below (onPhase) already refresh the
      // record on phase boundaries, but a single phase — especially L5 AI
      // enrichment — can run for a while with no boundary to piggyback on;
      // this interval is what keeps the record's liveness signal independent
      // of phase-transition timing. Stopped in the finally below on every
      // exit path (success, failure, or the early workspace-missing return).
      const stopReanalyzeHeartbeat = startAttemptHeartbeat(attemptRecordPath, reanalyzeAttemptSnapshot);

      // Real-content check, done AFTER the write above (not a bare
      // fs.pathExists earlier in this callback): writeAttemptRecord persists
      // the sidecar via writeJsonAtomic, which calls
      // fs.ensureDir(path.dirname(...)) as a side effect — since the sidecar
      // lives INSIDE the workspace directory itself
      // (projectAttemptRecordPath), that ensureDir silently RECREATES a
      // workspace directory that was genuinely removed between accept and
      // background-start (e.g. an operator/tooling deleting a stale
      // snapshot). A bare existence check anywhere in this callback would be
      // defeated by that recreate — regardless of exactly when the deletion
      // raced in, this directory would read back as "exists" once
      // ensureDir has run. Checking for REAL content (anything besides the
      // sidecar we just wrote) instead of bare existence survives that
      // recreate: an operator-deleted workspace reads back as containing
      // ONLY the sidecar (or nothing at all, if the deletion raced in AFTER
      // this write and removed it too), either way caught here — and
      // reported the same honest "no snapshot" failure analyzeProjectLayered
      // itself would have surfaced when this ran fully in-process, now
      // independent of the extra latency the worker-isolation/loop-breaker
      // dispatch path introduces before the analysis itself would notice.
      const attemptSidecarName = path.basename(attemptRecordPath);
      const workspaceEntries = await fs.readdir(workspace).catch(() => [] as string[]);
      if (!workspaceEntries.some(name => name !== attemptSidecarName)) {
        const detail = `Project path does not exist: ${workspace}`;
        console.error(`[Klauro] async reanalyze failed for ${analysisId}: ${detail}`);
        await markBackgroundAnalysisFailed(workspace, detail);
        const attemptFinishedAt = new Date().toISOString();
        await writeAttemptRecord(attemptRecordPath, {
          state: 'failed',
          trigger: 'reanalyze',
          queued_at: attemptQueuedAt,
          queue_position: attemptQueuePosition,
          started_at: attemptStartedAt,
          finished_at: attemptFinishedAt,
          duration_ms: Date.parse(attemptFinishedAt) - Date.parse(attemptStartedAt),
          reason: detail.slice(0, 300),
        });
        inFlightReanalyzeCount = Math.max(0, inFlightReanalyzeCount - 1);
        if (dataDirForBackground) {
          await appendAuditLog(dataDirForBackground, {
            event: 'reanalyze_async_failed',
            analysis_id: analysisId,
            project_id: project.id,
            error: detail.slice(0, 500),
          }).catch(() => {});
        }
        stopReanalyzeHeartbeat();
        return;
      }

      try {
        // The layered pipeline (L0 -> L1-4 -> L5 AI enrichment) now runs
        // INSIDE the heap-capped analysis worker (analyzer.ts's
        // runLayeredAnalysis), not in this API process — see the 2026-07-18
        // incident notes on runLayeredAnalysis. This function's own resolved
        // value is only a small counts summary; the landed CAS is reloaded
        // from storage (getAnalysis) at each phase boundary, matching the
        // 275e9dc7 pattern the sync routes already use.
        let l14RevisionAppended: Promise<void> | null = null;
        await runLayeredAnalysis(workspace, {
          displayName,
          onPhase: (event) => {
            // Best-effort phase-lifecycle visibility; never blocks the
            // pipeline itself, and never regresses a later phase's state with
            // a stale earlier one (each write carries its own timestamp).
            void writeAttemptRecord(attemptRecordPath, {
              state: event.status === 'succeeded' ? 'in-progress' : 'failed',
              trigger: 'reanalyze',
              queued_at: attemptQueuedAt,
              queue_position: attemptQueuePosition,
              started_at: attemptStartedAt,
              ...(event.status === 'failed' ? {
                finished_at: new Date().toISOString(),
                reason: `${event.phase}-phase-failed: ${event.error ?? 'unknown error'}`.slice(0, 300),
              } : {}),
            }).catch(() => {});

            // Wait for the full deterministic pipeline (L1-L4) so the
            // persisted CAS is a real analysis, not just the L0 stub, before
            // appending a revision — mirrors the pre-worker-isolation
            // behavior exactly, just reloaded from disk instead of held
            // in-memory across the IPC boundary.
            if (event.phase === 'rest' && event.status === 'succeeded' && !l14RevisionAppended) {
              l14RevisionAppended = (async () => {
                try {
                  const landedOutput = await getAnalysis(workspace);
                  // repo_facts regression fix: this run has no client .git in
                  // reach (server-side rebuild of the stored snapshot) — fall
                  // back to the project's last-known client-derived repo_facts,
                  // or stamp an honest absence reason, rather than silently
                  // shipping the CAS without the keys.
                  await stampRepoFactsFromLastKnownOrMarkAbsent(workspace, landedOutput, project.repo_facts);
                  const backgroundResult: RemoteAnalyzeResponse = {
                    status: 'success',
                    analysis_id: analysisId,
                    analysis_revision: Date.now(),
                    analysis_type: 'full',
                    base_commit: baseCommitForResponse,
                    manifest: manifestForResponse,
                    cas: landedOutput,
                  };
                  if (dataDirForBackground) {
                    await appendProjectRevision(dataDirForBackground, backgroundResult, 'local_commit_submission');
                    await appendAuditLog(dataDirForBackground, {
                      event: 'reanalyze',
                      analysis_id: analysisId,
                      project_id: project.id,
                      nodes: landedOutput.nodes.length,
                      edges: landedOutput.edges.length,
                      mode: 'async',
                    }).catch(() => {});
                  }
                  // This route is already project-scoped, so the owning
                  // workspace is known directly — no analysis_id lookup needed.
                  workspaceAnalyses?.notifyProjectAnalysisLanded(workspaceIdForBackground);
                } catch (revisionError) {
                  const detail = revisionError instanceof Error ? revisionError.message : String(revisionError);
                  console.error(`[Klauro] reanalyze L1-4 revision append failed for ${analysisId}: ${detail}`);
                }
              })();
            }
          },
        });
        if (l14RevisionAppended) await l14RevisionAppended;

        // The L5 AI-comprehension pass has now settled (successfully, or with
        // a VISIBLE terminal 'error' state on the CAS — never a silent hang;
        // see summary.aiEnrichment). Re-append the (possibly enriched, or
        // honestly-errored) final CAS + re-notify so pollers and the
        // workspace rollup see it, not just the L1-L4 revision above.
        const finalOutput = await getAnalysis(workspace);
        await stampRepoFactsFromLastKnownOrMarkAbsent(workspace, finalOutput, project.repo_facts);
        if (dataDirForBackground) {
          await appendProjectRevision(dataDirForBackground, {
            status: 'success',
            analysis_id: analysisId,
            analysis_revision: Date.now(),
            analysis_type: 'full',
            base_commit: baseCommitForResponse,
            manifest: manifestForResponse,
            cas: finalOutput,
          }, 'local_commit_submission').catch(() => {});
        }
        workspaceAnalyses?.notifyProjectAnalysisLanded(workspaceIdForBackground);
        const attemptFinishedAt = new Date().toISOString();
        await writeAttemptRecord(attemptRecordPath, {
          state: 'succeeded',
          trigger: 'reanalyze',
          queued_at: attemptQueuedAt,
          queue_position: attemptQueuePosition,
          started_at: attemptStartedAt,
          finished_at: attemptFinishedAt,
          duration_ms: Date.parse(attemptFinishedAt) - Date.parse(attemptStartedAt),
        });
        inFlightReanalyzeCount = Math.max(0, inFlightReanalyzeCount - 1);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[Klauro] async reanalyze failed for ${analysisId}: ${detail}`);
        // Make the failure VISIBLE to pollers instead of leaving the ladder
        // 'pending' forever (see markBackgroundAnalysisFailed). NOTE:
        // markBackgroundAnalysisFailed only flips layers still 'pending' — a
        // reanalyze of an already-'ready' analysis has NO pending layer left
        // to flip, so it is a no-op there and the CAS keeps reading 'ready'.
        // The attempt record below is what actually makes THIS failure
        // visible in that (the common) case.
        await markBackgroundAnalysisFailed(workspace, detail);
        // Preserve stored_version/current_version if this crash's own
        // phase-message write (or the worker's internal
        // writeInternalRebuildAttempt, same shared file) already stamped
        // them — overwriting them away here would blind the loop-breaker to
        // a repeat of this exact doomed rebuild on the NEXT request.
        const existingAttempt = await readAttemptRecord(attemptRecordPath);
        const attemptFinishedAt = new Date().toISOString();
        await writeAttemptRecord(attemptRecordPath, {
          state: 'failed',
          trigger: 'reanalyze',
          queued_at: attemptQueuedAt,
          queue_position: attemptQueuePosition,
          started_at: attemptStartedAt,
          finished_at: attemptFinishedAt,
          duration_ms: Date.parse(attemptFinishedAt) - Date.parse(attemptStartedAt),
          reason: detail.slice(0, 300),
          ...(existingAttempt?.stored_version ? {
            stored_version: existingAttempt.stored_version,
            current_version: existingAttempt.current_version,
          } : {}),
        });
        inFlightReanalyzeCount = Math.max(0, inFlightReanalyzeCount - 1);
        if (dataDirForBackground) {
          await appendAuditLog(dataDirForBackground, {
            event: 'reanalyze_async_failed',
            analysis_id: analysisId,
            project_id: project.id,
            error: detail.slice(0, 500),
          }).catch(() => {});
        }
      } finally {
        stopReanalyzeHeartbeat();
      }
    });

    return {
      statusCode: 202,
      body: {
        status: 'accepted',
        analysis_id: analysisId,
        base_commit: baseCommitForResponse,
        manifest: manifestForResponse,
      },
    };
  }

  throw new AccountHttpError(404, 'Not found');
}

function resolveMaxBodyBytes(): number {
  const raw = process.env.KLAURO_MAX_BODY_MB || process.env.KLAURO_MAX_UPLOAD_MB;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed * 1024 * 1024);
  }
  return DEFAULT_MAX_BODY_BYTES;
}

async function handleProposalPreview(dataDir: string, request: RemoteProposalPreviewRequest, accountSalt?: string): Promise<unknown> {
  if (!request.snapshot?.files?.length && !request.project_path) {
    throw new Error('Remote proposal preview requires a source snapshot or project_path');
  }
  const rawAnalysisId = request.project_id || makeAnalysisId(request.project_path || request.snapshot?.project_name || 'proposal');
  const analysisId = resolveStorageAnalysisId(rawAnalysisId, accountSalt);
  const workspace = workspacePath(dataDir, `${analysisId}-proposal-source`);
  if (request.snapshot?.files?.length) {
    await fs.remove(workspace);
    await fs.ensureDir(workspace);
    await writeSnapshot(workspace, request.snapshot.files);
  }
  return previewCodebaseIteration({
    path: request.project_path || workspace,
    title: request.title,
    planText: request.plan_text,
    diffText: request.diff_text,
    proposedFiles: request.proposed_files,
    organizationId: request.organization_id,
    projectId: request.project_id,
    codebaseId: request.codebase_id,
    previewBaseUrl: request.preview_base_url,
  });
}

function withinRateLimit(buckets: Map<string, RateLimitBucket>, key: string, limit: number): boolean {
  if (!Number.isFinite(limit) || limit <= 0) return true;
  const now = Date.now();
  const windowStart = now - (now % 60000);
  const bucket = buckets.get(key);
  if (!bucket || bucket.windowStart !== windowStart) {
    buckets.set(key, { windowStart, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

export function requestConsumesMutationRateLimit(method: string | undefined): boolean {
  const normalized = String(method || 'GET').toUpperCase();
  return normalized !== 'GET' && normalized !== 'HEAD' && normalized !== 'OPTIONS';
}

/** One persisted in-flight snapshot record (§WS-B), stored append-only per workspace. */
interface InFlightSnapshotRecord {
  workspace: string;
  agent_id: string;
  org_id?: string;
  base_commit: string;
  branch?: string;
  diff_context: string;
  updated_at: string;
  /**
   * Ambiently-captured, already-redacted `SymbolChange[]` (Fabric-v2 §1.7
   * cross-machine ambient capture) — mirrors same-machine
   * `InFlightSnapshot.changes` (types.ts). Optional/additive: an older
   * publisher, or one whose capture produced nothing, simply omits it.
   */
  changes?: SymbolChange[];
}

/**
 * Append one in-flight snapshot to `<coordination-store-dir>/in-flight.jsonl`,
 * the sibling log to `claims.jsonl` (same per-workspace directory convention
 * as `local-store.ts`'s `getStoreDir`). Append-only, latest-per-agent read
 * back by `readInFlightSnapshots`/reduction on the read side, exactly mirroring
 * how `claims.jsonl` is append-only + LWW-reduced by `presence.ts`.
 */
async function appendInFlightSnapshot(workspaceId: string, snapshot: InFlightSnapshotRecord): Promise<void> {
  const dir = getStoreDir(workspaceId);
  await fs.ensureDir(dir);
  await fs.appendFile(path.join(dir, 'in-flight.jsonl'), `${JSON.stringify(snapshot)}\n`, 'utf8');
}

async function appendAuditLog(dataDir: string, event: Record<string, unknown>): Promise<void> {
  const auditDir = path.join(dataDir, 'audit');
  await fs.ensureDir(auditDir);
  await fs.appendFile(path.join(auditDir, 'events.jsonl'), `${JSON.stringify({
    timestamp: new Date().toISOString(),
    ...event,
  })}\n`, 'utf8');
}

function anonymizeClient(clientId: string): string {
  return crypto.createHash('sha256').update(clientId).digest('hex').slice(0, 16);
}

// Must dispatch through runAnalysis()'s worker-isolated, heap-capped child rather
// than running the rebuild in-process — an in-process OOM takes the whole API
// server down with it, and the crash-loop repeats forever since the version-bump
// invalidation never lets the stale analysis stick. Reload CASOutput from storage
// after the worker returns (it already persisted via saveAnalysis).
async function runIncrementalAnalysisIsolated(
  workspace: string,
  displayName: string | undefined,
): Promise<{ output: Awaited<ReturnType<typeof analyzeProjectIncremental>>['output']; changeReport: RemoteAnalyzeResponse['change_report']; wasFullRebuild: boolean }> {
  const summary = await runAnalysis(workspace, { displayName });
  const output = await getAnalysis(workspace);
  return { output, changeReport: summary.changeReport, wasFullRebuild: summary.wasFullRebuild };
}

async function handleAnalyzeDiff(dataDir: string, request: RemoteAnalyzeDiffRequest, accountSalt?: string): Promise<RemoteAnalyzeResponse> {
  const diff = request.diff_context;
  if (!diff?.files?.length) throw new Error('Remote analyze-diff requires a diff_context with changed source files');
  const rawAnalysisId = request.project_id || makeAnalysisId(request.project_path || diff.target_branch);
  const analysisId = resolveStorageAnalysisId(rawAnalysisId, accountSalt);
  // Scope the diff workspace to the target branch so it never overwrites the
  // full ('/v1/analyze') workspace for the same analysis_id.
  const workspace = workspacePath(dataDir, `${analysisId}-branch-${diff.target_branch}`);
  const displayName = resolveDisplayName(undefined, request.project_path);

  await fs.remove(workspace);
  await fs.ensureDir(workspace);
  await writeSnapshot(workspace, diff.files);

  let cas: Awaited<ReturnType<typeof analyzeProjectIncremental>>['output'];
  let changeReport: RemoteAnalyzeResponse['change_report'];
  let analysisType: 'full' | 'incremental' = 'incremental';
  try {
    const result = await runIncrementalAnalysisIsolated(workspace, displayName);
    cas = result.output;
    changeReport = result.changeReport;
    analysisType = result.wasFullRebuild ? 'full' : 'incremental';
  } catch (error) {
    // Comprehension is AI-only and throws without a provider; ship structure-only
    // (deferred) rather than fail the diff request or emit deterministic prose.
    const message = error instanceof Error ? error.message : String(error);
    if (!/comprehension/i.test(message)) throw error;
    console.error(`[Klauro] remote analyze-diff: comprehension unavailable, returning structure-only CAS (${message})`);
    const deferred = await analyzeProjectDeferred(workspace, displayName);
    cas = deferred.output;
    analysisType = 'full';
  }
  cas.analyzed_track = 'other-branch';
  cas.diff_only = true;
  if (diff.head_commit) cas.base_commit = diff.head_commit;
  cas.branch = diff.target_branch;

  return {
    status: 'success',
    analysis_id: analysisId,
    analysis_revision: Date.now(),
    analysis_type: analysisType,
    base_commit: diff.head_commit,
    manifest: buildDiffManifest(workspace, diff),
    cas,
    change_report: changeReport,
  };
}

function buildDiffManifest(workspace: string, diff: BranchDiffContext): SourceManifest {
  return {
    generated_at: new Date().toISOString(),
    root: workspace,
    branch: diff.target_branch,
    base_commit: diff.head_commit,
    file_count: diff.files.length,
    total_bytes: diff.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0),
    excluded_directories: [],
  };
}

function committedSnapshotIdentity(manifest: SourceManifest, baseCommit?: string): string | null {
  if (!baseCommit) return null;
  return [
    baseCommit,
    manifest.branch || '',
    manifest.snapshot_digest || '',
    manifest.file_count,
    manifest.total_bytes,
  ].join(':');
}

/** The analyzer identity THIS server would produce right now. */
export function currentAnalyzerIdentity(): AnalyzerIdentity {
  const fingerprints = getStageFingerprints();
  return {
    analyzer_build: getBuildIdentity().version,
    parser_fingerprint: fingerprints.parser_fingerprint,
    derived_fingerprint: fingerprints.derived_fingerprint,
  };
}

/**
 * Reads ONLY the `identity` section of the stored analysis (analyzer_build +
 * both stage fingerprints, see cas-sections.ts) — a small JSON read, not a CAS
 * load — and decides whether it may be reused by this server.
 */
export async function analyzerIdentityReuseDecisionFor(workspace: string): Promise<AnalyzerIdentityDecision> {
  let stored: AnalyzerIdentity | null = null;
  try {
    const identity = await loadAnalysisSections(workspace, ['identity'], { track: 'main' });
    if (identity) {
      stored = {
        analyzer_build: (identity as AnalyzerIdentity).analyzer_build,
        parser_fingerprint: (identity as AnalyzerIdentity).parser_fingerprint,
        derived_fingerprint: (identity as AnalyzerIdentity).derived_fingerprint,
      };
    }
  } catch {
    stored = null;
  }
  return decideAnalyzerIdentityReuse(stored, currentAnalyzerIdentity());
}

export function revisionMatchesSnapshot(
  revision: RemoteProjectRevision,
  manifest: SourceManifest,
  baseCommit?: string,
): boolean {
  if (!baseCommit || revision.commit !== baseCommit) return false;
  if (revision.branch && manifest.branch && revision.branch !== manifest.branch) return false;
  if (revision.snapshot_digest && manifest.snapshot_digest) {
    return revision.snapshot_digest === manifest.snapshot_digest;
  }
  return revision.files === manifest.file_count && revision.bytes === manifest.total_bytes;
}

async function appendProjectRevision(dataDir: string, result: RemoteAnalyzeResponse, source: RemoteProjectRevision['source']): Promise<void> {
  const revision: RemoteProjectRevision = {
    analysis_id: result.analysis_id,
    analysis_revision: result.analysis_revision,
    branch: result.manifest.branch,
    commit: result.base_commit || result.manifest.base_commit,
    source,
    generated_at: new Date().toISOString(),
    files: result.manifest.file_count,
    bytes: result.manifest.total_bytes,
    snapshot_digest: result.manifest.snapshot_digest,
    nodes: result.cas.nodes.length,
    edges: result.cas.edges.length,
  };
  const file = projectRevisionsPath(dataDir, result.analysis_id);
  await fs.ensureDir(path.dirname(file));
  let existing: RemoteProjectRevision[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    existing = Array.isArray(parsed.revisions) ? parsed.revisions : [];
  } catch {
    existing = [];
  }
  const withoutDuplicate = existing.filter(item => !(item.commit && revision.commit && item.commit === revision.commit));
  const revisions = [revision, ...withoutDuplicate].slice(0, 200);
  await fs.writeJson(file, { analysis_id: result.analysis_id, revisions }, { spaces: 2 });
}

async function readProjectRevisions(dataDir: string, analysisId: string): Promise<RemoteProjectRevisionsResponse> {
  try {
    const parsed = JSON.parse(await fs.readFile(projectRevisionsPath(dataDir, analysisId), 'utf8'));
    return {
      status: 'success',
      analysis_id: analysisId,
      revisions: Array.isArray(parsed.revisions) ? parsed.revisions : [],
    };
  } catch {
    return { status: 'success', analysis_id: analysisId, revisions: [] };
  }
}

function projectRevisionsPath(dataDir: string, analysisId: string): string {
  return path.join(dataDir, 'project-revisions', `${safeFileName(analysisId)}.json`);
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'project';
}

function clampActivityLimit(raw: string | null): number {
  const parsed = raw !== null ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 200) : 50;
}

/** Two events are "the same analysis run" for the purpose of attaching a
 *  reanalyze attempt's duration_ms onto its matching revision, if their
 *  timestamps land within this window of each other. The revision is
 *  stamped when the CAS is re-read from disk post-pipeline
 *  (appendProjectRevision's `new Date().toISOString()`); the attempt
 *  record's finished_at is stamped moments earlier at the end of the same
 *  background run — never exactly equal, always close. */
const ACTIVITY_DURATION_MATCH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Change Activity events for one project: 'project_created' (project.created_at,
 * always present), 'project_moved' (project.moved_at, present only after at
 * least one attach-to-a-different-workspace — see account-store.ts), plus,
 * when the project has a stored analysis, one 'analysis_completed' per
 * retained revision (project-revisions/<id>.json, capped at 200 by
 * appendProjectRevision) with a node/edge delta computed against the NEXT
 * OLDER revision already in that same array — no extra CAS load, the counts
 * are already on the revision record — and an 'analysis_failed' event if the
 * most recent reanalyze attempt (the sidecar last_attempt record) ended in
 * 'failed'. Cheap and bounded: at most one small JSON file read for
 * revisions + one for the attempt sidecar, no getAnalysis()/CAS load at all.
 */
async function collectProjectActivityEvents(dataDir: string, project: AccountProject, workspaceId: string): Promise<AccountActivityEvent[]> {
  const events: AccountActivityEvent[] = [];
  events.push({
    type: 'project_created',
    at: project.created_at,
    workspace_id: workspaceId,
    project_id: project.id,
    title: `${project.name} added to workspace`,
  });
  if (project.moved_at) {
    events.push({
      type: 'project_moved',
      at: project.moved_at,
      workspace_id: workspaceId,
      project_id: project.id,
      title: `${project.name} moved into this workspace`,
      ...(project.moved_from_workspace_id ? { detail: `Previously in workspace ${project.moved_from_workspace_id}` } : {}),
    });
  }
  if (!project.analysis_id) return events;

  const { revisions } = await readProjectRevisions(dataDir, project.analysis_id);
  const completedEvents: AccountActivityEvent[] = revisions.map((revision, index) => {
    const priorRevision = revisions[index + 1]; // revisions are newest-first
    return {
      type: 'analysis_completed',
      at: revision.generated_at,
      workspace_id: workspaceId,
      project_id: project.id,
      title: `${project.name} analyzed`,
      ...(revision.branch ? { detail: revision.commit ? `${revision.branch} @ ${revision.commit.slice(0, 8)}` : revision.branch } : {}),
      ...(priorRevision ? { deltas: { nodes: revision.nodes - priorRevision.nodes, edges: revision.edges - priorRevision.edges } } : {}),
    };
  });
  events.push(...completedEvents);

  const lastAttempt = await readAttemptRecord(projectAttemptRecordPath(workspacePath(dataDir, project.analysis_id)));
  if (lastAttempt?.state === 'failed' && lastAttempt.finished_at) {
    events.push({
      type: 'analysis_failed',
      at: lastAttempt.finished_at,
      workspace_id: workspaceId,
      project_id: project.id,
      title: `${project.name} analysis failed`,
      ...(lastAttempt.reason ? { detail: lastAttempt.reason } : {}),
    });
  } else if (lastAttempt?.state === 'succeeded' && lastAttempt.finished_at && lastAttempt.duration_ms !== undefined) {
    // Best-effort enrichment only — the attempt sidecar tracks the LAST
    // attempt, not full history, so this can only ever annotate the most
    // recent 'analysis_completed' event, never an older one.
    const finishedAtMs = Date.parse(lastAttempt.finished_at);
    const match = completedEvents.find(event => Math.abs(Date.parse(event.at) - finishedAtMs) < ACTIVITY_DURATION_MATCH_WINDOW_MS);
    if (match) match.duration_ms = lastAttempt.duration_ms;
  }
  return events;
}

/**
 * Change Activity events for one workspace's server-side workspace-level CAS: 'workspace_rebuilt'
 * from the persisted WorkspaceAnalysisRecord (account-workspace-analysis.ts)
 * — at most ONE event since that store keeps only the latest rebuild, not a
 * history — plus an honest 'workspace_enrichment_degraded' negative event
 * when the AI narrative pass landed 'degraded'/'error' rather than 'ai', and
 * a 'workspace_rebuild_failed' event from the reanalyze attempt sidecar when
 * the last rebuild attempt itself threw. No event fabricated for a workspace
 * that has never rebuilt (record is null) or never failed (no sidecar).
 */
async function collectWorkspaceActivityEvents(
  workspaceAnalyses: AccountWorkspaceAnalysisScheduler | undefined,
  dataDir: string,
  workspaceId: string,
  workspaceName: string,
): Promise<AccountActivityEvent[]> {
  const events: AccountActivityEvent[] = [];
  if (workspaceAnalyses) {
    const record = await workspaceAnalyses.load(workspaceId);
    if (record) {
      events.push({
        type: 'workspace_rebuilt',
        at: record.generated_at,
        workspace_id: workspaceId,
        title: `${workspaceName} workspace analysis rebuilt`,
        detail: `${record.member_project_ids.length} member project${record.member_project_ids.length === 1 ? '' : 's'}`,
      });
      if (record.enrichment && (record.enrichment.status === 'degraded' || record.enrichment.status === 'error')) {
        events.push({
          type: 'workspace_enrichment_degraded',
          at: record.enrichment.completed_at || record.generated_at,
          workspace_id: workspaceId,
          title: `${workspaceName} narrative enrichment ${record.enrichment.status}`,
          ...(record.enrichment.reason || record.enrichment.error
            ? { detail: record.enrichment.reason || record.enrichment.error }
            : {}),
        });
      }
    }
  }
  const workspaceLastAttempt = await readAttemptRecord(workspaceAttemptRecordPath(dataDir, workspaceId));
  if (workspaceLastAttempt?.state === 'failed' && workspaceLastAttempt.finished_at) {
    events.push({
      type: 'workspace_rebuild_failed',
      at: workspaceLastAttempt.finished_at,
      workspace_id: workspaceId,
      title: `${workspaceName} rebuild failed`,
      ...(workspaceLastAttempt.reason ? { detail: workspaceLastAttempt.reason } : {}),
    });
  }
  return events;
}

interface PreparedSync {
  analysisId: string;
  workspace: string;
  displayName?: string;
  manifest: SourceManifest;
}

async function prepareSync(dataDir: string, request: RemoteSyncRequest, accountSalt?: string): Promise<PreparedSync> {
  if (!request.analysis_id) throw new Error('Remote sync requires analysis_id');
  // Same resolveStorageAnalysisId salting as /v1/analyze: the client resends
  // the same bare-hash id it computed for the original analyze call, so
  // re-deriving it the same way (same account, same rawId) locates the exact
  // per-account workspace directory the analyze call created. See
  // resolveStorageAnalysisId's doc comment for the full cross-tenant bleed
  // this closes.
  const analysisId = resolveStorageAnalysisId(request.analysis_id, accountSalt);
  const workspace = workspacePath(dataDir, analysisId);
  if (!(await fs.pathExists(workspace))) {
    throw new Error(`No remote workspace found for analysis_id=${request.analysis_id}; run remote analyze first`);
  }

  await applyChanges(workspace, request.changes.changed_files || []);
  const displayName = resolveDisplayName(request.changes.project_name, request.project_path);
  const manifest = request.changes.manifest || buildChangeManifest(workspace, request.changes.changed_files || []);
  return { analysisId, workspace, displayName, manifest };
}

async function completeSync(prepared: PreparedSync, request: RemoteSyncRequest): Promise<RemoteAnalyzeResponse> {
  const result = await runIncrementalAnalysisIsolated(prepared.workspace, prepared.displayName);
  const { analysisId, workspace, manifest } = prepared;
  await stampRepoFacts(workspace, result.output, manifest);
  return {
    status: 'success',
    analysis_id: analysisId,
    analysis_revision: Date.now(),
    analysis_type: result.wasFullRebuild ? 'full' : 'incremental',
    base_commit: request.changes.base_commit,
    manifest,
    cas: result.output,
    change_report: result.changeReport,
  };
}

async function handleSync(dataDir: string, request: RemoteSyncRequest, accountSalt?: string): Promise<RemoteAnalyzeResponse> {
  return completeSync(await prepareSync(dataDir, request, accountSalt), request);
}

async function recordCompletedSync(
  dataDir: string,
  accounts: AccountStore,
  request: RemoteSyncRequest,
  result: RemoteAnalyzeResponse,
  clientId?: string,
): Promise<void> {
  await appendAuditLog(dataDir, {
    event: 'sync',
    analysis_id: result.analysis_id,
    project_id: request.project_id,
    organization_id: request.organization_id,
    files: result.manifest.file_count,
    bytes: result.manifest.total_bytes,
    changed_files: result.change_report
      ? result.change_report.summary.filesAdded + result.change_report.summary.filesModified + result.change_report.summary.filesDeleted
      : undefined,
    nodes: result.cas.nodes.length,
    edges: result.cas.edges.length,
  });
  // `setProjectRepoFacts` itself takes no userId and does not check
  // membership (see its doc comment: it silently no-ops on an unknown id,
  // but a REAL foreign project id was previously stamped unconditionally).
  // `request.analysis_id` is already membership-checked above (the storage
  // write itself), but `project_id` is a separate, independently
  // client-supplied field — gate it too before mutating that project's
  // stored repo_facts metadata.
  if (request.project_id && /^prj_/.test(request.project_id) && (await authorizeProjectWrite(accounts, clientId, request.project_id))) {
    await accounts.setProjectRepoFacts(request.project_id, result.manifest.repo_facts).catch(() => {});
  }
}

/**
 * Copy the client-derived repo_facts (contributor_count/first_commit_at/
 * last_commit_at — see remote-source.ts deriveRepoFacts) from the upload
 * manifest onto CASOutput.system so the /analysis summary and /cas endpoints
 * expose them automatically (both read straight off `cas.system`). The
 * manifest already flows into every response as `manifest.repo_facts`; the
 * CAS itself never saw it because analyzeProjectIncremental/orchestrateAnalysis
 * has no git access into the client's original working tree (it only ever
 * sees the uploaded file snapshot).
 *
 * Re-persists the stamped CAS via saveAnalysis: `output` here was already
 * written to storage by the worker (analyzeProjectIncremental/
 * analyzeProjectDeferred call saveAnalysis internally BEFORE this function
 * ever sees the CAS), so mutating the in-memory object alone would only
 * affect this one HTTP response — a later GET /api/projects/{id}/analysis
 * (a plain disk read, not a re-analysis) would load the un-stamped copy.
 * Additive stamp, not a re-derivation: a no-op (no re-save) when the client
 * omitted repo_facts (non-git / no commits).
 */
export async function stampRepoFacts(workspace: string, cas: CASOutput, manifest: SourceManifest | undefined): Promise<void> {
  if (!manifest?.repo_facts) return;
  cas.system.repo_facts = manifest.repo_facts;
  await saveAnalysis(workspace, cas);
}

/**
 * Server-side reanalyze counterpart to `stampRepoFacts`: `/api/projects/:id/
 * reanalyze` and `/api/workspaces/:id/reanalyze` re-run the analyzer against
 * the STORED snapshot already on this host — there is no client working tree
 * in reach, so `manifest.repo_facts` is never available on these paths (the
 * v1.0.124 regression this closes: repo_facts keys were silently omitted from
 * every server-triggered rebuild's CAS, not just from non-git projects).
 *
 * Falls back to the project's last-known `repo_facts` (persisted by
 * `linkAnalysisToAccountProject`'s repo-facts sibling whenever an `/v1/
 * analyze` or `/v1/sync` push actually carried one) so the keys survive a
 * server-side rebuild instead of disappearing. When NO last-known value
 * exists either (never analyzed from a real git checkout, or a project with
 * no linked account record), stamps an honest `repo_facts_status:
 * {available:false, reason}` marker instead of leaving the CAS silently
 * lacking any explanation — never fabricates a `repo_facts` value.
 */
export async function stampRepoFactsFromLastKnownOrMarkAbsent(
  workspace: string,
  cas: CASOutput,
  lastKnownRepoFacts: RepoFacts | undefined,
): Promise<void> {
  if (lastKnownRepoFacts && (lastKnownRepoFacts.contributor_count !== undefined || lastKnownRepoFacts.first_commit_at || lastKnownRepoFacts.last_commit_at)) {
    cas.system.repo_facts = lastKnownRepoFacts;
    delete cas.system.repo_facts_status;
  } else if (!cas.system.repo_facts) {
    cas.system.repo_facts_status = {
      available: false,
      reason: 'This rebuild ran server-side against the stored snapshot (no client .git in reach), and no prior push for this project ever carried client-derived repo_facts to fall back on. Run `klauro analyze`/`klauro sync` from the repo\'s own git checkout to populate contributors and codebase age.',
    };
  }
  await saveAnalysis(workspace, cas);
}

async function writeSnapshot(workspace: string, files: Array<{ path: string; content: string }>): Promise<void> {
  for (const file of files) {
    const destination = safeDestination(workspace, file.path);
    await fs.ensureDir(path.dirname(destination));
    await fs.writeFile(destination, file.content, 'utf8');
  }
}

async function applyChanges(workspace: string, changes: RemoteFileChange[]): Promise<void> {
  for (const change of changes) {
    const destination = safeDestination(workspace, change.path);
    if (change.status === 'deleted') {
      await fs.remove(destination);
      continue;
    }
    await fs.ensureDir(path.dirname(destination));
    await fs.writeFile(destination, change.content, 'utf8');
  }
}

async function readJsonBody<T>(request: http.IncomingMessage, maxBodyBytes: number): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new Error(`Request body exceeds ${maxBodyBytes} bytes`);
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks);
  const body = request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
  return JSON.parse(body.toString('utf8')) as T;
}

function writeJson(response: http.ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, corsHeaders({ 'content-type': 'application/json' }));
  response.end(JSON.stringify(value));
}

function writeText(response: http.ServerResponse, statusCode: number, contentType: string, body: string): void {
  response.writeHead(statusCode, corsHeaders({ 'content-type': contentType }));
  response.end(body);
}

function publicBaseUrl(request: http.IncomingMessage): string {
  if (process.env.KLAURO_PUBLIC_URL) return process.env.KLAURO_PUBLIC_URL.replace(/\/+$/, '');
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(request.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || request.headers.host || 'mcp.klauro.com';
  const proto = forwardedProto || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

function resolveInstallScriptPath(filename: string): string {
  // Resolve robustly across dev (src/) and bundled dist layouts. The deployed
  // layout is /opt/klauro/source, so also probe from process.cwd(). Only the
  // fixed installer filenames are ever passed in (no user-controlled input).
  const candidates = [
    path.resolve(__dirname, '..', 'scripts', filename),
    path.resolve(__dirname, 'scripts', filename),
    path.resolve(process.cwd(), 'apps', 'mcp-server', 'scripts', filename),
    path.resolve(process.cwd(), 'scripts', filename),
    `/opt/klauro/source/apps/mcp-server/scripts/${filename}`,
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

async function serveInstallScript(response: http.ServerResponse): Promise<void> {
  const scriptPath = resolveInstallScriptPath('install.sh');
  if (!fs.existsSync(scriptPath)) {
    writeText(response, 404, 'text/plain; charset=utf-8', 'install script not found');
    return;
  }
  const body = await fs.readFile(scriptPath, 'utf8');
  writeText(response, 200, 'text/x-shellscript; charset=utf-8', body);
}

async function serveInstallPowershell(response: http.ServerResponse): Promise<void> {
  const scriptPath = resolveInstallScriptPath('install.ps1');
  if (!fs.existsSync(scriptPath)) {
    writeText(response, 404, 'text/plain; charset=utf-8', 'install script not found');
    return;
  }
  const body = await fs.readFile(scriptPath, 'utf8');
  // PowerShell `irm | iex` just needs the raw text; text/plain is the safe MIME.
  writeText(response, 200, 'text/plain; charset=utf-8', body);
}

async function serveTarball(response: http.ServerResponse, requested: string): Promise<void> {
  // Strict: basename only, no traversal, allowlisted filename shape.
  if (requested.includes('/') || requested.includes('..')) {
    writeText(response, 404, 'text/plain; charset=utf-8', 'not found');
    return;
  }
  // .tgz: the npm-fallback tarball. Extensionless/.exe/.sha256: the
  // self-contained per-platform binaries (build-sea-binaries.mjs's outExe
  // names, e.g. klauro-macos-arm64, klauro-win-x64.exe) and their checksum
  // sidecars — install.sh/install.ps1 and self-update.ts's binary self-update
  // fetch these directly.
  const allowed = requested === 'klauro-latest.tgz'
    || /^klauro-[\w.\-]+\.tgz$/.test(requested)
    || /^klauro-(macos|linux|win)-(arm64|x64)(\.exe)?(\.sha256)?$/.test(requested);
  if (!allowed) {
    writeText(response, 404, 'text/plain; charset=utf-8', 'not found');
    return;
  }

  const downloadsDir = process.env.KLAURO_DOWNLOADS_DIR || '/opt/klauro/downloads';
  const filePath = path.join(downloadsDir, requested);
  // Defense in depth: ensure the resolved path stays inside the downloads dir.
  const resolvedDir = path.resolve(downloadsDir);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile !== path.join(resolvedDir, requested)) {
    writeText(response, 404, 'text/plain; charset=utf-8', 'not found');
    return;
  }

  let stat: fs.Stats;
  try {
    stat = await fs.stat(resolvedFile);
  } catch {
    writeText(response, 404, 'text/plain; charset=utf-8', 'tarball not found');
    return;
  }
  if (!stat.isFile()) {
    writeText(response, 404, 'text/plain; charset=utf-8', 'tarball not found');
    return;
  }

  const isBinary = !requested.endsWith('.tgz');
  response.writeHead(200, corsHeaders({
    'content-type': isBinary ? 'application/octet-stream' : 'application/gzip',
    'content-length': String(stat.size),
    'content-disposition': `attachment; filename="${requested}"`,
    // The stable klauro-latest.tgz filename changes contents across releases,
    // so never let npm/CDNs serve stale bits on `klauro update`.
    'cache-control': 'no-cache, must-revalidate',
  }));
  const stream = fs.createReadStream(resolvedFile);
  stream.on('error', () => {
    response.destroy();
  });
  stream.pipe(response);
}

// Public release manifest so the CLI can check for a newer version without
// downloading the 25MB tarball. Served from <downloads>/latest.json when
// present; otherwise synthesized as a bare pointer to the latest tarball.
async function serveLatestManifest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const downloadsDir = process.env.KLAURO_DOWNLOADS_DIR || '/opt/klauro/downloads';
  const manifestPath = path.join(downloadsDir, 'latest.json');
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    manifest = {};
  }
  const base = publicBaseUrl(request);
  const { minNode, maxNode } = resolveHostedReleaseNodeRange(manifest);
  // Self-contained per-platform binaries (§NODE-GATE-PHANTOM / build-sea-binaries.mjs)
  // — the PRIMARY install path. Passed through verbatim from the on-disk
  // manifest written by write-release-manifest.mjs: the nested `binaries` map
  // for JSON consumers (self-update.ts's binary self-update), and flat
  // `bin_<platform>_path`/`bin_<platform>_sha256` fields for install.sh (a
  // POSIX-sh script with no JSON parser). Both absent — not defaulted to
  // anything — when the deployed manifest predates this release or was
  // packaged without running `npm run build:sea` first; every consumer of
  // this field falls back to the npm tarball in that case.
  const binaries = (manifest.binaries as Record<string, { path: string; sha256: string }>) || {};
  const flatBinaryFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key.startsWith('bin_') && typeof value === 'string') flatBinaryFields[key] = value;
  }
  const body = {
    version: (manifest.version as string) || null,
    tarball: `${base}/dist/klauro-latest.tgz`,
    tarball_path: '/dist/klauro-latest.tgz',
    min_node: minNode,
    // No ceiling is advertised unless the on-disk manifest genuinely sets one.
    // The shipped customer tarball (`.customer-package/package.json`, built by
    // build-bundle.mjs) has `dependencies: {}` and zero native addons, so
    // nothing about the client install is Node-version-bounded above
    // min_node — verified empirically: `npm install -g` of the published
    // tarball succeeds and runs on both Node 24 and Node 26. A fixed upper
    // bound here previously defaulted to 24 even though write-release-manifest.mjs
    // never set one; that was a fabricated ceiling, not a measured one, and it
    // actively contradicted docs/audits/2026-08-10-tsgo-node26-audit.md (Node 24
    // fails to COMPILE tree-sitter from source — a fact about building the
    // HOSTED analyzer in this repo, not about running the client). Do not
    // reintroduce a max_node default here without a measurement backing it.
    max_node: maxNode,
    supported_node_range: maxNode === null ? `${minNode}+` : `${minNode}-${maxNode}`,
    published_at: (manifest.published_at as string) || null,
    binaries,
    ...flatBinaryFields,
    // Build identity of the published tarball, so "is the CLI channel in sync
    // with the deployed server" is answerable from the manifest instead of by
    // installing it (deploy.sh's client-channel gate, 2026-07-27 audit).
    git_sha: (manifest.git_sha as string) || null,
    update_command: 'klauro update',
    /** First release whose CLI actually implements `update`. Older clients
     *  must reinstall — through 1.0.127 the command printed usage and exited
     *  0, which is what turned the HTTP 426 remediation into a dead end. */
    update_command_min_version: (manifest.update_command_min_version as string) || '1.0.128',
    install_command: (manifest.install_command as string) || `curl -fsSL ${base}/install.sh | sh`,
  };
  response.writeHead(200, corsHeaders({ 'content-type': 'application/json', 'cache-control': 'no-cache' }));
  response.end(JSON.stringify(body));
}

// Returns the Node range to advertise to installers/updaters. `maxNode` is
// `null` — no ceiling — unless the on-disk manifest supplies a valid one;
// write-release-manifest.mjs deliberately never sets max_node (see its
// comment), because the customer tarball has no native addon to be bounded
// by. Do not resurrect a hardcoded default max here: the customer path is
// verified to run unmodified on Node 24 and Node 26 (see
// docs/audits/2026-08-10-tsgo-node26-audit.md), so a fabricated "24" ceiling
// is actively false, not conservative.
export function resolveHostedReleaseNodeRange(manifest: Record<string, unknown>): { minNode: number; maxNode: number | null } {
  const manifestMin = Number(manifest.min_node);
  const manifestMax = Number(manifest.max_node);
  const minNode = Number.isInteger(manifestMin) && manifestMin > 0 ? manifestMin : 18;
  const maxNode = Number.isInteger(manifestMax) && manifestMax >= minNode && manifestMax <= 99
    ? manifestMax
    : null;
  return { minNode, maxNode };
}

function bearerToken(request: http.IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim() || undefined;
}

function writeNoContent(response: http.ServerResponse, statusCode: number): void {
  response.writeHead(statusCode, corsHeaders());
  response.end();
}

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'access-control-allow-origin': process.env.KLAURO_ALLOWED_ORIGIN || '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    vary: 'origin',
    ...extra,
  };
}

function safeDestination(workspace: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const destination = path.resolve(workspace, normalized);
  if (!(destination === workspace || destination.startsWith(`${workspace}${path.sep}`))) {
    throw new Error(`Refusing to write path outside workspace: ${relativePath}`);
  }
  return destination;
}

function workspacePath(dataDir: string, analysisId: string): string {
  return path.join(dataDir, 'workspaces', safeName(analysisId));
}

// --- Progressive readiness during an in-progress attempt --------------------
// #129 fixed a real defect: while `lastAttempt.state === 'in-progress'`, the
// CAS entry already landed on disk is necessarily from BEFORE this attempt
// (or a foreign leftover), so serving it as 'ready' told a customer stale
// data was fresh. The fix made 'in-progress' unconditionally return bare
// 'populating', regardless of what `entry` holds.
//
// That fix over-corrects for one case: `analyzer.ts`'s layered pipeline
// deliberately lands and SAVES a real CAS the moment L0-L4 (the deterministic
// core-graph/agent-context ladder) complete, with `layers_ready` L0-L4
// 'ready' and L5 'pending' — well before the AI comprehension pass (L5)
// finishes and the attempt record itself flips to 'succeeded'. On a repo
// where AI enrichment dominates wall time, that gap is real: the entry this
// function inspects can be the CURRENT attempt's own already-landed
// deterministic output, not a stale leftover, and blanket 'populating' hides
// genuinely fresh, queryable data behind the L5 tail for no honesty reason.
//
// Distinguishing the two without reintroducing #129: only trust `entry` as
// belonging to THIS attempt if its `layers_ready.generated_at` is at or after
// `lastAttempt.started_at` — anything older is exactly the #129 stale case
// and must stay 'populating'. Returns null whenever the entry isn't usable
// this way (no entry, stale entry, structural layers not all ready, or L5 is
// not simply 'pending' — an L5 error/ready entry is handled by the callers'
// normal landed-analysis path, not this in-progress overlay).
// TASK #143: the compact summary served during the 'queryable' window
// (L0-L4 ready, L5 still pending). Falls back to entry-only counts if the
// full CAS somehow cannot be read (e.g. a race with a concurrent write) —
// never throws and never blocks the caller from at least seeing the
// counts-and-layers view that used to be all this window offered.
async function buildQueryableSummary(
  analysisWorkspace: string,
  entry: { name: string; analyzed_at: string; node_count: number; edge_count: number; cas_version?: string; layers_ready?: unknown },
): Promise<Record<string, unknown>> {
  try {
    const cas = await getAnalysis(analysisWorkspace);
    const summary = buildSummary(cas, { detail: 'compact' }) as Record<string, unknown>;
    return { ...summary, layers_ready: entry.layers_ready };
  } catch {
    return {
      name: entry.name,
      analysis_timestamp: entry.analyzed_at,
      node_count: entry.node_count,
      edge_count: entry.edge_count,
      cas_version: entry.cas_version,
      layers_ready: entry.layers_ready,
    };
  }
}

// TASK #143: pure classification, extracted for unit testing the same way
// structuralReadinessDuringAttempt below is — the honesty split between a
// terminal comprehension FAILURE (the AI pass itself errored; no
// deterministic fallback exists) and a PARTIAL enrichment shortfall (the
// pass ran, most capabilities were AI-named, a handful were not, under
// budget pressure). Only the former may ever produce the terminal 'degraded'
// status; the latter reports 'ready' with the specific gap named (see the
// `/analysis` route's `comprehension.unenriched_capabilities`).
export function classifyComprehensionOutcome(input: {
  aiDegraded: boolean;
  comprehensionAttempted: boolean;
  namingTotal?: number;
  namingAuthored?: number;
  nameDegradationCount: number;
  descriptionDegradationCount: number;
}): { comprehensionFailed: boolean; comprehensionPartial: boolean } {
  const comprehensionFailed = input.aiDegraded;
  // TASK #143 defect found while writing this function's own test: the prior
  // inline check only asked "did the pass author NOTHING at all"
  // (namingAuthored === 0) — so the exact prod scenario ("2 of 12
  // capabilities shipped without AI enrichment") satisfied none of these
  // conditions and was reported as fully healthy, not even 'degraded'. Item
  // 2 of this task ("honest gaps, never silent ones") requires ANY shortfall
  // (authored < total, not just authored === 0) to surface.
  const comprehensionPartial = !input.aiDegraded && (
    input.descriptionDegradationCount > 0
    || input.nameDegradationCount > 0
    || Boolean(
        input.comprehensionAttempted
        && input.namingTotal !== undefined && input.namingTotal > 0
        && input.namingAuthored !== undefined && input.namingAuthored < input.namingTotal
      )
  );
  return { comprehensionFailed, comprehensionPartial };
}

export function structuralReadinessDuringAttempt(
  entry: { layers_ready?: { layers?: Array<{ layer: string; status: string }>; generated_at?: string } } | null | undefined,
  lastAttempt: { started_at?: string } | null | undefined,
): { layers: Array<{ layer: string; status: string }>; generatedAt: string } | null {
  const generatedAt = entry?.layers_ready?.generated_at;
  const startedAt = lastAttempt?.started_at;
  if (!generatedAt || !startedAt) return null;
  if (Date.parse(generatedAt) < Date.parse(startedAt)) return null;
  const layers = entry?.layers_ready?.layers || [];
  const structuralErrors = layers.some(layer => layer.layer !== 'L5' && layer.status === 'error');
  const structuralPending = layers.some(layer => layer.layer !== 'L5' && layer.status === 'pending');
  if (structuralErrors || structuralPending) return null;
  const l5 = layers.find(layer => layer.layer === 'L5');
  if (!l5 || l5.status !== 'pending') return null;
  return { layers, generatedAt };
}

function makeAnalysisId(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

// --- Reanalyze last-attempt visibility (defect #41) -------------------------
// A background reanalyze that throws BEFORE writing any CAS (or that reuses an
// already-'ready' analysis, so markBackgroundAnalysisFailed has no 'pending'
// layer left to flip to 'error' — see its doc comment) leaves GET
// /api/projects/:id/analysis serving the OLD analysis at status:'ready',
// errors:0, with nothing indicating a newer attempt failed. Measured live
// twice on 2026-07-16 (an AI grounding gate hard-failure, and earlier a torn
// deploy). Fix: persist a tiny sidecar recording the LAST reanalyze attempt's
// lifecycle (in-progress / succeeded / failed + reason), independent of
// whatever the CAS itself says, and surface it additively on the analysis
// response so a poller can see a failed/in-flight attempt even when the
// served CAS is untouched. Best-effort: never throws, never blocks the
// reanalyze it is describing.
type ReanalyzeAttemptState = 'in-progress' | 'succeeded' | 'failed';

interface ReanalyzeAttemptRecord {
  state: ReanalyzeAttemptState;
  // 'analyze' is the FIRST-analyze async path (POST /v1/analyze, async:
  // true) — see STRANDED-ANALYSIS below. It shares this exact sidecar
  // shape/writer with 'reanalyze' so both are reapable by the same code.
  trigger: 'reanalyze' | 'sync' | 'analyze';
  /** When the request was accepted (202'd), before the background work has
   *  necessarily started executing — see `started_at` below. */
  queued_at?: string;
  /** How many other reanalyze attempts on this process were already between
   *  accepted-and-finished when THIS one was queued. Not a real scheduler
   *  position (nothing here gates or serializes execution) — an observability
   *  counter that correlates with real contention on a single-threaded event
   *  loop with CPU-bound analyzer work. See inFlightReanalyzeCount. */
  queue_position?: number;
  /** When this attempt's background work actually began executing (captured
   *  inside the deferred callback, NOT at accept time) — previously conflated
   *  with queued_at/accept time, which hid how long a request sat waiting
   *  its turn on a busy process. */
  started_at: string;
  finished_at?: string;
  /** finished_at - started_at, in ms. Absent while state is 'in-progress'. */
  duration_ms?: number;
  reason?: string;
  /**
   * STRANDED-ANALYSIS (defect class #41 continuation): last time this
   * record's owning process affirmatively proved it was still alive and
   * working, refreshed periodically (see ATTEMPT_HEARTBEAT_INTERVAL_MS)
   * while state is 'in-progress' — NOT just at phase boundaries, since a
   * single phase (e.g. L5 AI enrichment) can legitimately run for a while
   * with no phase transition to piggyback a write on. A server-process
   * restart (SIGTERM/SIGKILL, e.g. a routine deploy) kills the timer that
   * refreshes this field along with everything else in the process, so an
   * unrefreshed heartbeat is what distinguishes "still genuinely running"
   * from "the process that owned this died" — see reapAbandonedAttempt.
   * Absent on records written before this field existed; reapAbandonedAttempt
   * falls back to started_at for those, which is still correct (just a wider
   * detection window on old data).
   */
  heartbeat_at?: string;
  /**
   * Present only for a version-bump full rebuild. This sidecar file
   * (projectAttemptRecordPath) is the SAME on-disk path analyzer.ts's
   * internal version-rebuild tracking writes to (internalRebuildAttemptPath —
   * see its doc comment for why they're deliberately unified), so these
   * fields let analyzer.ts's loop-breaker (guardAgainstDoomedVersionRebuild)
   * recognize a later request as a repeat of THIS exact doomed rebuild. Any
   * writer here that overwrites a 'failed'+versioned record MUST preserve
   * these two fields (see the reanalyze catch block below) — clobbering them
   * with a version-less record would blind the loop-breaker.
   */
  stored_version?: string;
  current_version?: string;
}

// --- STRANDED-ANALYSIS reap (defect class #41 continuation) -----------------
// An async analysis (first-analyze OR reanalyze) interrupted by a server
// restart never gets to run its own catch block, so markBackgroundAnalysisFailed
// never fires and the attempt record is left at 'in-progress' forever — GET
// .../status then reports 'populating' forever with no error, indistinguishable
// from a genuinely running analysis. Fix: a periodic heartbeat while the
// background work is alive, so an attempt record whose heartbeat has gone
// stale is provably abandoned (the process that would refresh it is gone),
// and can be safely reaped to 'failed' — UNLESS the CAS actually landed in the
// meantime, in which case the record is corrected to 'succeeded' instead of
// destroying a genuinely complete analysis.
//
// Interval/threshold choice: the layered pipeline itself now runs INSIDE the
// heap-capped analysis WORKER, not this API process (see runLayeredAnalysis's
// call sites below) — so the API process's event loop is free to fire an
// interval timer on schedule even while a whale-scale analysis (measured
// 159-181s end to end) is running. That makes a SHORT, tight threshold safe:
// it does not need to guess at how long an analysis might legitimately take
// (which would force a multi-minute threshold and delay real-failure
// visibility by that much) — it only needs to guess at how long the API
// process's own timer might plausibly be delayed by event-loop jitter or a
// GC pause, which is a small-seconds question, not a minutes question.
// 20s interval / 90s threshold (4.5x the interval) leaves generous margin for
// that jitter while still surfacing a genuinely abandoned attempt within
// ~1.5 minutes of the process dying, regardless of how long the analysis
// itself would have taken to finish.
const ATTEMPT_HEARTBEAT_INTERVAL_MS = 20_000;
const ATTEMPT_STALE_THRESHOLD_MS = 90_000;

/**
 * Starts a periodic heartbeat that refreshes `heartbeat_at` on the attempt
 * record at `filePath` while background work is in flight. Returns a stop
 * function; callers MUST call it in a `finally` once the attempt reaches a
 * terminal state, so a heartbeat never outlives the work it describes.
 * `snapshot` supplies the static fields (state/trigger/queued_at/etc.) as of
 * attempt start — heartbeat writes only refresh heartbeat_at on top of it,
 * never regress a terminal state a concurrent writer already landed.
 */
function startAttemptHeartbeat(filePath: string, snapshot: ReanalyzeAttemptRecord): () => void {
  const timer = setInterval(() => {
    void writeAttemptRecord(filePath, { ...snapshot, heartbeat_at: new Date().toISOString() });
  }, ATTEMPT_HEARTBEAT_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

/**
 * Reaps a single attempt record at `attemptRecordPath` if it is 'in-progress'
 * and its heartbeat has gone stale (see ATTEMPT_STALE_THRESHOLD_MS) — a
 * process that was still alive and working would have refreshed it well
 * within that window. Never touches a record that is not 'in-progress', and
 * never touches one whose heartbeat is still fresh (it may genuinely be
 * running). Before declaring failure, checks whether `workspace`'s CAS
 * actually landed and completed in the meantime (a landed-but-unrecorded
 * race: the process could have died in the gap between the CAS write and the
 * attempt record's own 'succeeded' write) — if so, corrects the record to
 * 'succeeded' instead of destroying a genuinely complete analysis. Best
 * effort: never throws.
 */
async function reapAbandonedAttempt(workspace: string, attemptRecordPath: string): Promise<void> {
  try {
    const record = await readAttemptRecord(attemptRecordPath);
    if (!record || record.state !== 'in-progress') return;
    const heartbeatIso = record.heartbeat_at || record.started_at;
    const heartbeatMs = Date.parse(heartbeatIso);
    const ageMs = Number.isFinite(heartbeatMs) ? Date.now() - heartbeatMs : Infinity;
    if (ageMs < ATTEMPT_STALE_THRESHOLD_MS) return; // could still be genuinely running

    const entry = await getAnalysisEntry(workspace).catch(() => null);
    const landed = Boolean(entry && (entry.layers_ready?.complete ?? true));
    const finishedAt = new Date().toISOString();
    if (landed) {
      // The CAS landed; only the attempt record's own terminal write never
      // happened (process died in that narrow gap). Correct the record —
      // never mark a completed analysis as failed.
      await writeAttemptRecord(attemptRecordPath, {
        ...record,
        state: 'succeeded',
        finished_at: finishedAt,
        reason: undefined,
      });
      return;
    }
    const detail = `Analysis attempt was interrupted by a server restart (no heartbeat since ${heartbeatIso}).`;
    // Flips any still-'pending' CAS layers to 'error' too, so a partially-landed
    // analysis (e.g. L0 landed, L1-4 did not) is consistent across both signals
    // the status route reads. A no-op when no CAS exists yet at all (matches
    // this function's own existing best-effort contract).
    await markBackgroundAnalysisFailed(workspace, detail);
    await writeAttemptRecord(attemptRecordPath, {
      ...record,
      state: 'failed',
      finished_at: finishedAt,
      duration_ms: Date.parse(finishedAt) - Date.parse(record.started_at),
      reason: detail.slice(0, 300),
    });
  } catch {
    /* best-effort: reaping a stale attempt must never throw or block a caller */
  }
}

/**
 * Startup sweep (STRANDED-ANALYSIS fix, option 2): scans every project
 * workspace directory for a `.reanalyze-attempt.json` sidecar and reaps it if
 * abandoned. Runs once, fire-and-forget, right after the data dir is known —
 * a fresh process has not itself started any work yet, so ANY 'in-progress'
 * record this finds necessarily belongs to a previous incarnation; the
 * heartbeat-staleness check inside reapAbandonedAttempt is what protects
 * against a false-positive on a record whose owning process is mid-restart
 * (e.g. a rolling deploy where the old process is still finishing up).
 * Best effort: a scan failure (e.g. workspaces dir not yet created on a
 * brand-new data dir) must never block startup.
 */
async function reapStaleAttemptRecordsOnStartup(dataDir: string): Promise<void> {
  try {
    const workspacesDir = path.join(dataDir, 'workspaces');
    if (!(await fs.pathExists(workspacesDir))) return;
    const entries = await fs.readdir(workspacesDir, { withFileTypes: true }).catch(() => []);
    let reaped = 0;
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue;
      const workspace = path.join(workspacesDir, dirent.name);
      const attemptRecordPath = projectAttemptRecordPath(workspace);
      if (!(await fs.pathExists(attemptRecordPath))) continue;
      const before = await readAttemptRecord(attemptRecordPath);
      await reapAbandonedAttempt(workspace, attemptRecordPath);
      const after = await readAttemptRecord(attemptRecordPath);
      if (before?.state === 'in-progress' && after?.state !== 'in-progress') reaped += 1;
    }
    if (reaped > 0) {
      console.error(`[Klauro] startup reap: ${reaped} abandoned analysis attempt(s) resolved (see .reanalyze-attempt.json per workspace)`);
    }
  } catch (error) {
    console.error(`[Klauro] startup attempt-record reap failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Lightweight, ADDITIVE-ONLY observability counter — not a concurrency gate.
// Nothing here serializes, throttles, or otherwise changes when/how a
// reanalyze actually executes; it only counts how many reanalyze attempts on
// this process are currently between "accepted" and "finished" so
// `queue_position` can answer "how many were already in flight when this one
// queued." MOTIVATION: a 705-file repo sat 'in-progress' for 90+ minutes
// behind a concurrent whale rebuild with zero attributable signal — see
// ReanalyzeAttemptRecord.queue_position and CASAnalysisTimings (orchestrator).
let inFlightReanalyzeCount = 0;

async function writeAttemptRecord(filePath: string, record: ReanalyzeAttemptRecord): Promise<void> {
  try {
    await writeJsonAtomic(filePath, record);
  } catch {
    /* best-effort: last-attempt visibility must never mask or block reanalyze */
  }
}

async function readAttemptRecord(filePath: string): Promise<ReanalyzeAttemptRecord | null> {
  try {
    if (!(await fs.pathExists(filePath))) return null;
    return await fs.readJson(filePath);
  } catch {
    return null;
  }
}

// Project reanalyze: one attempt record per analysis workspace (the same
// directory the CAS itself lives in), so it travels with the analysis it
// describes and needs no extra dataDir plumbing.
function projectAttemptRecordPath(workspace: string): string {
  return path.join(workspace, '.reanalyze-attempt.json');
}

// Workspace (multi-repo, workspace-level CAS) reanalyze: no per-workspace CAS directory of our
// own to piggyback on (see account-workspace-analysis.ts, out of scope here),
// so the sidecar lives under its own directory keyed by workspace id.
function workspaceAttemptRecordPath(dataDir: string, workspaceId: string): string {
  return path.join(dataDir, 'workspace-attempts', `${safeName(workspaceId)}.json`);
}

// Shared background-rebuild trigger for POST /api/workspaces/{id}/reanalyze
// AND the project-attach endpoint (both in handleAccountApi below): recomputes
// the server-side workspace-level CAS for `workspaceId` from the stored member analyses (with
// AI narrative enrichment) and persists it, answering the same
// async-then-poll shape as POST /api/projects/{id}/reanalyze (see GET
// /api/workspaces/{id}/analysis for status polling). Callers must already
// have verified workspace membership (listProjects throws 404 for
// non-members) before calling this. A standalone function (not a closure over
// createRemoteAnalyzerHttpServer's locals) because handleAccountApi — where
// both call sites live — is its own top-level function, not nested inside
// createRemoteAnalyzerHttpServer; dataDir/workspaceAnalyses are threaded
// through as the same params handleAccountApi already receives.
function scheduleWorkspaceReanalyze(
  workspaceAnalyses: AccountWorkspaceAnalysisScheduler | undefined,
  dataDir: string | undefined,
  workspaceId: string,
): void {
  if (!workspaceAnalyses) throw new AccountHttpError(500, 'Workspace analysis storage unavailable');
  if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
  const dataDirForBackground = dataDir;
  const workspaceAttemptPath = workspaceAttemptRecordPath(dataDirForBackground, workspaceId);
  // Queue visibility (instrumentation only — nothing here gates or
  // serializes execution, behavior is unchanged): queued_at/queue_position
  // are captured NOW, at accept time, before the actual work has a chance to
  // run; started_at is captured separately below, inside the setImmediate
  // callback, once execution genuinely begins.
  const workspaceQueuedAt = new Date().toISOString();
  const workspaceQueuePosition = inFlightReanalyzeCount;
  inFlightReanalyzeCount += 1;
  setImmediate(async () => {
    const workspaceAttemptStartedAt = new Date().toISOString();
    await writeAttemptRecord(workspaceAttemptPath, {
      state: 'in-progress',
      trigger: 'reanalyze',
      queued_at: workspaceQueuedAt,
      queue_position: workspaceQueuePosition,
      started_at: workspaceAttemptStartedAt,
    });
    await workspaceAnalyses.rebuild(workspaceId, { force: true }).then(
      async () => {
        const workspaceAttemptFinishedAt = new Date().toISOString();
        await writeAttemptRecord(workspaceAttemptPath, {
          state: 'succeeded',
          trigger: 'reanalyze',
          queued_at: workspaceQueuedAt,
          queue_position: workspaceQueuePosition,
          started_at: workspaceAttemptStartedAt,
          finished_at: workspaceAttemptFinishedAt,
          duration_ms: Date.parse(workspaceAttemptFinishedAt) - Date.parse(workspaceAttemptStartedAt),
        });
        inFlightReanalyzeCount = Math.max(0, inFlightReanalyzeCount - 1);
      },
      async error => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[Klauro] async workspace reanalyze failed for ${workspaceId}: ${detail}`);
        const workspaceAttemptFinishedAt = new Date().toISOString();
        await writeAttemptRecord(workspaceAttemptPath, {
          state: 'failed',
          trigger: 'reanalyze',
          queued_at: workspaceQueuedAt,
          queue_position: workspaceQueuePosition,
          started_at: workspaceAttemptStartedAt,
          finished_at: workspaceAttemptFinishedAt,
          duration_ms: Date.parse(workspaceAttemptFinishedAt) - Date.parse(workspaceAttemptStartedAt),
          reason: detail.slice(0, 300),
        });
        inFlightReanalyzeCount = Math.max(0, inFlightReanalyzeCount - 1);
        if (dataDirForBackground) {
          await appendAuditLog(dataDirForBackground, {
            event: 'workspace_reanalyze_async_failed',
            workspace_id: workspaceId,
            error: detail.slice(0, 500),
          }).catch(() => {});
        }
      },
    );
  });
}

/**
 * Every client-supplied analysis id must route through here before use as a
 * storage key: a bare path hash is unsalted and identical across accounts
 * checked out at the same path, so two accounts would silently share (and
 * overwrite) one CAS. Rules: `prj_...` ids pass through unchanged (already
 * globally unique + auth-checked); already-salted `acct_...` ids pass through
 * unchanged (idempotency for re-push/sync — do not double-salt); anything
 * else gets folded with `accountSalt` into a per-account `acct_` key.
 * `accountSalt` undefined (anonymous/shared-token) preserves the raw hash.
 */
function resolveStorageAnalysisId(rawId: string, accountSalt: string | undefined): string {
  if (/^prj_/.test(rawId) || /^acct_/.test(rawId)) return rawId;
  return accountSalt ? `acct_${makeAnalysisId(accountSalt + '::' + rawId)}` : rawId;
}

const DEFAULT_MAX_ANALYSES_PER_ACCOUNT = 50;

/** Configurable via `KLAURO_MAX_ANALYSES_PER_ACCOUNT`; falls back to a
 * generous default that comfortably covers a real developer's local
 * checkouts (a few dozen repos) without allowing unbounded growth. */
function maxAnalysesPerAccount(): number {
  const raw = Number(process.env.KLAURO_MAX_ANALYSES_PER_ACCOUNT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_ANALYSES_PER_ACCOUNT;
}

function accountAnalysisQuotaPath(dataDir: string, userId: string): string {
  // Sanitize userId defensively before it touches a path -- account ids are
  // server-generated (`usr_<random>`), but this must never trust that blindly.
  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dataDir, 'account-quota', `${safeUserId}.json`);
}

/**
 * STORAGE ADMISSION BOUND (task #120 item 5).
 *
 * Even with `authorizeProjectWrite` closing the `prj_` cross-tenant write
 * gap above, an authenticated account could still push an UNLIMITED number
 * of DISTINCT bare-hash (unbound, non-`prj_`) analysis ids via `/v1/analyze`
 * -- each one durably creates its own `acct_<hash>` workspace directory on
 * disk forever, with no cap anywhere in this file. This is exactly the shape
 * measured in the read-only VPS inspection that opened this task: 180 pure
 * path-hash slug directories (272MB) matching no registered project.
 *
 * `prj_` ids are not tracked here -- their growth is already bounded by
 * explicit account project creation (`AccountStore.createProject`, itself
 * membership-gated), now also write-gated by `authorizeProjectWrite` above.
 * Anonymous/shared-token callers are not tracked either: there is no account
 * to charge the quota against, and production requires
 * `KLAURO_ANALYZER_TOKEN` for any of this code to be reached anonymously.
 *
 * Tracked in a small per-account sidecar file rather than extending
 * `accounts.json`'s schema -- this is a rate/quota concern, not identity
 * data, and keeping it separate avoids touching `AccountStore`'s own
 * persistence/migration surface for something this narrow.
 */
async function admitAccountAnalysisWorkspace(
  dataDir: string,
  clientId: string | undefined,
  rawId: string,
  storageId: string,
): Promise<{ admitted: boolean; count: number; limit: number }> {
  const limit = maxAnalysesPerAccount();
  if (!clientId?.startsWith('user:') || !storageId.startsWith('acct_')) {
    return { admitted: true, count: 0, limit };
  }
  const userId = clientId.slice('user:'.length);
  const quotaPath = accountAnalysisQuotaPath(dataDir, userId);
  await fs.ensureDir(path.dirname(quotaPath));
  let known: string[] = [];
  try {
    const loaded = await fs.readJson(quotaPath);
    if (Array.isArray(loaded)) known = loaded;
  } catch {
    known = [];
  }
  if (known.includes(storageId)) return { admitted: true, count: known.length, limit };
  if (known.length >= limit) return { admitted: false, count: known.length, limit };
  known.push(storageId);
  await fs.writeJson(quotaPath, known);
  return { admitted: true, count: known.length, limit };
}

/**
 * Must compute the display name before the hash-workspace swap, and prefer
 * project_path's basename over the snapshot's project_name — the latter can
 * resolve to a staging directory for a staged/temporary source tree.
 */
/**
 * Marks every still-pending analysis layer 'error' so the status endpoint
 * stops reporting 'populating' forever after a crashed background analysis.
 * Must never throw — runs inside a catch and must not mask the original failure.
 */
async function markBackgroundAnalysisFailed(workspacePath: string, detail: string): Promise<void> {
  try {
    const cas = await loadAnalysis(workspacePath, { preferCache: false }).catch(() => null);
    if (!cas?.layers_ready?.layers?.length) return;
    const failedAt = new Date().toISOString();
    let changed = false;
    for (const layer of cas.layers_ready.layers) {
      if (layer.status !== 'pending') continue;
      layer.status = 'error';
      layer.error = detail.slice(0, 500);
      layer.completed_at = failedAt;
      changed = true;
    }
    if (!changed) return;
    cas.layers_ready.complete = false;
    await saveAnalysis(workspacePath, cas);
    clearFreshnessSummaryCache();
  } catch {
    /* best-effort: a failure to record the failure must never mask it */
  }
}

function resolveDisplayName(projectName?: string, projectPath?: string): string | undefined {
  // Pass through the best explicit project name available. The analyzer's
  // resolveSystemDisplayName is CONTENT-FIRST — it derives the name from the
  // README/PRD title, the root manifest, or a common package scope and OUTRANKS
  // whatever we return here — so a weak checkout-folder basename we pass
  // ("proof-of-concept") is safely overridden when the repo self-names
  // (Klauro -> "Klauro" via its @klauro/* scope), while a real chosen project
  // name survives as the fallback above the bare workspace basename. The
  // reanalyze call site threads the project record's name through the
  // projectPath arg (e.g. "Acme Scientific" for a C#/non-npm repo that has no
  // root self-naming file) — basename() returns it unchanged, so it reaches the
  // analyzer and wins when there is no stronger content signal. (An earlier
  // version returned undefined for basename-shaped names; that DROPPED
  // "Acme Scientific" on the reanalyze path — where it arrives via projectPath,
  // not projectName — leaving the system named after the raw workspace id.)
  const name = (projectName || '').trim();
  if (name) return name;
  const pp = (projectPath || '').trim();
  return pp ? path.basename(pp.replace(/[/\\]+$/, '')) : undefined;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120);
}

/**
 * Manifest for a reanalyze run against an already-uploaded snapshot workspace
 * (no new file transfer happened, so file_count/total_bytes are computed from
 * what is currently on disk in the workspace rather than a fresh upload).
 */
async function buildWorkspaceManifest(workspace: string): Promise<SourceManifest> {
  let fileCount = 0;
  let totalBytes = 0;
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        fileCount += 1;
        totalBytes += (await fs.stat(full)).size;
      }
    }
  }
  await walk(workspace);
  return {
    generated_at: new Date().toISOString(),
    root: workspace,
    file_count: fileCount,
    total_bytes: totalBytes,
    excluded_directories: [],
  };
}

function buildChangeManifest(workspace: string, changes: RemoteFileChange[]): SourceManifest {
  return {
    generated_at: new Date().toISOString(),
    root: workspace,
    file_count: changes.length,
    total_bytes: changes.reduce((sum, change) => sum + (change.status === 'deleted' ? 0 : Buffer.byteLength(change.content, 'utf8')), 0),
    excluded_directories: [],
  };
}

if (isDirectCliInvocation('remote-analyzer-service')) {
  const port = Number(process.env.PORT || process.env.KLAURO_ANALYZER_PORT || DEFAULT_PORT);
  const server = createRemoteAnalyzerHttpServer();
  server.listen(port, () => {
    process.stdout.write(`Klauro remote analyzer listening on http://0.0.0.0:${port}\n`);
  });
}
