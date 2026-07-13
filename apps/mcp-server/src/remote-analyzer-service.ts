import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { analyzeProjectIncremental, analyzeProjectDeferred, analyzeProjectLayered } from './analyzer';
import type { RemoteAnalyzeDiffRequest, RemoteAnalyzeRequest, RemoteAnalyzeResponse, RemoteGreenfieldPreviewRequest, RemoteProjectRevision, RemoteProjectRevisionsResponse, RemoteProposalPreviewRequest, RemoteSyncRequest } from './remote-analyzer-protocol';
import type { BranchDiffContext, RemoteFileChange, SourceManifest } from './remote-source';
import { buildSourceSnapshot } from './remote-source';
import { previewCodebaseIteration, previewGreenfieldCodebase } from './proposal-preview';
import { isDirectCliInvocation } from './cli-invocation';
import { AccountHttpError, AccountStore } from './account-store';
import { AccountWorkspaceAnalysisScheduler } from './account-workspace-analysis';
import { getGrants, heartbeatGrant, releaseGrant, requestGrant, type AgentKind } from './coordination';
import { appendClaim, checkEditLock, getActiveClaims, getPresence, getStoreDir, readClaimLog, releaseAgent } from './coordination/local-store';
import { deriveActiveClaims } from './coordination/presence';
import { appendSecurityAudit, assertSameTenant, defaultSecretDenyPatterns, getSecurityStoreDir, redactInFlightChanges, TenantMismatchError } from './coordination/security';
import { detectConceptualConflicts, type AgentInFlightState, type ConflictCas, type SymbolChange } from './coordination/conceptual-conflict';
import { partitionTasks, type PartitionCas, type PartitionTask } from './coordination/partitioner';
import { ingestAndPersist, loadPersistedRuntimeFacts } from './telemetry-fusion';
import { backfillIngestedTelemetry, ingestTelemetryBatch, loadTelemetryObservations, summarizeRouteMetrics } from './telemetry-ingestion';
import { buildNodeRuntimeMetrics } from './product';
import { getAnalysis } from './analyzer';
import { buildSummary, getProductMap, getFlowConcepts, getArchitecturalConflicts, getParadigmConformance, getPerspectives, getCicdPipelines, getCommunicationSeams, buildOrientCapsule } from './query';
import { initSelfTelemetry, instrumentHttpHandler, mapSdkEvent } from './self-telemetry';
import type { CasRuntimeEvent } from '../../../packages/klauro-sdk-js/src/types';

const DEFAULT_PORT = 8787;
const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024;
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

