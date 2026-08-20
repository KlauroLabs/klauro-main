import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'fs-extra';
import { createReadStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ensurePrivateDataRoot, restrictProcessFileCreation } from './hosted-storage-security';
import { analyzeProjectIncremental, analyzeProjectDeferred, checkDoomedVersionRebuild, getAnalysis, prewarmAnalysisWorker, runAnalysis, runLayeredAnalysis } from './analyzer';
import { REMOTE_ANALYSIS_PROTOCOL_VERSION, clientUpgradeRequiredMessage, type AccountActivityEvent, type RemoteAnalyzeDiffRequest, type RemoteAnalyzeRequest, type RemoteAnalyzeResponse, type RemoteGreenfieldPreviewRequest, type RemoteProjectRevision, type RemoteProjectRevisionsResponse, type RemoteProposalPreviewRequest, type RemoteSyncRequest } from './remote-analyzer-protocol';
import { buildSourceSnapshot, type BranchDiffContext, type RemoteFileChange, type RepoFacts, type SourceManifest } from './remote-source';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { previewCodebaseIteration, previewGreenfieldCodebase } from './proposal-preview';
import { isDirectCliInvocation } from './cli-invocation';
import { AccountHttpError, AccountStore, type AccountProject } from './account-store';
import { AccountWorkspaceAnalysisScheduler } from './account-workspace-analysis';
import { getClaimStreams, heartbeatClaimStream, publishClaimStream, releaseClaimStream, type AgentKind, type ConceptualCoordinate, type DeclaredContract } from './coordination';
import { appendClaim, checkEditLock, describeCursorGap, extendClaim, getActiveClaims, getBoardInfo, getPresence, readClaimLog, releaseAgentWithReason, releaseClaimById, warnIfEphemeralCoordDir, type ClaimLogEntry } from './coordination/local-store';
import { deriveActiveClaims } from './coordination/presence';
import { appendSecurityAudit, defaultSecretDenyPatterns, getSecurityStoreDir, redactInFlightChanges } from './coordination/security';
import { detectConceptualConflicts, type AgentInFlightState, type ConceptualConflict, type ConflictCas, type SymbolChange } from './coordination/conceptual-conflict';
import { detectConceptualConflictsFromSubstrate } from './coordination/in-flight-substrate';
import {
  appendParticipantInFlightSnapshot,
  readParticipantInFlightSnapshots,
  type InFlightAttributionSource,
  type ParticipantInFlightSnapshot,
} from './coordination/participant-in-flight-store';
import { partitionTasks, type PartitionCas, type PartitionTask } from './coordination/partitioner';
import { compareConceptualCoordinates } from './coordination/conceptual-scope';
import { getMergelessMetrics } from './coordination/mergeless-metrics';
import { planIntentMerge, planIntentMergeFromSubstrate, type MergePlan } from './coordination/intent-merge';
import { ingestAndPersist, loadPersistedRuntimeFacts } from './telemetry-fusion';
import { backfillIngestedTelemetry, ingestTelemetryBatch, loadTelemetryObservations, summarizeRouteMetrics } from './telemetry-ingestion';
import { buildNodeRuntimeMetrics } from './product';
import { buildSummary, getProductMap, getFlowConcepts, getArchitecturalConflicts, getParadigmConformance, getPerspectives, getCicdPipelines, getCommunicationSeams, buildOrientCapsule, getSemanticCoverage, getDataEntities } from './query';
import type { SemanticRole } from './semantic-roles';
import {
  getAnalysisEntry,
  getAnalysisFileFingerprint,
  loadAnalysis,
  loadAnalysisSectionManifest,
  loadAnalysisSections,
  resolveAnalysisSectionExportArtifact,
  resolveAnalysisExportArtifact,
  resolveSegmentedAnalysisExportManifest,
  saveAnalysis,
  writeJsonAtomic,
} from './storage';
import { parseCasSectionNames, selectCasSections, type CasSectionName } from './cas-sections';
import { clearFreshnessSummaryCache } from './freshness';
import { descriptionStorePath, generateElementDescription } from './description-enrichment';
import { isAnalysisFocus, withAnalysisFocus } from './analysis-focus';
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
import { analysisJobMetadata } from './analysis-job-metadata';
import { IdempotentRequestStore, IdempotentSyncStore } from './idempotent-sync-store';

const DEFAULT_PORT = 8787;
const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024;
declare const __KLAURO_VERSION__: string | undefined;
const SERVICE_VERSION: string | null = (() => {
  try {
    if (typeof __KLAURO_VERSION__ === 'string' && __KLAURO_VERSION__) return __KLAURO_VERSION__;
  } catch {   }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version || null;
  } catch {
    return null;
  }
})();
const SSE_HEARTBEAT_MS = 25_000;
const REMOTE_ADVISORY_DEFAULT_TTL_MS = 30 * 60 * 1000;
const coordinationSubscribers = new Map<string, Set<http.ServerResponse>>();
function broadcastCoordinationEvent(workspace: string, event: string, data: unknown): void {
  const subscribers = coordinationSubscribers.get(workspace);
  if (!subscribers || subscribers.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const subscriber of subscribers) {
    try {
      subscriber.write(payload);
    } catch {
    }
  }
}

function publicParticipantSnapshot(snapshot: ParticipantInFlightSnapshot) {
  return {
    agent_id: snapshot.agent_id,
    base_commit: snapshot.base_commit,
    branch: snapshot.branch,
    updated_at: snapshot.updated_at,
    attribution_source: snapshot.attribution_source,
    changes_count: snapshot.changes?.length ?? 0,
    changes: snapshot.changes ?? [],
  };
}

interface RemoteAnalyzerServiceOptions {
  dataDir?: string;
  token?: string;
  maxBodyBytes?: number;
  rateLimitPerMinute?: number;
  fabricRateLimitPerMinute?: number;
  coordinationOnly?: boolean;

  deferAiEnrichment?: boolean;
}

interface RateLimitBucket {
  windowStart: number;
  count: number;
}

let legacyCwdDataDirSweepDone = false;

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
  } catch {}
}