export function createRemoteAnalyzerHttpServer(options: RemoteAnalyzerServiceOptions = {}): http.Server {
  const dataDir = path.resolve(options.dataDir || process.env.KLAURO_REMOTE_ANALYZER_DATA || path.join(process.cwd(), '.klauro-remote-analyzer'));
  const token = options.token ?? process.env.KLAURO_ANALYZER_TOKEN;
  const maxBodyBytes = options.maxBodyBytes || resolveMaxBodyBytes();
  const rateLimitPerMinute = options.rateLimitPerMinute ?? Number(process.env.KLAURO_ANALYZER_RATE_LIMIT_PER_MINUTE || 120);
  const deferAiEnrichment = options.deferAiEnrichment === true;
  const buckets = new Map<string, RateLimitBucket>();
  const accounts = new AccountStore(dataDir);
  // Server-side auto-refreshed Workspace Analysis (WAS): rebuilds are
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
        writeJson(response, 200, { status: 'ok', service: 'klauro-remote-analyzer' });
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

      if (request.method === 'POST' && route === '/api/auth/login') {
        const body = await readJsonBody<{ email: string; password: string }>(request, maxBodyBytes);
        const result = await accounts.login(body);
        writeJson(response, 200, result);
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
        // Raw observations MUST persist regardless of analysis state. A missing
        // analysis is NOT a drop reason: fall back to `null` cas so the raw
        // events (route/status/duration/error/timestamp) are stored as
        // `unmatched`, and ack 200 so the SDK does not requeue forever.
        // Correlation happens lazily once an analysis exists.
        let cas: any = null;
        try {
          cas = await getAnalysis(projectId);
        } catch {
          cas = null;
        }
        const result = await ingestTelemetryBatch(cas, projectId, events.map(mapSdkEvent), { persist: true });
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
          writeJson(response, 401, { status: 'error', error: 'Sign in required' });
          return;
        }
        const accountResult = await handleAccountApi(accounts, apiAuthorization.userId, route, request, maxBodyBytes, apiAuthorization.sharedToken, dataDir, workspaceAnalyses);
        writeJson(response, accountResult.statusCode, accountResult.body);
        return;
      }

      const authorization = await authorizeAnalyzerRequest(accounts, request, token);
      if (!authorization.authorized) {
        writeJson(response, 401, { status: 'error', error: 'Unauthorized remote analyzer request' });
        return;
      }

      const clientId = authorization.clientId || request.socket.remoteAddress || 'unknown';
      if (!withinRateLimit(buckets, clientId, rateLimitPerMinute)) {
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

        if (body.async === true) {
          // Progressive disclosure: persist the snapshot NOW, answer in
          // seconds, and run the entire analysis server-side in the
          // background. The background continuation performs the exact same
          // post-analyze steps as the synchronous path below (revision append,
          // account-project attach, audit log, WAS rebuild trigger); its
          // failures are logged + audited, never a hung/failed upload.
          if (!body.snapshot?.files?.length) {
            writeJson(response, 400, { status: 'error', error: 'Remote analyze requires a source snapshot with files' });
            return;
          }
          const rawAcceptedId = body.project_id || makeAnalysisId(body.project_path || body.snapshot.project_name);
          const acceptedAnalysisId = resolveStorageAnalysisId(rawAcceptedId, accountSaltFor(authorization.clientId));
          const acceptedWorkspace = workspacePath(dataDir, acceptedAnalysisId);
          await fs.remove(acceptedWorkspace);
          await fs.ensureDir(acceptedWorkspace);
          await writeSnapshot(acceptedWorkspace, body.snapshot.files);
          writeJson(response, 202, {
            status: 'accepted',
            analysis_id: acceptedAnalysisId,
            base_commit: body.snapshot.base_commit,
            manifest: body.snapshot.manifest,
          });
          const backgroundClientId = authorization.clientId;
          setImmediate(async () => {
            let attachedEarly = false;
            try {
              const displayName = resolveDisplayName(body.snapshot.project_name, body.project_path);
              const layered = await analyzeProjectLayered(acceptedWorkspace, displayName);

              // Progressive availability (task #112): attach the project +
              // notify WAS the moment L0 (the fast index/inventory pre-pass)
              // is persisted, not after the full deterministic pipeline
              // finishes. This is what makes the web app show the project
              // populating within seconds instead of after the full ~1-2.5min
              // pass — the account-project record only needs an analysis_id
              // to resolve to SOME stored CAS at acceptedWorkspace, and
              // whichever layer is currently on disk there is what queries see
              // (honestly, via that CAS's own layers_ready manifest).
              await layered.l0;
              try {
                await linkAnalysisToAccountProject(accounts, backgroundClientId, body.project_id, acceptedAnalysisId, body.snapshot?.manifest?.git_remote);
                attachedEarly = true;
                void notifyProjectAnalysisLandedForAnalysisId(acceptedAnalysisId);
              } catch (attachError) {
                const detail = attachError instanceof Error ? attachError.message : String(attachError);
                console.error(`[Klauro] early L0 project attach failed for ${acceptedAnalysisId}: ${detail}`);
              }

              const deferred = await layered.rest;
              const backgroundResult: RemoteAnalyzeResponse = {
                status: 'success',
                analysis_id: acceptedAnalysisId,
                analysis_revision: Date.now(),
                analysis_type: 'full',
                base_commit: body.snapshot.base_commit,
                manifest: body.snapshot.manifest,
                cas: deferred.output,
              };
              await appendProjectRevision(dataDir, backgroundResult, 'local_commit_submission');
              // Attach again (idempotent) in case the early L0 attach above
              // failed or was skipped — never leave the landed full analysis
              // unattached because of a transient early-attach error.
              if (!attachedEarly) {
                await linkAnalysisToAccountProject(accounts, backgroundClientId, body.project_id, acceptedAnalysisId, body.snapshot?.manifest?.git_remote);
              }
              await appendAuditLog(dataDir, {
                event: 'analyze',
                analysis_id: acceptedAnalysisId,
                project_id: body.project_id,
                organization_id: body.organization_id,
                files: body.snapshot.manifest?.file_count,
                bytes: body.snapshot.manifest?.total_bytes,
                nodes: deferred.output.nodes.length,
                edges: deferred.output.edges.length,
                mode: 'async',
              });
              void notifyProjectAnalysisLandedForAnalysisId(acceptedAnalysisId);
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              console.error(`[Klauro] async analyze failed for ${acceptedAnalysisId}: ${detail}`);
              await appendAuditLog(dataDir, {
                event: 'analyze_async_failed',
                analysis_id: acceptedAnalysisId,
                project_id: body.project_id,
                error: detail.slice(0, 500),
              }).catch(() => {});
            }
          });
          return;
        }

        const result = await handleAnalyze(dataDir, body, deferAiEnrichment, accountSaltFor(authorization.clientId));
        await appendProjectRevision(dataDir, result, 'local_commit_submission');
        // Attach the landed analysis to the matching account project record.
        // Without this, a project created in the web app (no analysis_id at
        // creation) NEVER shows an analysis on /api/projects/:id/analysis even
        // though every CLI `klauro analyze` push succeeded — the analysis sat
        // orphaned under workspacePath(analysis_id). The CLI sends project_id
        // = .klaurorc project.id (prj_...), which IS the account project id.
        await linkAnalysisToAccountProject(accounts, authorization.clientId, body.project_id, result.analysis_id, body.snapshot?.manifest?.git_remote);
        await appendAuditLog(dataDir, {
          event: 'analyze',
          analysis_id: result.analysis_id,
          project_id: body.project_id,
          organization_id: body.organization_id,
          files: result.manifest.file_count,
          bytes: result.manifest.total_bytes,
          nodes: result.cas.nodes.length,
          edges: result.cas.edges.length,
        });
        writeJson(response, 200, result);
        // Async, never blocks/affects the response above: if this analysis_id
        // is linked to an account project (klauro init reconnect flow), mark
        // that project's workspace(s) dirty for a debounced WAS rebuild.
        void notifyProjectAnalysisLandedForAnalysisId(result.analysis_id);
        return;
      }

      if (request.method === 'POST' && route === '/v1/analyze-diff') {
        const body = await readJsonBody<RemoteAnalyzeDiffRequest>(request, maxBodyBytes);
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
        writeJson(response, 200, result);
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
        writeJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && route === '/v1/sync') {
        const body = await readJsonBody<RemoteSyncRequest>(request, maxBodyBytes);
        const result = await handleSync(dataDir, body, accountSaltFor(authorization.clientId));
        await appendAuditLog(dataDir, {
          event: 'sync',
          analysis_id: result.analysis_id,
          project_id: body.project_id,
          organization_id: body.organization_id,
          files: result.manifest.file_count,
          bytes: result.manifest.total_bytes,
          changed_files: result.change_report
            ? result.change_report.summary.filesAdded + result.change_report.summary.filesModified + result.change_report.summary.filesDeleted
            : undefined,
          nodes: result.cas.nodes.length,
          edges: result.cas.edges.length,
        });
        writeJson(response, 200, result);
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
            status: 'active',
            created_at: now,
            ttl_ms: body.ttl_ms ?? REMOTE_ADVISORY_DEFAULT_TTL_MS,
            heartbeat_at: now,
            base_commit: body.base_commit,
            branch: body.branch,
          });
          broadcastCoordinationEvent(workspace, 'claim', {
            claim_id: entry.claim_id,
            agent_id: body.agent_id,
            verdict: 'granted',
            mode: 'advisory',
          });
          writeJson(response, 200, {
            claim_id: entry.claim_id,
            seq: entry.seq,
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
          const released = await releaseAgent(body.workspace, body.agent_id);
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
            released: released.map((r) => ({ claim_id: r.claim_id, intent: r.intent, paths: r.scope.paths })),
            server_time: new Date().toISOString(),
          });
          return;
        }
        await releaseGrant(body.workspace, body.agent_id, body.claim_id);
        broadcastCoordinationEvent(body.workspace, 'release', {
          claim_id: body.claim_id,
          agent_id: body.agent_id,
          status: 'released',
        });
        writeJson(response, 200, { status: 'released', claim_id: body.claim_id });
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
        writeJson(response, 200, {
          workspace,
          count: active.length,
          max_seq: log.reduce((max, entry) => Math.max(max, entry.seq), 0),
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
        const holderCtx = await describeGrantHolders(workspace, grants.active.map((g) => g.agent_id));
        const maxSeq = log.reduce((max, entry) => Math.max(max, entry.seq), 0);
        writeJson(response, 200, {
          workspace,
          max_seq: maxSeq,
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
        response.write(`event: state\ndata: ${JSON.stringify({ workspace, claims, presence })}\n\n`);

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
        const allConflicts = detectConceptualConflicts([requesterState, ...others], cas);
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

/**
 * The account-scoping salt for `makeAnalysisId`'s fallback (bare path/name
 * hash) path — see makeAnalysisId's doc comment for the bug this closes.
 * Only a real authenticated account (`clientId === 'user:<id>'` from
 * authorizeAnalyzerRequest) yields a salt; shared-token and anonymous
 * requests (and the ip-address clientId anonymous fallback) return
 * `undefined`, preserving the pre-fix unsalted hash for those callers (there
 * is no per-account keyspace to collapse into when there is no account).
 */
function accountSaltFor(clientId: string | undefined): string | undefined {
  return clientId && clientId.startsWith('user:') ? clientId : undefined;
}

async function authorizeAnalyzerRequest(accounts: AccountStore, request: http.IncomingMessage, sharedToken: string | undefined): Promise<{ authorized: boolean; clientId?: string }> {
  const token = bearerToken(request);
  if (sharedToken && token && token === sharedToken) return { authorized: true, clientId: 'shared-token' };
  // Always try to resolve a real account user from the Bearer token first —
  // this is what lets linkAnalysisToAccountProject identify the pushing user
  // (`user:<id>`) and safely attach the analysis to their project. Without
  // this check, a server run with no KLAURO_ANALYZER_TOKEN configured (the
  // common self-hosted/dev shape, and every /v1/* request in that mode)
  // never even attempted to authenticate the Bearer token AccountStore-side,
  // so every push looked anonymous and the analysis could never attach.
  if (token) {
    const user = await accounts.authenticate(token);
    if (user) return { authorized: true, clientId: `user:${user.id}` };
  }
  if (!sharedToken) return { authorized: true, clientId: request.socket.remoteAddress || 'anonymous' };
  return { authorized: false };
}

async function authorizeAccountApiRequest(accounts: AccountStore, request: http.IncomingMessage, sharedToken: string | undefined): Promise<{ authorized: boolean; userId: string; sharedToken?: boolean }> {
  const token = bearerToken(request);
  if (sharedToken && token && token === sharedToken) {
    return { authorized: true, userId: 'shared-token', sharedToken: true };
  }
  const user = await accounts.authenticate(token);
  return user ? { authorized: true, userId: user.id } : { authorized: false, userId: '' };
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
  } catch (error) {
    const detail = error instanceof AccountHttpError ? error.message : (error instanceof Error ? error.message : String(error));
    console.error(`[Klauro] skip analysis attach by remote "${gitRemote}" (user ${userId}): ${detail}`);
  }
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
): Promise<{ statusCode: number; body: unknown }> {
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
      const body = await readJsonBody<{ name: string; repo_url?: string; local_path?: string; analysis_id?: string }>(request, maxBodyBytes);
      return { statusCode: 201, body: { project: await accounts.createProject(userId, workspaceId, body) } };
    }
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
    if (!record) {
      return {
        statusCode: 200,
        body: { status: pending ? 'pending' : 'none', workspace_id: workspaceId },
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
        // was attached to server-side WAS rebuilds.
        enrichment: record.enrichment,
        analysis: record.graph,
      },
    };
  }

  // POST /api/workspaces/{id}/reanalyze — recompute the server-side WAS for
  // this workspace from the STORED member analyses, WITH the AI narrative
  // enrichment pass, and persist. Mirrors POST /api/projects/{id}/reanalyze:
  // answer 202 immediately and run in the background (a multi-repo WAS build
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
    if (!workspaceAnalyses) throw new AccountHttpError(500, 'Workspace analysis storage unavailable');
    const dataDirForBackground = dataDir;
    setImmediate(() => {
      workspaceAnalyses.rebuild(workspaceId).catch(async error => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[Klauro] async workspace reanalyze failed for ${workspaceId}: ${detail}`);
        if (dataDirForBackground) {
          await appendAuditLog(dataDirForBackground, {
            event: 'workspace_reanalyze_async_failed',
            workspace_id: workspaceId,
            error: detail.slice(0, 500),
          }).catch(() => {});
        }
      });
    });
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

  const projectAnalysisMatch = route.match(/^\/api\/projects\/([^/]+)\/analysis$/);
  if (projectAnalysisMatch && request.method === 'GET') {
    if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
    const project = await accounts.getProjectForUser(userId, decodeURIComponent(projectAnalysisMatch[1]));
    if (!project) throw new AccountHttpError(404, 'Project not found');
    if (!project.analysis_id) {
      return { statusCode: 200, body: { status: 'no_analysis', project_id: project.id } };
    }
    try {
      const cas = await getAnalysis(workspacePath(dataDir, project.analysis_id));
      const summary = buildSummary(cas, { detail: 'compact' });
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
      // indefinitely (prod: electripure/hercules/openclaw stuck "populating"
      // with description_source null). The structure IS complete and final, so
      // the project is 'ready', with an explicit degraded ai_enrichment
      // indicator + the underlying rejection reason so the failure is VISIBLE.
      const ladderLayers = cas.layers_ready?.layers || [];
      const hasPendingLayer = ladderLayers.some(layer => layer.status === 'pending');
      const erroredLayers = ladderLayers.filter(layer => layer.status === 'error');
      const status = cas.layers_ready && !cas.layers_ready.complete && hasPendingLayer
        ? 'populating'
        : 'ready';
      const aiDegraded = cas.ai_enrichment === 'error' || (erroredLayers.length > 0 && !hasPendingLayer);
      return {
        statusCode: 200,
        body: {
          status,
          ...(aiDegraded
            ? {
                ai_enrichment: 'error',
                ai_enrichment_error:
                  cas.ai_enrichment_error ||
                  erroredLayers.find(layer => layer.error)?.error ||
                  'AI comprehension pass failed; comprehension is AI-only (no deterministic fallback)',
              }
            : {}),
          project_id: project.id,
          analysis_id: project.analysis_id,
          summary,
          product_map: productMap,
        },
      };
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
      const cas = await getAnalysis(workspacePath(dataDir, project.analysis_id));
      const url = new URL(request.url || '', 'http://localhost');
      const target = url.searchParams.get('target') || undefined;
      const flowConcepts = getFlowConcepts(cas, { target, maxFlows: 20 });
      const architectural = getArchitecturalConflicts(cas, { limit: 25 });
      const paradigms = getParadigmConformance(cas);
      const perspectives = getPerspectives(cas);
      // Capability -> flow linkage, BOTH directions readable: each flow already
      // carries capability_id; the capability side carries related_flows (the
      // ids of returned flows that realize it) so the UI can render the
      // capability -> flow hierarchy without joining client-side.
      const flowIdsByCapability = new Map<string, string[]>();
      for (const flow of (flowConcepts.flows || []) as Array<{ flow_id: string; capability_id?: string }>) {
        if (!flow.capability_id) continue;
        const list = flowIdsByCapability.get(flow.capability_id) || [];
        list.push(flow.flow_id);
        flowIdsByCapability.set(flow.capability_id, list);
      }
      const capabilities = (cas.system_capabilities || []).map(capability => ({
        id: capability.id,
        name: capability.name,
        category: capability.category,
        criticality: capability.criticality,
        related_flows: flowIdsByCapability.get(capability.id) || [],
      }));
      return {
        statusCode: 200,
        body: {
          status: 'ready',
          project_id: project.id,
          analysis_id: project.analysis_id,
          capabilities,
          flows: flowConcepts,
          structural: {
            architectural,
            paradigms,
            perspectives,
          },
        },
      };
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
      // SECURITY: `project.local_path` is client-supplied, tenant-scoped
      // metadata (see AccountStore.createProject) — it is NEVER verified to
      // be a path this account is actually entitled to have this server
      // read. On a shared host (the deployed shape today: one analyzer
      // process, many tenants), reading it here is an arbitrary local-file
      // read/re-analyze primitive: any account whose project record ends up
      // with a `local_path` pointing at another tenant's (or the operator's)
      // real repo — via a client bug, an ambient-cwd mistake in `klauro
      // init`, or a malicious API call — causes THIS account's reanalyze to
      // walk and return that path's real source under its own session. This
      // is exactly the cross-tenant bleed reported in the 2026-07-06
      // cold-customer audit. Disabled by default; only for a genuinely
      // colocated dev/ops box where every project's local_path is trusted
      // operator-controlled state, opt in with
      // KLAURO_ALLOW_LOCAL_PATH_REANALYZE_FALLBACK=1.
      const fallbackAllowed = process.env.KLAURO_ALLOW_LOCAL_PATH_REANALYZE_FALLBACK === '1';
      if (fallbackAllowed && project.local_path && (await fs.pathExists(project.local_path))) {
        sourceRoot = project.local_path;
      } else {
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
    }
    const displayName = resolveDisplayName(undefined, project.name);
    const dataDirForBackground = dataDir;
    const workspaceIdForBackground = project.workspace_id;

    // ASYNC REANALYZE (task: large-repo reanalyze never persisted). A 27k-node
    // full rebuild (which an analyzer-build version bump forces — see
    // orchestrator.fullRebuildReasonForPreviousOutput) + inline AI comprehension
    // takes minutes, far exceeding the Cloudflare edge (~125s) and the client
    // POST timeout (~30s). The OLD code awaited analyzeProjectIncremental
    // SYNCHRONOUSLY inside this handler and only returned 200 on completion, so
    // the connection dropped (524/000) long before the fresh analysis landed and
    // large repos stayed frozen at their old timestamp forever.
    //
    // Fix: answer 202 immediately and run the full layered analysis in the
    // background (survives client disconnect). Uses analyzeProjectLayered — the
    // SAME entrypoint the async /v1/analyze path uses — so L0 lands in seconds,
    // then L1-L4, then L5 AI comprehension, each stamping layers_ready as it
    // completes and persisting via saveAnalysis. Clients poll
    // GET /api/projects/{id}/analysis (layers_ready.L5) for completion. The
    // version-bump full-rebuild invalidation (orchestrator ~2133) fires inside
    // analyzeProjectIncremental/Layered exactly as before, so a fresh deploy
    // forces a fresh FULL analysis rather than reusing stale derived artifacts.
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

    setImmediate(async () => {
      try {
        const layered = await analyzeProjectLayered(workspace, displayName);
        // Wait for the full deterministic pipeline (L1-L4) so the persisted CAS
        // is a real analysis, not just the L0 stub, before appending a revision.
        const deferred = await layered.rest;
        const backgroundResult: RemoteAnalyzeResponse = {
          status: 'success',
          analysis_id: analysisId,
          analysis_revision: Date.now(),
          analysis_type: 'full',
          base_commit: baseCommitForResponse,
          manifest: manifestForResponse,
          cas: deferred.output,
        };
        if (dataDirForBackground) {
          await appendProjectRevision(dataDirForBackground, backgroundResult, 'local_commit_submission');
        }
        // This route is already project-scoped, so the owning workspace is known
        // directly — no analysis_id lookup needed.
        workspaceAnalyses?.notifyProjectAnalysisLanded(workspaceIdForBackground);
        if (dataDirForBackground) {
          await appendAuditLog(dataDirForBackground, {
            event: 'reanalyze',
            analysis_id: analysisId,
            project_id: project.id,
            nodes: deferred.output.nodes.length,
            edges: deferred.output.edges.length,
            mode: 'async',
          }).catch(() => {});
        }
        // Let the L5 AI-comprehension pass finish + re-stamp layers_ready. Its
        // failure is a VISIBLE terminal state (L5 'error'), never a hang.
        await deferred.enrichment.catch(() => {});
        // Re-append the enriched revision + re-notify WAS so pollers and the
        // workspace rollup see the comprehension-complete CAS, not just L1-L4.
        if (dataDirForBackground) {
          await appendProjectRevision(dataDirForBackground, {
            ...backgroundResult,
            analysis_revision: Date.now(),
            cas: deferred.output,
          }, 'local_commit_submission').catch(() => {});
        }
        workspaceAnalyses?.notifyProjectAnalysisLanded(workspaceIdForBackground);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[Klauro] async reanalyze failed for ${analysisId}: ${detail}`);
        if (dataDirForBackground) {
          await appendAuditLog(dataDirForBackground, {
            event: 'reanalyze_async_failed',
            analysis_id: analysisId,
            project_id: project.id,
            error: detail.slice(0, 500),
          }).catch(() => {});
        }
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

async function handleAnalyze(dataDir: string, request: RemoteAnalyzeRequest, deferAiEnrichment = false, accountSalt?: string): Promise<RemoteAnalyzeResponse> {
  if (!request.snapshot?.files?.length) throw new Error('Remote analyze requires a source snapshot with files');
  const rawAnalysisId = request.project_id || makeAnalysisId(request.project_path || request.snapshot.project_name);
  const analysisId = resolveStorageAnalysisId(rawAnalysisId, accountSalt);
  const workspace = workspacePath(dataDir, analysisId);
  const displayName = resolveDisplayName(request.snapshot.project_name, request.project_path);

  await fs.remove(workspace);
  await fs.ensureDir(workspace);
  await writeSnapshot(workspace, request.snapshot.files);

  if (deferAiEnrichment) {
    // Progressive path: return the deterministic CAS now; the AI enrichment
    // runs in the background and upgrades the stored analysis for later fetches.
    const deferred = await analyzeProjectDeferred(workspace, displayName);
    return {
      status: 'success',
      analysis_id: analysisId,
      analysis_revision: Date.now(),
      analysis_type: 'full',
      base_commit: request.snapshot.base_commit,
      manifest: request.snapshot.manifest,
      cas: deferred.output,
    };
  }

  let result: Awaited<ReturnType<typeof analyzeProjectIncremental>>;
  try {
    result = await analyzeProjectIncremental(workspace, displayName);
  } catch (error) {
    // Comprehension is AI-only and THROWS when a hosted AI provider is not
    // available (docs/cas/DETERMINISM-BOUNDARY.md). The remote analyze edge is
    // structure-first: rather than fail the whole request (and rather than emit a
    // deterministic comprehension substitute — which does not exist), ship the
    // deterministic Camp-B CAS now with comprehension left pending/unset. In the
    // hosted product a provider is always configured, so this path is not taken.
    const message = error instanceof Error ? error.message : String(error);
    if (!/comprehension/i.test(message)) throw error;
    console.error(`[Klauro] remote analyze: comprehension unavailable, returning structure-only CAS (${message})`);
    const deferred = await analyzeProjectDeferred(workspace, displayName);
    return {
      status: 'success',
      analysis_id: analysisId,
      analysis_revision: Date.now(),
      analysis_type: 'full',
      base_commit: request.snapshot.base_commit,
      manifest: request.snapshot.manifest,
      cas: deferred.output,
    };
  }
  return {
    status: 'success',
    analysis_id: analysisId,
    analysis_revision: Date.now(),
    analysis_type: result.wasFullRebuild ? 'full' : 'incremental',
    base_commit: request.snapshot.base_commit,
    manifest: request.snapshot.manifest,
    cas: result.output,
    change_report: result.changeReport,
  };
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
    const result = await analyzeProjectIncremental(workspace, displayName);
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

async function handleSync(dataDir: string, request: RemoteSyncRequest, accountSalt?: string): Promise<RemoteAnalyzeResponse> {
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
  const result = await analyzeProjectIncremental(workspace, displayName);
  return {
    status: 'success',
    analysis_id: analysisId,
    analysis_revision: Date.now(),
    analysis_type: result.wasFullRebuild ? 'full' : 'incremental',
    base_commit: request.changes.base_commit,
    manifest: request.changes.manifest || buildChangeManifest(workspace, request.changes.changed_files || []),
    cas: result.output,
    change_report: result.changeReport,
  };
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
  const allowed = requested === 'klauro-latest.tgz' || /^klauro-[\w.\-]+\.tgz$/.test(requested);
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

  response.writeHead(200, corsHeaders({
    'content-type': 'application/gzip',
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
  const body = {
    version: (manifest.version as string) || null,
    tarball: `${base}/dist/klauro-latest.tgz`,
    tarball_path: '/dist/klauro-latest.tgz',
    min_node: (manifest.min_node as number) || 18,
    published_at: (manifest.published_at as string) || null,
    update_command: 'klauro update',
  };
  response.writeHead(200, corsHeaders({ 'content-type': 'application/json', 'cache-control': 'no-cache' }));
  response.end(JSON.stringify(body));
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

function makeAnalysisId(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

/**
 * §P0 fix (2026-07-06 cold-customer cross-tenant bleed) — analysis storage
 * (`workspacePath(dataDir, analysisId)`) is a shared, flat directory keyed
 * ONLY by whatever id reaches this function's call sites. Before this fix,
 * every call site used `request.project_id || makeAnalysisId(request.project_path
 * || ...)` directly. Critically, the CLI/client (remote-sync-client.ts's
 * `defaultAnalysisId`) ALWAYS sends a non-empty `project_id`, even for a repo
 * never connected to any account: `resolveAnalysisId` falls back to
 * `defaultAnalysisId(projectPath) = sha256(path.resolve(projectPath))`
 * client-side whenever `.klaurorc` has no bound `project.id` yet. That value
 * is a BARE, UNSALTED hash of the local filesystem path, identical for every
 * account whose repo happens to be checked out at the same absolute path (a
 * routine occurrence on a shared devbox, CI runner, or simply two people who
 * both `git clone` to the same conventional directory name). Because the
 * client-sent value was always truthy, the server's own
 * `|| makeAnalysisId(...)` fallback never even ran: the raw client hash was
 * trusted verbatim as the on-disk storage key, so account B's very first
 * analyze silently read/overwrote account A's stored CAS at the identical
 * `workspacePath`, and any tool resolving by that id (reanalyze, MCP resolve,
 * revisions) served account A's real data to account B. That is exactly what
 * the cold-customer audit reproduced end-to-end via the live API.
 *
 * FIX: every call site that turns a client-supplied id into a storage key now
 * routes through this function instead of trusting `project_id` verbatim.
 * Rule:
 *  - `rawId` that already looks like an AccountStore project id (`prj_...`)
 *    is returned UNCHANGED: it is already globally unique (server-generated
 *    by AccountStore.createProject) and every read of it is already
 *    authorization-checked via getProjectForUser/requireMembership, so there
 *    is no collision risk and no need to re-derive it.
 *  - `rawId` that already carries this function's own `acct_` output prefix
 *    (see below) is ALSO returned unchanged. This is the idempotency case: a
 *    client legitimately round-trips the salted id it was handed back on the
 *    first `/v1/analyze` response (e.g. `analyzeCodebaseRemotely({
 *    analysisId })` on a re-push, or `/v1/sync`'s `analysis_id`) — without
 *    this check, re-salting an already-salted id on every subsequent request
 *    would compute a DIFFERENT storage key each time and break the very
 *    re-push/sync idempotency the pre-existing test suite already covers
 *    (account-workspace-analysis.test.ts's debounced-batch-push test caught
 *    this: a naive "always salt" version regressed it).
 *  - Any other `rawId` (the bare, unprefixed path/name hash — the exact
 *    collision case above) is RE-DERIVED by folding the authenticated
 *    account (`accountSalt` = `user:<id>` from authorizeAnalyzerRequest)
 *    into the hash and prefixing the result with `acct_`, so the same raw
 *    value from two different accounts maps to two different, clearly-
 *    tagged storage keys, collapsing the previously shared keyspace into a
 *    per-account one. Deterministic per (account, rawId) pair, so the SAME
 *    account's later `/v1/sync` call (which resends the id from its own
 *    `/v1/analyze` response) still resolves to the workspace its own
 *    `/v1/analyze` created — and, by the previous bullet, does not get
 *    re-salted a second time.
 *  - `accountSalt` undefined (anonymous / shared-token request, no account to
 *    namespace by) preserves the exact pre-fix unsalted hash, so
 *    self-hosted/no-auth deployments and the shared-analyzer-token flow are
 *    byte-for-byte unchanged.
 */
function resolveStorageAnalysisId(rawId: string, accountSalt: string | undefined): string {
  if (/^prj_/.test(rawId) || /^acct_/.test(rawId)) return rawId;
  return accountSalt ? `acct_${makeAnalysisId(accountSalt + '::' + rawId)}` : rawId;
}

/**
 * Real display name for a project, computed BEFORE the hash-workspace swap
 * (analysisId/workspace is a sha256-derived directory name — see
 * makeAnalysisId/workspacePath — so `path.basename(workspace)` downstream
 * would otherwise resolve to the hash).
 *
 * Prefers the basename of the real, caller-supplied `project_path` (this is
 * what the actual product client sends — see remote-sync-client.ts — and is
 * always the user's real local repo directory) over the snapshot's
 * `project_name`, because `project_name` itself falls back to
 * `path.basename(root)` of whatever directory was walked to build the
 * snapshot (see buildSourceSnapshot in remote-source.ts) — for a staged/
 * temporary source tree (e.g. a bench harness staging into a throwaway git
 * repo) that basename is the STAGING directory, not the real project. Only
 * falls back to `project_name` when no `project_path` was supplied at all.
 */
function resolveDisplayName(projectName?: string, projectPath?: string): string | undefined {
  return (projectPath ? path.basename(projectPath) : undefined) || projectName;
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