export function createRemoteAnalyzerHttpServer(options: RemoteAnalyzerServiceOptions = {}): http.Server {
  const dataDir = path.resolve(
    options.dataDir
      || process.env.KLAURO_REMOTE_ANALYZER_DATA
      || path.join(os.tmpdir(), `klauro-remote-analyzer-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`)
  );
  ensurePrivateDataRoot(dataDir);
  removeLegacyCwdDataDir(dataDir);
  const token = options.token ?? process.env.KLAURO_ANALYZER_TOKEN;
  const maxBodyBytes = options.maxBodyBytes || resolveMaxBodyBytes();
  const rateLimitPerMinute = options.rateLimitPerMinute ?? Number(process.env.KLAURO_ANALYZER_RATE_LIMIT_PER_MINUTE || 120);
  const buckets = new Map<string, RateLimitBucket>();
  const fabricRateLimitPerMinute = options.fabricRateLimitPerMinute ?? Number(process.env.KLAURO_FABRIC_RATE_LIMIT_PER_MINUTE || 12_000);
  const fabricBuckets = new Map<string, RateLimitBucket>();
  const authBuckets = new Map<string, RateLimitBucket>();
  const authRateLimitPerMinute = Number(process.env.KLAURO_AUTH_RATE_LIMIT_PER_MINUTE || 20);
  const activeCommittedSnapshots = new Map<string, string>();
  const completedSyncRequests = new IdempotentSyncStore<RemoteAnalyzeResponse, CASOutput>();
  const acceptedSyncRequests = new IdempotentRequestStore<PreparedSync>();
  warnIfEphemeralCoordDir({ dataRoot: dataDir });

  void reapStaleAttemptRecordsOnStartup(dataDir);
  const accounts = new AccountStore(dataDir);

  const workspaceAnalyses = new AccountWorkspaceAnalysisScheduler(dataDir, accounts);
  const notifyProjectAnalysisLandedForAnalysisId = async (analysisId: string | undefined): Promise<void> => {
    if (!analysisId) return;
    try {
      const projects = await accounts.findProjectsByAnalysisId(analysisId);
      const workspaceIds = new Set(projects.map(project => project.workspace_id));
      for (const workspaceId of workspaceIds) workspaceAnalyses.notifyProjectAnalysisLanded(workspaceId);
    } catch (error) {

      console.error(`[Klauro] failed to schedule workspace analysis rebuild for analysis ${analysisId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

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

        const buildIdentity = getBuildIdentity();
        writeJson(response, 200, {
          status: 'ok',
          service: 'klauro-remote-analyzer',
          version: SERVICE_VERSION,

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

      if (options.coordinationOnly && !route.startsWith('/v1/coordination/')) {
        writeJson(response, 404, { status: 'error', error: 'This service accepts coordination routes only.' });
        return;
      }

      if ((request.method === 'GET' || request.method === 'HEAD') && (route === '/install' || route === '/install.sh')) {
        await serveInstallScript(response);
        return;
      }

      if ((request.method === 'GET' || request.method === 'HEAD') && route === '/install.ps1') {
        await serveInstallPowershell(response);
        return;
      }

      if ((request.method === 'GET' || request.method === 'HEAD') && route === '/dist/latest.json') {
        await serveLatestManifest(request, response);
        return;
      }

      if ((request.method === 'GET' || request.method === 'HEAD') && (route === '/dist/klauro-latest.tgz' || route.startsWith('/dist/'))) {
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
      const requireCoordinationWorkspace = async (workspace: string): Promise<boolean> => {
        if (clientId !== 'shared-token' && !clientId.startsWith('user:')) {
          writeJson(response, 401, {
            status: 'error',
            error: 'Remote coordination requires a signed-in account or configured analyzer token.',
          });
          return false;
        }
        if (await canAccessCoordinationWorkspace(accounts, clientId, workspace)) return true;
        writeJson(response, 404, {
          status: 'error',
          error: 'Coordination workspace not found, or your account is not a member of its workspace.',
        });
        return false;
      };
      const mutation = requestConsumesMutationRateLimit(request.method);
      const fabricMutation = mutation && route.startsWith('/v1/coordination/');
      const rateLimitAccepted = !mutation || withinRateLimit(
        fabricMutation ? fabricBuckets : buckets,
        clientId,
        fabricMutation ? fabricRateLimitPerMinute : rateLimitPerMinute,
      );
      if (!rateLimitAccepted) {
        await appendAuditLog(dataDir, {
          event: 'rate_limited',
          method: request.method,
          url: request.url,
          client: anonymizeClient(clientId),
          surface: fabricMutation ? 'fabric' : 'analyzer',
        });
        writeJson(response, 429, {
          status: 'error',
          error: fabricMutation ? 'Fabric update rate limit exceeded' : 'Remote analyzer rate limit exceeded',
        });
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

        if (body.analysis_focus !== undefined && !isAnalysisFocus(body.analysis_focus)) {
          writeJson(response, 400, { status: 'error', error: 'analysis_focus must be agent-fast, ui-overview, deep-context, or full' });
          return;
        }

        if (!(await authorizeProjectWrite(accounts, authorization.clientId, body.project_id))) {
          writeJson(response, 404, { status: 'error', error: PROJECT_WRITE_DENIED_MESSAGE });
          return;
        }

        {

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
          const currentRevision = revisions.revisions[0];
          const reusableRevision = currentRevision && revisionMatchesSnapshot(currentRevision, body.snapshot.manifest, body.snapshot.base_commit, body.analysis_focus)
            ? currentRevision
            : undefined;
          const storedAnalysisExists = reusableRevision
            ? Boolean(await getAnalysisFileFingerprint(acceptedWorkspace, { track: 'main' }))
            : false;

          const analysisAlreadyRunning = Boolean(snapshotIdentity && activeIdentity === snapshotIdentity);
          const snapshotUnchanged = Boolean(reusableRevision && storedAnalysisExists);

          const identityDecision = snapshotUnchanged && !analysisAlreadyRunning
            ? await analyzerIdentityReuseDecisionFor(acceptedWorkspace)
            : null;

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
          const forcedOverReuse = Boolean(body.force) && !analysisAlreadyRunning
            && snapshotUnchanged && identityDecision?.reusable === true;
          const attemptRecordPath = projectAttemptRecordPath(acceptedWorkspace);
          const attemptStartedAt = new Date().toISOString();
          const acceptedRevision = Date.now();
          const attemptSnapshot: ReanalyzeAttemptRecord = {
            state: 'in-progress',
            trigger: 'analyze',
            started_at: attemptStartedAt,
            analysis_revision: acceptedRevision,
          };
          await writeAttemptRecord(attemptRecordPath, { ...attemptSnapshot, heartbeat_at: attemptStartedAt });
          const backgroundAnalysis = analysisJobMetadata(body);
          writeJson(response, 202, {
            status: 'accepted',
            protocol_version: REMOTE_ANALYSIS_PROTOCOL_VERSION,
            analysis_id: visibleAnalysisId,
            analysis_revision: acceptedRevision,
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
            const stopHeartbeat = startAttemptHeartbeat(attemptRecordPath, attemptSnapshot);
            try {
              const displayName = backgroundAnalysis.displayName;

              const doomed = await checkDoomedVersionRebuild(acceptedWorkspace);
              if (doomed) throw new Error(doomed);

              let l0Attach: Promise<void> | null = null;
              const summary = await runLayeredAnalysis(acceptedWorkspace, {
                displayName,
                analysisFocus: backgroundAnalysis.analysisFocus,
                repoFacts: backgroundAnalysis.repoFacts,
                repoFactsUnavailable: !backgroundAnalysis.repoFacts,

                forceAiRefresh: backgroundAnalysis.force,

                forceFullRebuild: backgroundAnalysis.force,
                onPhase: (event) => {

                  if (event.phase === 'l0' && event.status === 'succeeded' && !l0Attach) {
                    l0Attach = (async () => {
                      try {
                        await linkAnalysisToAccountProject(accounts, backgroundClientId, backgroundAnalysis.projectId, acceptedAnalysisId, backgroundAnalysis.gitRemote, backgroundAnalysis.repoFacts);
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

              await appendProjectRevision(dataDir, {
                status: 'success',
                analysis_id: acceptedAnalysisId,
                analysis_revision: acceptedRevision,
                analysis_type: 'full',
                base_commit: backgroundAnalysis.baseCommit,
                manifest: backgroundAnalysis.manifest,
                nodes: summary.nodes,
                edges: summary.edges,
                analysis_focus: backgroundAnalysis.analysisFocus || 'full',
              }, 'local_commit_submission');

              if (!attachedEarly) {
                await linkAnalysisToAccountProject(accounts, backgroundClientId, backgroundAnalysis.projectId, acceptedAnalysisId, backgroundAnalysis.gitRemote, backgroundAnalysis.repoFacts);
              }
              await appendAuditLog(dataDir, {
                event: 'analyze',
                analysis_id: acceptedAnalysisId,
                project_id: backgroundAnalysis.projectId,
                organization_id: backgroundAnalysis.organizationId,
                files: backgroundAnalysis.manifest?.file_count,
                bytes: backgroundAnalysis.manifest?.total_bytes,
                nodes: summary.nodes,
                edges: summary.edges,
                mode: 'async',
              });
              void notifyProjectAnalysisLandedForAnalysisId(acceptedAnalysisId);
              const attemptFinishedAt = new Date().toISOString();
              await writeAttemptRecord(attemptRecordPath, {
                ...attemptSnapshot,
                state: 'succeeded',
                finished_at: attemptFinishedAt,
                duration_ms: Date.parse(attemptFinishedAt) - Date.parse(attemptStartedAt),
              });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              const diagnostic = error instanceof Error ? error.stack || detail : detail;
              console.error(`[Klauro] async analyze failed for ${acceptedAnalysisId}: ${diagnostic}`);

              await markBackgroundAnalysisFailed(acceptedWorkspace, detail);
              const attemptFinishedAt = new Date().toISOString();
              await writeAttemptRecord(attemptRecordPath, {
                ...attemptSnapshot,
                state: 'failed',
                finished_at: attemptFinishedAt,
                duration_ms: Date.parse(attemptFinishedAt) - Date.parse(attemptStartedAt),
                reason: detail.slice(0, 300),
              });
              await appendAuditLog(dataDir, {
                event: 'analyze_async_failed',
                analysis_id: acceptedAnalysisId,
                project_id: backgroundAnalysis.projectId,
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

        await reapAbandonedAttempt(workspace, attemptRecordPath);
        const entry = await getAnalysisEntry(workspace);
        const lastAttempt = await readAttemptRecord(attemptRecordPath);
        const layers = entry?.layers_ready?.layers || [];
        const failedLayers = layers.filter(layer => layer.status === 'error');
        const complete = Boolean(
          entry
          && (entry.layers_ready?.complete ?? true)
          && lastAttempt?.state !== 'in-progress'
          && !activeCommittedSnapshots.has(analysisId),
        );

        const latestAnalyzeFailed = lastAttempt?.state === 'failed' && lastAttempt.trigger === 'analyze';
        const abandonedWithNoCas = !complete && failedLayers.length === 0 && lastAttempt?.state === 'failed';
        writeJson(response, 200, {
          status: failedLayers.length > 0 || latestAnalyzeFailed ? 'failed' : complete ? 'ready' : abandonedWithNoCas ? 'failed' : 'populating',
          analysis_id: analysisId,
          ...(lastAttempt?.analysis_revision ? { analysis_revision: lastAttempt.analysis_revision } : {}),
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

      const rawAnalysisManifestMatch = route.match(/^\/v1\/analyses\/([^/]+)\/cas\/manifest$/);
      if (request.method === 'GET' && rawAnalysisManifestMatch) {
        const analysisId = await resolveAuthorizedAnalysisReadId(
          accounts,
          authorization.clientId,
          decodeURIComponent(rawAnalysisManifestMatch[1]),
        );
        if (!analysisId) {
          writeJson(response, 404, { status: 'error', error: 'Analysis not found' });
          return;
        }
        const manifest = await resolveSegmentedAnalysisExportManifest(workspacePath(dataDir, analysisId));
        if (!manifest) {
          writeJson(response, 404, { status: 'error', error: 'Segmented analysis is not ready' });
          return;
        }
        writeJson(response, 200, manifest);
        return;
      }

      const rawAnalysisSectionMatch = route.match(/^\/v1\/analyses\/([^/]+)\/cas\/sections\/([^/]+)$/);
      if (request.method === 'GET' && rawAnalysisSectionMatch) {
        const analysisId = await resolveAuthorizedAnalysisReadId(
          accounts,
          authorization.clientId,
          decodeURIComponent(rawAnalysisSectionMatch[1]),
        );
        if (!analysisId) {
          writeJson(response, 404, { status: 'error', error: 'Analysis not found' });
          return;
        }
        let section: CasSectionName;
        try {
          section = parseCasSectionNames(decodeURIComponent(rawAnalysisSectionMatch[2]))[0];
          if (!section) throw new Error('Missing CAS section');
        } catch (error) {
          writeJson(response, 400, { status: 'error', error: error instanceof Error ? error.message : String(error) });
          return;
        }
        const artifact = await resolveAnalysisSectionExportArtifact(workspacePath(dataDir, analysisId), section);
        if (!artifact) {
          writeJson(response, 404, { status: 'error', error: 'CAS section is not ready' });
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
        const analysisWorkspace = workspacePath(dataDir, analysisId);
        const lastAttempt = await readAttemptRecord(projectAttemptRecordPath(analysisWorkspace));
        if (lastAttempt?.state === 'in-progress') {
          writeJson(response, 409, { status: 'error', error: 'Analysis is still populating' });
          return;
        }
        const artifact = await resolveAnalysisExportArtifact(analysisWorkspace);
        if (!artifact) {
          writeJson(response, 404, { status: 'error', error: 'Analysis is not ready' });
          return;
        }
        response.writeHead(200, {
          'content-type': artifact.codec === 'zstd' ? 'application/zstd' : 'application/json',
          'content-length': artifact.bytes,
          'x-klauro-cas-codec': artifact.codec,
          'x-klauro-analysis-id': analysisId,
          ...(lastAttempt?.state === 'succeeded' && lastAttempt.analysis_revision ? {
            'x-klauro-analysis-revision': String(lastAttempt.analysis_revision),
          } : {}),
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

        if (!(await authorizeProjectWrite(accounts, authorization.clientId, body.analysis_id))) {
          writeJson(response, 404, { status: 'error', error: PROJECT_WRITE_DENIED_MESSAGE });
          return;
        }
        if (body.async === true) {
          const accountSalt = accountSaltFor(authorization.clientId);
          const analysisId = resolveStorageAnalysisId(body.analysis_id, accountSalt);
          const { value: prepared, replayed } = await acceptedSyncRequests.run(
            analysisId, body.request_id, () => prepareSync(dataDir, body, accountSalt));
          const attemptRecordPath = projectAttemptRecordPath(prepared.workspace);
          const queuedAt = new Date().toISOString();
          writeJson(response, 202, {
            status: 'accepted',
            protocol_version: REMOTE_ANALYSIS_PROTOCOL_VERSION,
            analysis_id: clientVisibleAnalysisId(body.analysis_id, prepared.analysisId, authorization.clientId),
            base_commit: body.changes.base_commit,
            manifest: prepared.manifest,
          });
          if (replayed) return;
          await writeAttemptRecord(attemptRecordPath, {
            state: 'in-progress',
            trigger: 'sync',
            queued_at: queuedAt,
            started_at: queuedAt,
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
        const { value: result, replayed } = await handleSync(dataDir, body, completedSyncRequests, accountSaltFor(authorization.clientId));
        if (!replayed) await recordCompletedSync(dataDir, accounts, body, result, authorization.clientId);
        writeJson(response, 200, {
          ...result,
          analysis_id: clientVisibleAnalysisId(body.analysis_id, result.analysis_id, authorization.clientId),
        });

        void notifyProjectAnalysisLandedForAnalysisId(result.analysis_id);

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

      if (request.method === 'POST' && route === '/v1/coordination/claim') {

        const body = await readJsonBody<{
          workspace: string; agent_id: string; intent: string; agent_kind?: AgentKind;
          paths?: string[]; symbols?: string[]; capability?: string; ttl_ms?: number;
          base_commit?: string; branch?: string; claim_id?: string;

          mode?: 'advisory' | 'grant';

          status?: 'active' | 'released';
          version?: number;
          kind?: ClaimLogEntry['kind'];

          produces?: DeclaredContract[];
          consumes?: string[];
          concept?: ConceptualCoordinate;
        }>(request, maxBodyBytes);

        if (!body.workspace || !body.agent_id || !body.intent) {
          writeJson(response, 400, { status: 'error', error: 'workspace, agent_id, and intent are required' });
          return;
        }
        if (!(await requireCoordinationWorkspace(body.workspace))) return;

        if (body.mode === 'advisory') {
          const workspace = body.workspace;
          const claimPaths = body.paths || [];
          const conflicts = claimPaths.length ? await checkEditLock(workspace, claimPaths, body.agent_id) : [];
          const conceptualAwareness = body.concept
            ? (await getActiveClaims(workspace))
                .filter((claim) => claim.agent_id !== body.agent_id && claim.scope.concept)
                .map((claim) => ({ claim, comparison: compareConceptualCoordinates(body.concept, claim.scope.concept) }))
                .filter(({ comparison }) => comparison.verdict !== 'unrelated')
                .map(({ claim, comparison }) => ({
                  agent_id: claim.agent_id,
                  intent: claim.intent,
                  ...comparison,
                }))
            : [];
          const now = new Date().toISOString();
          const entry = await appendClaim(workspace, {
            claim_id: body.claim_id || `${workspace}:${body.agent_id}`,
            workspace_id: workspace,
            agent_id: body.agent_id,
            agent_kind: body.agent_kind || 'other',
            scope: { repo: workspace, paths: claimPaths, symbols: body.symbols || [], capability: body.capability, concept: body.concept },
            intent: body.intent,

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
            conceptual_awareness: conceptualAwareness,
            warning: conflicts.length
              ? `ADVISORY: ${conflicts.length} other agent(s) already claim overlapping paths (${conflicts.map((c) => c.agent_id).join(', ')}). Your claim still succeeded — coordinate before writing.`
              : undefined,
          });
          return;
        }

        const result = await publishClaimStream({
          workspace_id: body.workspace,
          agent_id: body.agent_id,
          agent_kind: body.agent_kind || 'other',
          scope: { repo: body.workspace, paths: body.paths || [], symbols: body.symbols || [], capability: body.capability },
          intent: body.intent,
          ttl_ms: body.ttl_ms,
        });

        broadcastCoordinationEvent(body.workspace, 'claim', {
          claim_id: result.claim_id,
          agent_id: body.agent_id,
          verdict: result.verdict,
        });
        writeJson(response, 200, {
          claim_id: result.claim_id,
          verdict: result.verdict,
          grant_id: result.claim_id,
          lease_expires_at: result.lease_expires_at,
          conflict: result.conflict,
          redirect_hint: result.redirect_hint,
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
        if (!body.workspace) {
          writeJson(response, 400, { status: 'error', error: 'workspace is required to release a grant', claim_id: body.claim_id });
          return;
        }
        if (!(await requireCoordinationWorkspace(body.workspace))) return;

        if (!body.claim_id) {

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
        const grantOutcome = await releaseClaimStream(body.workspace, body.agent_id, body.claim_id);
        if (grantOutcome.released) {
          broadcastCoordinationEvent(body.workspace, 'release', {
            claim_id: body.claim_id,
            agent_id: body.agent_id,
            status: 'released',
            mode: 'claim-stream',
          });
          writeJson(response, 200, { status: 'released', claim_id: body.claim_id, mode: 'claim-stream', tier: 'fabric' });
          return;
        }

        writeJson(response, 200, {
          status: 'not_found',
          claim_id: body.claim_id,
          agent_id: body.agent_id,
          reason:
            `No ACTIVE claim "${body.claim_id}" for agent "${body.agent_id}" in workspace "${body.workspace}" ` +
            `— checked both Fabric claim stores. Already released/` +
            `superseded/expired, an unknown/mistyped id, or a workspace-id mismatch. To release EVERY advisory ` +
            `claim this agent holds regardless of claim_id, call again with no claim_id.`,
        });
        return;
      }

      if (request.method === 'POST' && route === '/v1/coordination/heartbeat') {
        const body = await readJsonBody<{ workspace: string; claim_id: string }>(request, maxBodyBytes);
        if (!body.workspace || !body.claim_id) {
          writeJson(response, 400, { status: 'error', error: 'workspace and claim_id are required' });
          return;
        }
        if (!(await requireCoordinationWorkspace(body.workspace))) return;
        const result = await heartbeatClaimStream(body.workspace, body.claim_id);
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

      if (request.method === 'POST' && route === '/v1/coordination/check') {
        const body = await readJsonBody<{ workspace: string; agent_id?: string; paths?: string[] }>(request, maxBodyBytes);
        if (!body.workspace) {
          writeJson(response, 400, { status: 'error', error: 'workspace is required' });
          return;
        }
        if (!(await requireCoordinationWorkspace(body.workspace))) return;
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

      if (request.method === 'POST' && route === '/v1/coordination/extend') {
        const body = await readJsonBody<{
          workspace: string;
          claim_id: string;
          add_paths?: string[];
          add_symbols?: string[];
          add_produces?: DeclaredContract[];
          add_consumes?: string[];
          concept?: ConceptualCoordinate;
        }>(request, maxBodyBytes);
        if (!body.workspace || !body.claim_id) {
          writeJson(response, 400, { status: 'error', error: 'workspace and claim_id are required' });
          return;
        }
        if (!(await requireCoordinationWorkspace(body.workspace))) return;
        const outcome = await extendClaim(
          body.workspace,
          body.claim_id,
          body.add_paths ?? [],
          body.add_symbols ?? [],
          { produces: body.add_produces, consumes: body.add_consumes, concept: body.concept }
        );
        broadcastCoordinationEvent(body.workspace, 'extend', {
          claim_id: outcome.claim.claim_id,
          agent_id: outcome.claim.agent_id,
          paths: outcome.claim.scope.paths,
          symbols: outcome.claim.scope.symbols,
          produces: outcome.claim.produces ?? [],
          consumes: outcome.claim.consumes ?? [],
          concept: outcome.claim.scope.concept,
        });
        writeJson(response, 200, {
          status: 'extended',
          workspace: body.workspace,
          claim_id: outcome.claim.claim_id,
          agent_id: outcome.claim.agent_id,
          seq: outcome.claim.seq,
          paths: outcome.claim.scope.paths,
          symbols: outcome.claim.scope.symbols,
          produces: outcome.claim.produces ?? [],
          consumes: outcome.claim.consumes ?? [],
          concept: outcome.claim.scope.concept,
          conflicts: outcome.conflicts,
          server_time: new Date().toISOString(),
        });
        return;
      }

      if (request.method === 'GET' && route === '/v1/coordination/active') {
        const workspace = requestUrl.searchParams.get('workspace') || '';
        if (!workspace) {
          writeJson(response, 400, { status: 'error', error: 'workspace query param is required' });
          return;
        }
        if (!(await requireCoordinationWorkspace(workspace))) return;
        const log = await readClaimLog(workspace);
        const active = await getActiveClaims(workspace);
        const inFlight = await readParticipantInFlightSnapshots(workspace);
        const board = await getBoardInfo(workspace);
        writeJson(response, 200, {
          workspace,
          count: active.length,
          max_seq: log.reduce((max, entry) => Math.max(max, entry.seq), 0),
          epoch: board.epoch,
          min_retained_seq: board.min_retained_seq,
          server_time: new Date().toISOString(),
          in_flight: inFlight.map(publicParticipantSnapshot),
          active: active.map((c) => ({
            claim_id: c.claim_id,
            seq: c.seq,
            agent_id: c.agent_id,
            agent_kind: c.agent_kind,
            status: c.status,
            intent: c.intent,
            paths: c.scope.paths,
            symbols: c.scope.symbols,
            concept: c.scope.concept,
            produces: c.produces,
            consumes: c.consumes,
            heartbeat_at: c.heartbeat_at,
            ttl_ms: c.ttl_ms,
          })),
        });
        return;
      }

      if (request.method === 'GET' && route === '/v1/coordination/metrics') {
        const workspace = requestUrl.searchParams.get('workspace') || '';
        if (!workspace) {
          writeJson(response, 400, { status: 'error', error: 'workspace query param is required' });
          return;
        }
        if (!(await requireCoordinationWorkspace(workspace))) return;
        writeJson(response, 200, await getMergelessMetrics(workspace));
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
        if (!(await requireCoordinationWorkspace(workspace))) return;

        const log = await readClaimLog(workspace);
        const claims = await getActiveClaims(workspace);
        const presence = await getPresence(workspace);
        const grants = await getClaimStreams(workspace);
        const inFlight = await readParticipantInFlightSnapshots(workspace);
        const board = await getBoardInfo(workspace);
        const holderCtx = await describeGrantHolders(workspace, grants.active.map((g) => g.agent_id));
        const maxSeq = log.reduce((max, entry) => Math.max(max, entry.seq), 0);

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
          streams: grants.active,
          in_flight: inFlight.map(publicParticipantSnapshot),
        });
        return;
      }

      if (request.method === 'GET' && route === '/v1/coordination/stream') {
        const workspace = requestUrl.searchParams.get('workspace') || '';
        if (!workspace) {
          writeJson(response, 400, { status: 'error', error: 'workspace query param is required' });
          return;
        }
        if (!(await requireCoordinationWorkspace(workspace))) return;
        response.writeHead(200, corsHeaders({
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        }));
        response.write(': connected\n\n');

        const claims = await getActiveClaims(workspace);
        const presence = await getPresence(workspace);
        const inFlight = await readParticipantInFlightSnapshots(workspace);
        const board = await getBoardInfo(workspace);
        response.write(
          `event: state\ndata: ${JSON.stringify({
            workspace,
            epoch: board.epoch,
            min_retained_seq: board.min_retained_seq,
            claims,
            presence,
            in_flight: inFlight.map(publicParticipantSnapshot),
          })}\n\n`
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

      if (request.method === 'POST' && route === '/v1/coordination/conceptual-conflicts') {
        const body = await readJsonBody<{
          workspace: string; agent_id: string; agent_kind?: AgentKind;
          intent: string; changes?: SymbolChange[];
        }>(request, maxBodyBytes);
        if (!body.workspace || !body.agent_id) {
          writeJson(response, 400, { status: 'error', error: 'workspace and agent_id are required' });
          return;
        }
        if (!(await requireCoordinationWorkspace(body.workspace))) return;
        const requesterChanges: SymbolChange[] = Array.isArray(body.changes) ? body.changes : [];
        await reportConceptualChangesHttp(body.workspace, body.agent_id, body.agent_kind || 'other', body.intent || '', requesterChanges);

        const others = await otherAgentConceptualStatesHttp(body.workspace, body.agent_id);
        const cas = await conceptualConflictCasForWorkspaceHttp(body.workspace);
        const requesterState: AgentInFlightState = { agent_id: body.agent_id, intent: body.intent || '', changes: requesterChanges };
        const gitBasedConflicts = detectConceptualConflicts([requesterState, ...others], cas);

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

      if (request.method === 'POST' && route === '/v1/coordination/plan-parallel-work') {
        const body = await readJsonBody<{
          tasks: PartitionTask[]; path?: string; include_blast_radius?: boolean;
        }>(request, maxBodyBytes);
        if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
          writeJson(response, 400, { status: 'error', error: 'tasks (non-empty array) is required' });
          return;
        }
        if (body.path && !(await requireCoordinationWorkspace(body.path))) return;

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

      if (request.method === 'POST' && route === '/v1/coordination/intent-merge') {
        const body = await readJsonBody<{
          workspace: string; agent_id: string; states?: AgentInFlightState[];
        }>(request, maxBodyBytes);
        if (!body.workspace || !body.agent_id) {
          writeJson(response, 400, { status: 'error', error: 'workspace and agent_id are required' });
          return;
        }
        if (!(await requireCoordinationWorkspace(body.workspace))) return;
        const explicitStates = Array.isArray(body.states) && body.states.length > 0;
        const cas = await conceptualConflictCasForWorkspaceHttp(body.workspace);
        const planStates: AgentInFlightState[] = explicitStates
          ? (body.states as AgentInFlightState[])
          : await otherAgentConceptualStatesHttp(body.workspace, body.agent_id);
        const semanticPlan = explicitStates ? undefined : await planIntentMergeFromSubstrate(body.workspace, cas);
        const hasSemanticParticipants = Boolean(semanticPlan)
          && semanticPlan!.attribution.participants + semanticPlan!.attribution.tiebroken > 0;
        const plan: MergePlan = hasSemanticParticipants ? semanticPlan! : planIntentMerge(planStates, cas);
        writeJson(response, 200, {
          workspace: body.workspace,
          attribution_source: hasSemanticParticipants
            ? semanticPlan!.attribution.source
            : explicitStates ? 'explicit-agent-states' : 'legacy-reported-states',
          agents_considered: hasSemanticParticipants
            ? semanticPlan!.attribution.participants + semanticPlan!.attribution.tiebroken
            : [...new Set(planStates.map((s) => s.agent_id))],
          plan,
          note: planStates.length === 0
            ? 'No agent states found (none passed explicitly, none persisted for this workspace). Call /v1/coordination/conceptual-conflicts first, or pass `states` explicitly.'
            : undefined,
        });
        return;
      }

      if (request.method === 'POST' && route === '/v1/coordination/in-flight') {
        const body = await readJsonBody<{
          workspace: string; agent_id: string; org_id?: string;
          base_commit?: string; branch?: string; diff_context: string;
          attribution_source?: InFlightAttributionSource;
          changes?: SymbolChange[];
        }>(request, maxBodyBytes);
        if (!body.workspace || !body.agent_id) {
          writeJson(response, 400, { status: 'error', error: 'workspace and agent_id are required' });
          return;
        }
        if (!(await requireCoordinationWorkspace(body.workspace))) return;

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

        const allowedAttributionSources = new Set<InFlightAttributionSource>([
          'participant-worktree',
          'participant-write-events',
          'workspace-tree',
        ]);
        const attributionSource = body.attribution_source && allowedAttributionSources.has(body.attribution_source)
          ? body.attribution_source
          : 'workspace-tree';
        const snapshot: ParticipantInFlightSnapshot = {
          workspace: body.workspace,
          agent_id: body.agent_id,
          org_id: body.org_id,
          base_commit: body.base_commit || '',
          branch: body.branch,
          diff_context: body.diff_context,
          updated_at: new Date().toISOString(),
          attribution_source: attributionSource,
          ...(redactedChanges !== undefined ? { changes: redactedChanges } : {}),
        };
        await appendParticipantInFlightSnapshot(body.workspace, snapshot);
        broadcastCoordinationEvent(body.workspace, 'in-flight', {
          agent_id: snapshot.agent_id,
          base_commit: snapshot.base_commit,
          branch: snapshot.branch,
          updated_at: snapshot.updated_at,
          attribution_source: snapshot.attribution_source,
          changes_count: redactedChanges?.length,
          changes: redactedChanges ?? [],
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

        }

        const fused = await loadPersistedRuntimeFacts(dataDir, workspace).catch(() => null);

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

        try {
          const hasUnmatched = (set.observations || []).some(
            (observation: any) => observation?.correlation?.status === 'unmatched');
          if (hasUnmatched) {
            const backfill = await backfillIngestedTelemetry(cas, workspace).catch(() => null);
            if (backfill && backfill.upgraded > 0) set = await loadObservations();
          }
        } catch {

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

  return http.createServer(instrumentHttpHandler(requestHandler)).once('close', () => workspaceAnalyses.close());
}

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
  const [log, snapshots] = await Promise.all([
    readClaimLog(workspace),
    readParticipantInFlightSnapshots(workspace, { attributableOnly: true }),
  ]);
  const active = deriveActiveClaims(log, Date.now()).filter((c) => c.workspace_id === workspace);
  const states = new Map<string, AgentInFlightState>();
  for (const claim of active) {
    if (claim.agent_id === excludeAgentId) continue;
    const marker = decodeConceptualMarkerHttp(claim.intent);
    if (!marker) continue;
    states.set(claim.agent_id, { agent_id: claim.agent_id, intent: marker.intent, changes: marker.changes });
  }
  for (const snapshot of snapshots) {
    if (snapshot.agent_id === excludeAgentId || !snapshot.changes?.length) continue;
    const existing = states.get(snapshot.agent_id);
    states.set(snapshot.agent_id, {
      agent_id: snapshot.agent_id,
      intent: existing?.intent ?? '',
      changes: snapshot.changes,
    });
  }
  return [...states.values()];
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

function accountSaltFor(clientId: string | undefined): string | undefined {
  return clientId && clientId.startsWith('user:') ? clientId : undefined;
}

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

  if (token) {
    const user = await accounts.authenticate(token);
    if (user) return { authorized: true, clientId: `user:${user.id}` };
  }
  if (!sharedToken) return { authorized: true, clientId: request.socket.remoteAddress || 'anonymous' };
  return { authorized: false, reason: token ? 'not_recognized' : 'no_token' };
}

async function canAccessCoordinationWorkspace(
  accounts: AccountStore,
  clientId: string,
  workspace: string,
): Promise<boolean> {
  if (clientId === 'shared-token') return true;
  if (!clientId.startsWith('user:')) return false;
  const userId = clientId.slice('user:'.length);
  if (workspace.startsWith('prj_')) {
    try {
      return Boolean(await accounts.getProjectForUser(userId, workspace));
    } catch {
      return false;
    }
  }
  const workspaces = await accounts.listWorkspaces(userId);
  return workspaces.some(candidate => candidate.id === workspace);
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

const PROJECT_WRITE_DENIED_MESSAGE =
  'Project not found, or your account is not a member of its workspace. Verify the project_id and that you are signed in to the account that owns it.';

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

    console.error(`[Klauro] skip analysis attach: push was not from an authenticated user (clientId=${clientId ?? 'none'})`);
    return;
  }
  const userId = clientId.slice('user:'.length);

  if (projectId && /^prj_/.test(projectId)) {
    try {
      await accounts.setProjectAnalysisId(userId, projectId, analysisId);

      await accounts.setProjectRepoFacts(projectId, repoFacts);
    } catch (error) {

      const detail = error instanceof AccountHttpError ? error.message : (error instanceof Error ? error.message : String(error));
      console.error(`[Klauro] skip analysis attach for project ${projectId} (user ${userId}): ${detail}`);
    }
    return;
  }

  if (!gitRemote) return;
  try {
    const matches = await accounts.findProjectsByRepoUrlForUser(userId, gitRemote);
    if (matches.length !== 1) {
      if (matches.length > 1) {
        console.error(`[Klauro] skip analysis attach by remote "${gitRemote}" (user ${userId}): ${matches.length} projects share this remote — ambiguous, not attaching.`);
      }
      return;
    }
    await accounts.setProjectAnalysisId(userId, matches[0].id, analysisId);
    await accounts.setProjectRepoFacts(matches[0].id, repoFacts);
  } catch (error) {
    const detail = error instanceof AccountHttpError ? error.message : (error instanceof Error ? error.message : String(error));
    console.error(`[Klauro] skip analysis attach by remote "${gitRemote}" (user ${userId}): ${detail}`);
  }
}

const casReadResponseCache = new ResponseCache(8);

const CONCEPTUAL_DEFAULT_MAX_FLOWS = 25;
const CONCEPTUAL_MAX_FLOWS_CEILING = 100;

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

export function getCasReadResponseCacheStats(): { hits: number; misses: number; size: number } {
  return casReadResponseCache.stats;
}

async function storedAnalysisVersion(workspace: string): Promise<string | null> {
  const analysisFingerprint = await getAnalysisFileFingerprint(workspace);
  if (!analysisFingerprint) return null;
  let descriptions = 'none';
  try {
    const stat = await fs.stat(descriptionStorePath(workspace));
    descriptions = `${stat.mtimeMs}:${stat.size}`;
  } catch {

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

      const body = await readJsonBody<{
        name?: string;
        repo_url?: string;
        local_path?: string;
        analysis_id?: string;
        project_id?: string;
      }>(request, maxBodyBytes);
      if (body.project_id) {
        const result = await accounts.attachProjectToWorkspace(userId, workspaceId, body.project_id);

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

      if (project.analysis_id) scheduleWorkspaceReanalyze(workspaceAnalyses, dataDir, workspaceId);
      return {
        statusCode: 201,
        body: { project },
      };
    }

  }

  const workspaceAnalysisMatch = route.match(/^\/api\/workspaces\/([^/]+)\/analysis$/);
  if (workspaceAnalysisMatch && request.method === 'GET') {
    const workspaceId = decodeURIComponent(workspaceAnalysisMatch[1]);

    await accounts.listProjects(userId, workspaceId);
    if (!workspaceAnalyses) {
      return { statusCode: 200, body: { status: 'none', workspace_id: workspaceId } };
    }
    const record = await workspaceAnalyses.load(workspaceId);
    const pending = workspaceAnalyses.isPending(workspaceId);

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

        enrichment: record.enrichment,
        analysis: record.graph,
        ...(workspaceLastAttempt ? { last_attempt: workspaceLastAttempt } : {}),
      },
    };
  }

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

  const workspaceReanalyzeMatch = route.match(/^\/api\/workspaces\/([^/]+)\/reanalyze$/);
  if (workspaceReanalyzeMatch && request.method === 'POST') {
    const workspaceId = decodeURIComponent(workspaceReanalyzeMatch[1]);

    await accounts.listProjects(userId, workspaceId);
    scheduleWorkspaceReanalyze(workspaceAnalyses, dataDir, workspaceId);
    return {
      statusCode: 202,
      body: { status: 'accepted', workspace_id: workspaceId },
    };
  }

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

    await reapAbandonedAttempt(analysisWorkspace, projectAttemptRecordPath(analysisWorkspace));
    const entry = await getAnalysisEntry(analysisWorkspace);
    const lastAttempt = await readAttemptRecord(projectAttemptRecordPath(analysisWorkspace));

    if (lastAttempt?.state === 'in-progress') {
      const structural = structuralReadinessDuringAttempt(entry, lastAttempt);
      if (structural) {

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

    await reapAbandonedAttempt(analysisWorkspace, projectAttemptRecordPath(analysisWorkspace));

    const earlyLastAttempt = await readAttemptRecord(projectAttemptRecordPath(analysisWorkspace));
    if (earlyLastAttempt?.state === 'in-progress') {

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

      const das = getCachedDeployableAnalyses(cas);
      (summary as Record<string, unknown>).sub_cas_nodes = das.sub_cas_nodes;
      const productMap = getProductMap(cas);

      const ladderLayers = cas.layers_ready?.layers || [];
      const hasPendingLayer = ladderLayers.some(layer => layer.status === 'pending');
      const erroredLayers = ladderLayers.filter(layer => layer.status === 'error');

      const structuralErrors = erroredLayers.filter(layer => layer.layer !== 'L5');
      const aiDegraded = cas.ai_enrichment === 'error'
        || (erroredLayers.some(layer => layer.layer === 'L5') && !hasPendingLayer);

      const naming = cas.enhanced_system_purpose?.capability_naming_coverage;
      const nameDegradations = cas.enhanced_system_purpose?.capability_name_degradations || [];
      const descriptionDegradations = cas.enhanced_system_purpose?.capability_description_degradations || [];

      const comprehensionAttempted = cas.ai_enrichment === 'ready'
        || cas.ai_enrichment === 'synchronous'
        || cas.ai_enrichment === 'error';

      const { comprehensionFailed, comprehensionPartial } = classifyComprehensionOutcome({
        aiDegraded,
        comprehensionAttempted,
        namingTotal: naming?.total,
        namingAuthored: naming?.authored,
        nameDegradationCount: nameDegradations.length,
        descriptionDegradationCount: descriptionDegradations.length,
      });
      const comprehensionDegraded = comprehensionFailed || comprehensionPartial;

      const isEnriched = (source: string | undefined): boolean =>
        source === 'ai' || source === 'manual' || source === 'reused';
      const unenrichedCapabilityDetails = comprehensionPartial
        ? (cas.capabilities || [])
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
      const status = structuralErrors.length > 0
        ? 'failed'
        : cas.layers_ready && !cas.layers_ready.complete && hasPendingLayer
          ? 'populating'
          : comprehensionFailed
            ? 'degraded'
            : 'ready';

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

                  degraded: comprehensionFailed,
                  partial: comprehensionPartial,
                  ...(naming ? { capability_naming_coverage: naming } : {}),
                  capability_name_degradations: nameDegradations.length,
                  capability_description_degradations: descriptionDegradations.length,

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

      const limit = limitParam !== undefined && Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(Math.floor(limitParam), 100)
        : 25;
      const offsetParamRaw = url.searchParams.get('offset');
      const offsetParam = offsetParamRaw !== null ? Number(offsetParamRaw) : undefined;
      const offset = offsetParam !== undefined && Number.isFinite(offsetParam) && offsetParam >= 0
        ? Math.floor(offsetParam)
        : 0;

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

      const version = await storedAnalysisVersion(workspace);
      const cacheKey = version === null ? null : responseCacheKey({
        endpoint: 'conceptual',
        projectId: project.id,
        analysisId: project.analysis_id,
        version,

        params: { target, include, maxFlows: String(maxFlows), offset: String(offset) },
      });
      if (cacheKey) {
        const cached = casReadResponseCache.get(cacheKey);
        if (cached !== undefined) {
          return { statusCode: 200, body: JSON.parse(cached), serializedBody: cached };
        }
      }
      const cas = await getAnalysis(workspace);

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

      const capabilities = (cas.capabilities || []).map(capability => ({
        id: capability.id,
        name: capability.name,
        ...conceptualDescriptionFields(capability),
        category: capability.category,
        criticality: capability.criticality,
        related_flows: (!target && capability.related_flows && capability.related_flows.length > 0)
          ? capability.related_flows
          : (flowEdgesByCapability.get(capability.id) || []),
      }));

      const behaviorSurfaces = (cas.behavior_surfaces || []).map(surface => ({
        id: surface.id,
        name: surface.structural_label || surface.name,
        ...conceptualDescriptionFields(surface),
        category: surface.category,
        evidence_kind: surface.evidence_kind,
        entry_points: surface.operations?.length || 0,

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

    let manifestForResponse: SourceManifest;
    let baseCommitForResponse: string | undefined;
    if (sourceRoot === workspace) {
      manifestForResponse = await buildWorkspaceManifest(workspace);
    } else {

      const snapshot = await buildSourceSnapshot(sourceRoot);
      await fs.remove(workspace);
      await fs.ensureDir(workspace);
      await writeSnapshot(workspace, snapshot.files);
      manifestForResponse = snapshot.manifest;
      baseCommitForResponse = snapshot.base_commit;
    }

    const attemptRecordPath = projectAttemptRecordPath(workspace);

    const attemptQueuedAt = new Date().toISOString();
    const attemptQueuePosition = inFlightReanalyzeCount;
    inFlightReanalyzeCount += 1;
    await writeAttemptRecord(attemptRecordPath, {
      state: 'in-progress',
      trigger: 'reanalyze',
      queued_at: attemptQueuedAt,
      queue_position: attemptQueuePosition,
    });
    setImmediate(async () => {
      const attemptStartedAt = new Date().toISOString();

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

      const stopReanalyzeHeartbeat = startAttemptHeartbeat(attemptRecordPath, reanalyzeAttemptSnapshot);

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

        const summary = await runLayeredAnalysis(workspace, {
          displayName,
          repoFacts: project.repo_facts,
          repoFactsUnavailable: !project.repo_facts,
          onPhase: (event) => {

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
          },
        });
        if (dataDirForBackground) {
          await appendProjectRevision(dataDirForBackground, {
            status: 'success',
            analysis_id: analysisId,
            analysis_revision: Date.now(),
            analysis_type: 'full',
            base_commit: baseCommitForResponse,
            manifest: manifestForResponse,
            nodes: summary.nodes,
            edges: summary.edges,
            analysis_focus: 'full',
          }, 'local_commit_submission').catch(() => {});
          await appendAuditLog(dataDirForBackground, {
            event: 'reanalyze',
            analysis_id: analysisId,
            project_id: project.id,
            nodes: summary.nodes,
            edges: summary.edges,
            mode: 'async',
          }).catch(() => {});
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

        await markBackgroundAnalysisFailed(workspace, detail);

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

async function runIncrementalAnalysisIsolated(
  workspace: string,
  displayName: string | undefined,
): Promise<{ output: Awaited<ReturnType<typeof analyzeProjectIncremental>>['output']; changeReport: RemoteAnalyzeResponse['change_report']; wasFullRebuild: boolean; fullRebuildReason?: string }> {
  const summary = await runAnalysis(workspace, { displayName });
  const output = await getAnalysis(workspace);
  return { output, changeReport: summary.changeReport, wasFullRebuild: summary.wasFullRebuild, fullRebuildReason: summary.fullRebuildReason };
}

async function handleAnalyzeDiff(dataDir: string, request: RemoteAnalyzeDiffRequest, accountSalt?: string): Promise<RemoteAnalyzeResponse> {
  const diff = request.diff_context;
  if (!diff?.files?.length) throw new Error('Remote analyze-diff requires a diff_context with changed source files');
  const rawAnalysisId = request.project_id || makeAnalysisId(request.project_path || diff.target_branch);
  const analysisId = resolveStorageAnalysisId(rawAnalysisId, accountSalt);

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

export function currentAnalyzerIdentity(): AnalyzerIdentity {
  const fingerprints = getStageFingerprints();
  return {
    analyzer_build: getBuildIdentity().version,
    parser_fingerprint: fingerprints.parser_fingerprint,
    derived_fingerprint: fingerprints.derived_fingerprint,
  };
}

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
  analysisFocus?: import('./analysis-focus').AnalysisFocus,
): boolean {
  if (!baseCommit || revision.commit !== baseCommit) return false;
  if (analysisFocus !== undefined && revision.analysis_focus !== analysisFocus) return false;
  if (revision.branch && manifest.branch && revision.branch !== manifest.branch) return false;
  if (revision.snapshot_digest && manifest.snapshot_digest) {
    return revision.snapshot_digest === manifest.snapshot_digest;
  }
  return revision.files === manifest.file_count && revision.bytes === manifest.total_bytes;
}

interface ProjectRevisionAnalysisResult {
  status?: RemoteAnalyzeResponse['status'];
  analysis_id: string;
  analysis_revision?: number;
  analysis_type?: RemoteAnalyzeResponse['analysis_type'];
  base_commit?: string;
  manifest: SourceManifest;
  cas?: CASOutput;
  nodes?: number;
  edges?: number;
  analysis_focus?: import('./analysis-focus').AnalysisFocus;
}

async function appendProjectRevision(dataDir: string, result: ProjectRevisionAnalysisResult, source: RemoteProjectRevision['source']): Promise<void> {
  const nodeCount = result.nodes ?? result.cas?.nodes.length ?? 0;
  const edgeCount = result.edges ?? result.cas?.edges.length ?? 0;
  const revision: RemoteProjectRevision = {
    analysis_id: result.analysis_id,
    analysis_revision: result.analysis_revision ?? Date.now(),
    branch: result.manifest.branch,
    commit: result.base_commit || result.manifest.base_commit,
    source,
    generated_at: new Date().toISOString(),
    files: result.manifest.file_count,
    bytes: result.manifest.total_bytes,
    snapshot_digest: result.manifest.snapshot_digest,
    nodes: nodeCount,
    edges: edgeCount,
    analysis_focus: result.analysis_focus || result.cas?.system.analysis_focus,
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

const ACTIVITY_DURATION_MATCH_WINDOW_MS = 5 * 60 * 1000;

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
    const priorRevision = revisions[index + 1];
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

    const finishedAtMs = Date.parse(lastAttempt.finished_at);
    const match = completedEvents.find(event => Math.abs(Date.parse(event.at) - finishedAtMs) < ACTIVITY_DURATION_MATCH_WINDOW_MS);
    if (match) match.duration_ms = lastAttempt.duration_ms;
  }
  return events;
}

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
    full_rebuild_reason: result.fullRebuildReason,
    base_commit: request.changes.base_commit,
    manifest,
    cas: result.output,
    change_report: result.changeReport,
  };
}
async function handleSync(dataDir: string, request: RemoteSyncRequest, requests: IdempotentSyncStore<RemoteAnalyzeResponse, CASOutput>, accountSalt?: string): Promise<{ value: RemoteAnalyzeResponse; replayed: boolean }> {
  const analysisId = resolveStorageAnalysisId(request.analysis_id, accountSalt);
  return requests.run(analysisId, request.request_id,
    () => prepareSync(dataDir, request, accountSalt).then(prepared => completeSync(prepared, request)),
    () => getAnalysis(workspacePath(dataDir, analysisId)));
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

  if (request.project_id && /^prj_/.test(request.project_id) && (await authorizeProjectWrite(accounts, clientId, request.project_id))) {
    await accounts.setProjectRepoFacts(request.project_id, result.manifest.repo_facts).catch(() => {});
  }
}

export async function stampRepoFacts(workspace: string, cas: CASOutput, manifest: SourceManifest | undefined): Promise<void> {
  if (!manifest?.repo_facts) return;
  cas.system.repo_facts = manifest.repo_facts;
  await saveAnalysis(workspace, cas);
}

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

  writeText(response, 200, 'text/plain; charset=utf-8', body);
}

async function serveTarball(response: http.ServerResponse, requested: string): Promise<void> {
  if (requested.includes('/') || requested.includes('..')) {
    writeText(response, 404, 'text/plain; charset=utf-8', 'not found');
    return;
  }

  const allowed = requested === 'klauro-latest.tgz'
    || /^klauro-[\w.\-]+\.tgz$/.test(requested)
    || /^klauro-(macos|linux|win)-(arm64|x64)(\.exe)?(\.sha256)?$/.test(requested);
  if (!allowed) {
    writeText(response, 404, 'text/plain; charset=utf-8', 'not found');
    return;
  }

  const downloadsDir = process.env.KLAURO_DOWNLOADS_DIR || '/opt/klauro/downloads';
  const filePath = path.join(downloadsDir, requested);

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

    'cache-control': 'no-cache, must-revalidate',
  }));
  if (response.req?.method === 'HEAD') return void response.end();
  const stream = fs.createReadStream(resolvedFile);
  stream.on('error', () => {
    response.destroy();
  });
  stream.pipe(response);
}

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

    max_node: maxNode,
    supported_node_range: maxNode === null ? `${minNode}+` : `${minNode}-${maxNode}`,
    published_at: (manifest.published_at as string) || null,
    binaries,
    ...flatBinaryFields,

    git_sha: (manifest.git_sha as string) || null,
    update_command: 'klauro update',

    update_command_min_version: (manifest.update_command_min_version as string) || '1.0.128',
    install_command: (manifest.install_command as string) || `curl -fsSL ${base}/install.sh | sh`,
  };
  response.writeHead(200, corsHeaders({ 'content-type': 'application/json', 'cache-control': 'no-cache' }));
  response.end(JSON.stringify(body));
}

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

export function classifyComprehensionOutcome(input: {
  aiDegraded: boolean;
  comprehensionAttempted: boolean;
  namingTotal?: number;
  namingAuthored?: number;
  nameDegradationCount: number;
  descriptionDegradationCount: number;
}): { comprehensionFailed: boolean; comprehensionPartial: boolean } {
  const comprehensionFailed = input.aiDegraded;

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

type ReanalyzeAttemptState = 'in-progress' | 'succeeded' | 'failed';

interface ReanalyzeAttemptRecord {
  state: ReanalyzeAttemptState;

  trigger: 'reanalyze' | 'sync' | 'analyze';

  analysis_revision?: number;

  queued_at?: string;

  queue_position?: number;

  started_at?: string;
  finished_at?: string;

  duration_ms?: number;
  reason?: string;

  heartbeat_at?: string;

  stored_version?: string;
  current_version?: string;
}

const ATTEMPT_HEARTBEAT_INTERVAL_MS = 20_000;
const ATTEMPT_STALE_THRESHOLD_MS = 90_000;

function startAttemptHeartbeat(filePath: string, snapshot: ReanalyzeAttemptRecord): () => void {
  const timer = setInterval(() => {
    void writeAttemptRecord(filePath, { ...snapshot, heartbeat_at: new Date().toISOString() });
  }, ATTEMPT_HEARTBEAT_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

async function reapAbandonedAttempt(workspace: string, attemptRecordPath: string): Promise<void> {
  try {
    const record = await readAttemptRecord(attemptRecordPath);
    if (!record || record.state !== 'in-progress') return;
    const heartbeatIso = record.heartbeat_at || record.started_at || record.queued_at;
    if (!heartbeatIso) return;
    const heartbeatMs = Date.parse(heartbeatIso);
    const ageMs = Number.isFinite(heartbeatMs) ? Date.now() - heartbeatMs : Infinity;
    if (ageMs < ATTEMPT_STALE_THRESHOLD_MS) return;

    const entry = await getAnalysisEntry(workspace).catch(() => null);
    const landed = Boolean(entry && (entry.layers_ready?.complete ?? true));
    const finishedAt = new Date().toISOString();
    if (landed) {

      await writeAttemptRecord(attemptRecordPath, {
        ...record,
        state: 'succeeded',
        finished_at: finishedAt,
        reason: undefined,
      });
      return;
    }
    const detail = `Analysis attempt was interrupted by a server restart (no heartbeat since ${heartbeatIso}).`;

    await markBackgroundAnalysisFailed(workspace, detail);
    await writeAttemptRecord(attemptRecordPath, {
      ...record,
      state: 'failed',
      finished_at: finishedAt,
      duration_ms: Date.parse(finishedAt) - Date.parse(record.started_at || record.queued_at || finishedAt),
      reason: detail.slice(0, 300),
    });
  } catch {

  }
}

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

let inFlightReanalyzeCount = 0;

async function writeAttemptRecord(filePath: string, record: ReanalyzeAttemptRecord): Promise<void> {
  try {
    await writeJsonAtomic(filePath, record);
  } catch {

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

function projectAttemptRecordPath(workspace: string): string {
  return path.join(workspace, '.reanalyze-attempt.json');
}

function workspaceAttemptRecordPath(dataDir: string, workspaceId: string): string {
  return path.join(dataDir, 'workspace-attempts', `${safeName(workspaceId)}.json`);
}

function scheduleWorkspaceReanalyze(
  workspaceAnalyses: AccountWorkspaceAnalysisScheduler | undefined,
  dataDir: string | undefined,
  workspaceId: string,
): void {
  if (!workspaceAnalyses) throw new AccountHttpError(500, 'Workspace analysis storage unavailable');
  if (!dataDir) throw new AccountHttpError(500, 'Analysis storage unavailable');
  const dataDirForBackground = dataDir;
  const workspaceAttemptPath = workspaceAttemptRecordPath(dataDirForBackground, workspaceId);

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

function resolveStorageAnalysisId(rawId: string, accountSalt: string | undefined): string {
  if (/^prj_/.test(rawId) || /^acct_/.test(rawId)) return rawId;
  return accountSalt ? `acct_${makeAnalysisId(accountSalt + '::' + rawId)}` : rawId;
}

const DEFAULT_MAX_ANALYSES_PER_ACCOUNT = 50;

function maxAnalysesPerAccount(): number {
  const raw = Number(process.env.KLAURO_MAX_ANALYSES_PER_ACCOUNT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_ANALYSES_PER_ACCOUNT;
}

function accountAnalysisQuotaPath(dataDir: string, userId: string): string {

  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dataDir, 'account-quota', `${safeUserId}.json`);
}

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

  }
}

function resolveDisplayName(projectName?: string, projectPath?: string): string | undefined {

  const name = (projectName || '').trim();
  if (name) return name;
  const pp = (projectPath || '').trim();
  return pp ? path.basename(pp.replace(/[/\\]+$/, '')) : undefined;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120);
}

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
  restrictProcessFileCreation();
  const port = Number(process.env.PORT || process.env.KLAURO_ANALYZER_PORT || DEFAULT_PORT);
  prewarmAnalysisWorker();
  const server = createRemoteAnalyzerHttpServer();
  server.listen(port, () => {
    process.stdout.write(`Klauro remote analyzer listening on http://0.0.0.0:${port}\n`);
  });
}
