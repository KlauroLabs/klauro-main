import * as crypto from 'node:crypto';
import { constants as bufferConstants } from 'node:buffer';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { getHeapStatistics } from 'node:v8';
import { gzipSync } from 'node:zlib';
import pLimit from 'p-limit';
import { saveAnalysis } from './storage';
import type { RemoteAnalyzeAcceptedResponse, RemoteAnalyzeResponse, RemoteAnalyzerResponse, RemoteProjectRevisionsResponse } from './remote-analyzer-protocol';
import { buildBranchDiffContext, buildStreamingSourceSnapshot, buildStreamingWorkingTreeChanges, type StreamingWorkingTreePlan } from './remote-source';
import { createAnalyzeUploadRequest, createIncrementalUploadRequest, isStreamingJsonRequest } from './streaming-source-upload';
import {
  assertRemoteAnalyzerAllowed,
  isUnboundHostedProjectId,
  loadKlauroConfig,
  probeHostedProjectBinding,
  resolveAnalysisId,
  resolveAnalyzerUrl,
  type LoadedKlauroConfig,
} from './klauro-config';
import { connectorToken, findStoredAccountOwningProject, listStoredAccounts, requireConnectorEntitlement } from './connector-auth';
import { assessUploadScope } from './upload-scope-guard';
import { DEFAULT_KLAURO_CLOUD_URL } from './defaults';
import { fetch as undiciFetch } from 'undici';
import { describeHttpFailure, describeTransportFailure, getHostedArtifactDispatcher, getHostedDispatcher, getHostedUploadDispatcher, hostedFetch, isDeadConnectionError, resetHostedArtifactDispatcher, resetHostedDispatcher, resetHostedUploadDispatcher } from './hosted-transport';
import type { AnalysisFocus } from './analysis-focus';
import { decodeCasExport, decodeCasExportStream } from './cas-export-decoder';
import { CAS_SECTION_NAMES, hydrateCasSections, type CasSectionManifest, type CasSectionName } from './cas-sections';

export interface RemoteSyncOptions {
  projectPath: string;
  requestId?: string;
  serverUrl?: string;
  token?: string;
  analysisId?: string;
  analysisFocus?: AnalysisFocus;


  wait?: boolean;

  readinessRequirement?: 'complete' | 'structural';












  requireBoundProject?: boolean;








  force?: boolean;












  confirmScope?: boolean;
}

export interface RemoteElementDescriptionOptions extends RemoteSyncOptions {
  target: string;
  targetKind?: 'node' | 'service' | 'entity' | 'capability' | 'entry_point' | 'exit_point' | 'flow';
  instructions?: string;
}


export interface InFlightSyncOutcome {
  status: 'completed' | 'skipped' | 'failed';
  changed_files?: number;
  detail?: string;
}

export interface AnalyzeRemotelyResult extends Omit<RemoteAnalyzeResponse, 'status' | 'cas' | 'analysis_revision' | 'analysis_type'> {



  status: 'success' | 'accepted';
  analysis_revision?: number;
  analysis_type?: 'full' | 'incremental' | 'unchanged' | 'analyzer_upgrade' | 'forced';
  full_rebuild_reason?: string;
  reused?: boolean;



  reuse_decision?: RemoteAnalyzeAcceptedResponse['reuse_decision'];
  cas?: RemoteAnalyzeResponse['cas'];


  snapshot_source?: 'committed-head' | 'working-tree';

  in_flight?: InFlightSyncOutcome;
}


























async function assertUploadTargetIsReachable(loaded: LoadedKlauroConfig, serverUrl: string | undefined, options: RemoteSyncOptions): Promise<void> {
  if (!options.requireBoundProject) return;



  if (options.analysisId) return;
  const projectId = loaded.config.project.id;
  if (isUnboundHostedProjectId(projectId)) {
    throw new Error(
      'This repo is not connected to a hosted Klauro project (no project.id in .klaurorc — `klauro init` has never run here, or an older CLI left it unbound). ' +
      'Uploading now would be accepted and stored under an orphaned, path-hashed id that appears in no workspace — refusing instead of accepting work that would be silently dropped. ' +
      'Run `klauro init` first (from this directory: `klauro init --path .`), then retry.'
    );
  }
  if (!serverUrl) return;
  const token = connectorToken(options.token, serverUrl);
  if (!token) return;
  const probe = await probeHostedProjectBinding(serverUrl, token, String(projectId));
  if (probe === 'not_found') {








    const activeEmail = listStoredAccounts(serverUrl).find(account => account.active)?.email;
    const owner = await findStoredAccountOwningProject(serverUrl, String(projectId), activeEmail, probeHostedProjectBinding);
    if (owner) {
      throw new Error(
        `The project bound in this repo's .klaurorc (${projectId}) belongs to ${owner}, an account already signed in on this machine but not the currently active one. ` +
        `Run \`klauro accounts --use ${owner}\` to switch to it (no password needed), then retry. Do not run \`klauro login\` — that replaces the currently active account's session instead of switching to one already stored here.`
      );
    }
    throw new Error(
      `The project bound in this repo's .klaurorc (${projectId}) was not found for any account signed in on this machine. ` +
      "The server returns the same 404 whether the project truly does not exist or exists but belongs to a workspace none of those accounts is a member of — refusing to upload rather than accepting source into a destination this machine cannot reach. " +
      `Run \`klauro accounts\` to see who is signed in here (or \`klauro whoami\` for just the active one). If the account that owns ${projectId} has never signed in on this machine, ask them to add your account to its workspace, or run \`klauro init --force\` to bind a NEW project the active account can see — this starts a separate analysis, it does not touch or delete ${projectId}'s existing one. Do not run \`klauro login\` to try to "become" the owning account unless you actually intend to replace the currently active session.`
    );
  }
}












async function assertUploadScopeIsSafe(projectPath: string, options: RemoteSyncOptions): Promise<void> {
  if (!options.requireBoundProject) return;
  if (options.confirmScope) return;
  const assessment = await assessUploadScope(projectPath);
  if (!assessment.safe) throw new Error(assessment.reason);
}

export async function analyzeCodebaseRemotely(options: RemoteSyncOptions): Promise<AnalyzeRemotelyResult> {
  const projectPath = path.resolve(options.projectPath);
  const loaded = await loadKlauroConfig(projectPath);
  const serverUrl = resolveAnalyzerUrl(loaded, options.serverUrl);
  assertRemoteAnalyzerAllowed(loaded, serverUrl);
  if (!serverUrl) throw new Error('Klauro server URL is not configured');



  await assertUploadScopeIsSafe(projectPath, options);
  await requireConnectorEntitlement({ serverUrl, token: options.token });
  await assertUploadTargetIsReachable(loaded, serverUrl, options);



  const snapshot = await buildStreamingSourceSnapshot(projectPath);
  const analysisId = resolveAnalysisId(loaded, defaultAnalysisId(projectPath), options.analysisId);
  const response = await postRemote(options, '/v1/analyze', createAnalyzeUploadRequest({
    project_id: analysisId,
    organization_id: loaded.config.project.organizationId,
    project_path: projectPath,
    snapshot,
    async: true,
    analysis_focus: options.analysisFocus,
    force: options.force,
  }), serverUrl) as AnalyzeRemotelyResult;
  const incompleteCas = response.cas && (
    response.cas.layers_ready?.complete === false ||
    response.cas.ai_enrichment === 'pending'
  );
  if (options.wait && (response.status === 'accepted' || incompleteCas)) {
    if (!response.analysis_id) throw new Error('Remote analyzer accepted source without an analysis_id');
    const completed = await waitForRemoteAnalysis(
      serverUrl,
      analysisId,
      options.token,
      response.analysis_revision,
      undefined,
      undefined,
      options.readinessRequirement,
    );
    Object.assign(response, {
      status: 'success',
      cas: completed,
      analysis_revision: response.analysis_revision || Date.now(),
      analysis_type: 'full',
    });
  }
  if (response.cas) {
    await saveAnalysis(projectPath, stampAnalyzedCommit(rewriteCasProjectName(response as RemoteAnalyzeResponse, projectPath).cas, response.base_commit));
  }
  response.snapshot_source = snapshot.snapshot_source;

  if (snapshot.snapshot_source === 'committed-head' && response.status === 'accepted') {



    response.in_flight = { status: 'skipped', detail: 'captured on demand' };
  } else if (snapshot.snapshot_source === 'committed-head') {



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

export async function waitForRemoteAnalysis(
  serverUrl: string,
  analysisId: string,
  explicitToken?: string,
  expectedRevision?: number,
  completionTimeoutMs?: number,
  requestedSections?: readonly CasSectionName[],
  readinessRequirement: 'complete' | 'structural' = 'complete',
): Promise<RemoteAnalyzeResponse['cas']> {
  const token = connectorToken(explicitToken, serverUrl);
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const deadline = Date.now() + remoteCompletionTimeoutMs(completionTimeoutMs);
  let lastStatus = 'populating';
  let lastStatusTimingAt = 0;
  let segmentedManifestPendingSince: number | undefined;
  while (Date.now() < deadline) {
    let statusResponse: Response;
    try {
      statusResponse = await fetchWithTimeout(
        `${serverUrl}/v1/analyses/${encodeURIComponent(analysisId)}/status`,
        { headers },
        remoteRequestTimeoutMs(),
      );
    } catch (error) {
      lastStatus = `temporarily unreachable (${error instanceof Error ? error.message : String(error)})`;
      await sleep(100);
      continue;
    }
    const statusPayload = await statusResponse.json().catch(() => ({})) as {
      status?: string;
      analysis_revision?: number;
      error?: string;
      failed_layers?: Array<{ layer?: string; error?: string }>;
      last_attempt?: { state?: string; error?: string; reason?: string };
      summary?: {
        node_count?: number;
        edge_count?: number;
        layers_ready?: {
          complete?: boolean;
          layers?: Array<{ layer?: string; status?: string }>;
        };
      };
    };
    if (!statusResponse.ok) {
      const detail = statusPayload.error ? `: ${statusPayload.error}` : '';
      if (statusResponse.status >= 500) {
        lastStatus = `temporarily unavailable (HTTP ${statusResponse.status}${detail})`;
        await sleep(100);
        continue;
      }
      throw new Error(`Remote analysis status returned ${statusResponse.status}${detail}`);
    }
    lastStatus = statusPayload.status || lastStatus;
    if (Date.now() - lastStatusTimingAt >= 5000) {
      emitRemoteCasTiming('status', {
        status: lastStatus,
        analysis_revision: statusPayload.analysis_revision,
        expected_revision: expectedRevision,
      });
      lastStatusTimingAt = Date.now();
    }
    const comprehensionOnlyFailure = Boolean(statusPayload.failed_layers?.length)
      && statusPayload.failed_layers!.every(layer => layer.layer === 'L4' || layer.layer === 'L5');
    const structuralLayersReady = ['L0', 'L1', 'L2', 'L3'].every(requiredLayer =>
      statusPayload.summary?.layers_ready?.layers?.some(layer =>
        layer.layer === requiredLayer && layer.status === 'ready',
      ),
    );
    const terminalAttempt = statusPayload.last_attempt?.state === 'succeeded'
      || statusPayload.last_attempt?.state === 'failed';
    const structuralResultAvailable = lastStatus === 'failed'
      && readinessRequirement === 'structural'
      && terminalAttempt
      && structuralLayersReady
      && comprehensionOnlyFailure;
    if (lastStatus === 'failed'
      && readinessRequirement === 'structural'
      && statusPayload.last_attempt?.state === 'in-progress'
      && comprehensionOnlyFailure) {
      lastStatus = 'waiting for the accepted analysis transaction to finish';
      await sleep(100);
      continue;
    }
    if (lastStatus === 'failed' && !structuralResultAvailable) {
      const detail = statusPayload.failed_layers?.map(layer => `${layer.layer || 'unknown'}: ${layer.error || 'failed'}`).join(', ')
        || statusPayload.last_attempt?.error
        || statusPayload.last_attempt?.reason
        || 'unknown analysis failure';
      throw new Error(`Remote analysis ${analysisId} failed: ${detail}`);
    }
    if (lastStatus === 'ready' || structuralResultAvailable) {
      if (expectedRevision !== undefined && (!statusPayload.analysis_revision || statusPayload.analysis_revision < expectedRevision)) {
        lastStatus = `waiting for revision ${expectedRevision}`;
        await sleep(100);
        continue;
      }
      if (expectedRevision !== undefined && statusPayload.analysis_revision && statusPayload.analysis_revision > expectedRevision) {
        throw new Error(`Remote analysis ${analysisId} revision ${expectedRevision} was superseded by revision ${statusPayload.analysis_revision}`);
      }
      const segmented = await fetchSegmentedRemoteCas(
        serverUrl,
        analysisId,
        headers,
        requestedSections || CAS_SECTION_NAMES,
      );
      if (segmented) {
        if (readinessRequirement === 'complete'
          && statusPayload.summary?.layers_ready?.complete === true
          && segmented.layers_ready?.complete !== true) {
          lastStatus = 'segmented CAS is behind the completed analysis';
          await sleep(500);
          continue;
        }
        return segmented;
      }
      if (segmented === null) {
        segmentedManifestPendingSince ??= Date.now();
        const pendingForMs = Date.now() - segmentedManifestPendingSince;
        if (pendingForMs < 2_000 || !canHydrateWholeCasFallback(statusPayload.summary)) {
          lastStatus = 'segmented CAS is still populating';
          await sleep(500);
          continue;
        }
      }
      try {
        const exported = await withRemoteReadRetry(async () => {
          const exportResponse = await fetchWithTimeout(
            `${serverUrl}/v1/analyses/${encodeURIComponent(analysisId)}/cas/export`,
            { headers },
            remoteRequestTimeoutMs(),
            { artifact: true },
          );
          if (exportResponse.status === 404 || exportResponse.status === 409) return undefined;
          if (!exportResponse.ok) throw new Error(`Remote CAS export returned ${exportResponse.status}`);
          const exportedRevisionValue = exportResponse.headers.get('x-klauro-analysis-revision');
          const exportedRevision = exportedRevisionValue ? Number(exportedRevisionValue) : undefined;
          if (expectedRevision !== undefined && exportedRevision !== undefined && exportedRevision !== expectedRevision) {
            if (exportedRevision > expectedRevision) {
              throw new Error(`Remote analysis ${analysisId} revision ${expectedRevision} was superseded by revision ${exportedRevision}`);
            }
            return undefined;
          }
          const codec = exportResponse.headers.get('x-klauro-cas-codec') || 'none';
          if (exportResponse.body) {
            return decodeCasExportStream<RemoteAnalyzeResponse['cas']>(Readable.fromWeb(exportResponse.body as any), codec);
          }
          return fetchUncompressedRemoteCas(serverUrl, analysisId, headers);
        });
        if (exported) {
          if (readinessRequirement === 'complete'
            && statusPayload.summary?.layers_ready?.complete === true
            && exported.layers_ready?.complete !== true) {
            lastStatus = 'CAS export is behind the completed analysis';
            await sleep(500);
            continue;
          }
          return exported;
        }
        lastStatus = expectedRevision === undefined
          ? 'CAS export is still populating'
          : `waiting for revision ${expectedRevision} export`;
      } catch (error) {
        if (!isRetriableNetworkError(error)) throw error;
        lastStatus = `CAS export temporarily unreachable (${error instanceof Error ? error.message : String(error)})`;
      }
      await sleep(100);
      continue;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for remote analysis ${analysisId}; server status remains ${lastStatus} and analysis continues remotely`);
}

function canHydrateWholeCasFallback(summary?: { node_count?: number; edge_count?: number }): boolean {
  if (!summary || !Number.isFinite(summary.node_count) || !Number.isFinite(summary.edge_count)) return false;
  const nodeCount = Math.max(0, summary.node_count || 0);
  const edgeCount = Math.max(0, summary.edge_count || 0);
  const estimatedHydratedBytes = 64 * 1024 + nodeCount * 2_048 + edgeCount * 768;
  const configured = Number(process.env.KLAURO_WHOLE_CAS_FALLBACK_MAX_BYTES);
  const budget = Number.isFinite(configured) && configured > 0
    ? configured
    : Math.floor(getHeapStatistics().heap_size_limit / 32);
  return estimatedHydratedBytes <= budget;
}

async function fetchSegmentedRemoteCas(
  serverUrl: string,
  analysisId: string,
  headers: Record<string, string>,
  requestedSections: readonly CasSectionName[],
): Promise<RemoteAnalyzeResponse['cas'] | null | undefined> {
  const manifestStartedAt = Date.now();
  const manifestResult = await withRemoteReadRetry(async (): Promise<
    { state: 'ready'; manifest: CasSectionManifest } | { state: 'pending' } | { state: 'unavailable' }
  > => {
    const response = await fetchWithTimeout(
      `${serverUrl}/v1/analyses/${encodeURIComponent(analysisId)}/cas/manifest`,
      { headers },
      remoteRequestTimeoutMs(),
    );
    if (response.status === 404) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      return payload.error === 'Segmented analysis is not ready'
        ? { state: 'pending' }
        : { state: 'unavailable' };
    }
    if (response.status >= 500) throw new RetriableRemoteError(`Remote CAS manifest returned ${response.status}`);
    if (!response.ok) throw new Error(`Remote CAS manifest returned ${response.status}`);
    return { state: 'ready', manifest: await response.json() as CasSectionManifest };
  });
  emitRemoteCasTiming('manifest', { elapsed_ms: Date.now() - manifestStartedAt, state: manifestResult.state });
  if (manifestResult.state === 'pending') return null;
  if (manifestResult.state === 'unavailable') return undefined;
  const manifest = manifestResult.manifest;
  const available = new Set(manifest.sections.map(section => section.name));
  const requested = requestedSections.filter(section => available.has(section));
  const descriptors = new Map(manifest.sections.map(section => [section.name, section]));
  const encodedBytes = requested.reduce((sum, section) => sum + (descriptors.get(section)?.bytes || 0), 0);
  const parallelism = encodedBytes > 16 * 1024 * 1024 ? 1 : 4;
  emitRemoteCasTiming('plan', { sections: requested.length, encoded_bytes: encodedBytes, parallelism });
  const readSection = pLimit(parallelism);
  const parts = await Promise.all(requested
    .map(section => readSection(() => withRemoteReadRetry(async () => {
      const response = await fetchWithTimeout(
        `${serverUrl}/v1/analyses/${encodeURIComponent(analysisId)}/cas/sections/${section}`,
        { headers },
        remoteRequestTimeoutMs(),
        { artifact: true },
      );
      if (response.status === 404 || response.status === 409) {
        throw new RetriableRemoteError(`Remote CAS section ${section} is still populating`);
      }
      if (response.status >= 500) throw new RetriableRemoteError(`Remote CAS section ${section} returned ${response.status}`);
      if (!response.ok) throw new Error(`Remote CAS section ${section} returned ${response.status}`);
      return parseRemoteCasSection(response, section);
    }))));
  const hydrationStartedAt = Date.now();
  const cas = hydrateCasSections(parts) as RemoteAnalyzeResponse['cas'];
  emitRemoteCasTiming('hydrate', { elapsed_ms: Date.now() - hydrationStartedAt, sections: parts.length });
  return cas;
}

async function parseRemoteCasSection(
  response: Response,
  section: CasSectionName
): Promise<Partial<RemoteAnalyzeResponse['cas']>> {
  const startedAt = Date.now();
  const codec = response.headers.get('x-klauro-cas-codec') || 'none';
  const raw = Buffer.from(await response.arrayBuffer());
  const downloadedAt = Date.now();
  const decoded = decodeCasExport(raw, codec);
  if (!decoded) throw new Error(`Remote CAS section could not be decoded with ${codec}`);
  let parsed: Partial<RemoteAnalyzeResponse['cas']>;
  if (decoded.length <= bufferConstants.MAX_STRING_LENGTH) {
    parsed = JSON.parse(decoded.toString('utf8')) as Partial<RemoteAnalyzeResponse['cas']>;
  } else {
    parsed = await decodeCasExportStream<Partial<RemoteAnalyzeResponse['cas']>>(Readable.from([raw]), codec);
  }
  emitRemoteCasTiming('section', {
    section,
    codec,
    encoded_bytes: raw.length,
    decoded_bytes: decoded.length,
    download_ms: downloadedAt - startedAt,
    parse_ms: Date.now() - downloadedAt,
    elapsed_ms: Date.now() - startedAt,
  });
  return parsed;
}

function emitRemoteCasTiming(phase: string, details: Record<string, unknown>): void {
  if (process.env.KLAURO_DEBUG_REMOTE_CAS_TIMINGS !== '1') return;
  console.error(JSON.stringify({ event: 'remote_cas_timing', phase, ...details }));
}

async function fetchUncompressedRemoteCas(
  serverUrl: string,
  analysisId: string,
  headers: Record<string, string>,
): Promise<RemoteAnalyzeResponse['cas']> {
  const response = await fetchWithTimeout(
    `${serverUrl}/api/projects/${encodeURIComponent(analysisId)}/cas`,
    { headers },
    remoteRequestTimeoutMs(),
    { artifact: true },
  );
  const payload = await response.json().catch(() => ({})) as {
    status?: string;
    error?: string;
    cas?: RemoteAnalyzeResponse['cas'];
  };
  if (!response.ok || payload.status !== 'ready' || !payload.cas) {
    const detail = payload.error ? `: ${payload.error}` : '';
    throw new Error(`Remote uncompressed CAS export returned ${response.status}${detail}`);
  }
  return payload.cas;
}

function remoteCompletionTimeoutMs(explicit?: number): number {
  if (Number.isFinite(explicit) && Number(explicit) > 0) return Number(explicit);
  const override = Number(process.env.KLAURO_REMOTE_COMPLETION_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : 180_000;
}

export async function generateElementDescriptionRemotely(options: RemoteElementDescriptionOptions): Promise<Record<string, unknown>> {
  const projectPath = path.resolve(options.projectPath);
  const loaded = await loadKlauroConfig(projectPath);
  const serverUrl = resolveAnalyzerUrl(loaded, options.serverUrl);
  assertRemoteAnalyzerAllowed(loaded, serverUrl);
  await requireConnectorEntitlement({ serverUrl, token: options.token });
  const analysisId = resolveAnalysisId(loaded, defaultAnalysisId(projectPath), options.analysisId);
  return postRemote(options, '/v1/enrich-element', {
    analysis_id: analysisId,
    target: options.target,
    target_kind: options.targetKind,
    instructions: options.instructions,
  }, serverUrl) as unknown as Record<string, unknown>;
}



function stampAnalyzedCommit<T>(cas: T, baseCommit: string | undefined): T {
  if (baseCommit && cas && typeof cas === 'object' && (cas as any).base_commit == null) {
    (cas as any).base_commit = baseCommit;
  }
  return cas;
}

export function workingTreeSyncRequired(changes: Pick<StreamingWorkingTreePlan, 'changed_files' | 'manifest'>): boolean {
  return changes.changed_files.length > 0 || (changes.manifest.excluded_oversize_files?.length ?? 0) > 0;
}

export async function syncWorkingTreeRemotely(options: RemoteSyncOptions): Promise<AnalyzeRemotelyResult> {
  const projectPath = path.resolve(options.projectPath);
  const loaded = await loadKlauroConfig(projectPath);
  const serverUrl = resolveAnalyzerUrl(loaded, options.serverUrl);
  assertRemoteAnalyzerAllowed(loaded, serverUrl);
  await assertUploadScopeIsSafe(projectPath, options);
  await requireConnectorEntitlement({ serverUrl, token: options.token });
  await assertUploadTargetIsReachable(loaded, serverUrl, options);
  const changes = await buildStreamingWorkingTreeChanges(projectPath);
  const analysisId = resolveAnalysisId(loaded, defaultAnalysisId(projectPath), options.analysisId);
  if (!workingTreeSyncRequired(changes)) {
    return {
      status: 'success',
      analysis_id: analysisId,
      analysis_type: 'unchanged',
      reused: true,
      base_commit: changes.base_commit,
      manifest: changes.manifest,
      in_flight: { status: 'skipped', changed_files: 0, detail: 'Working tree matches committed HEAD; use analyze_codebase to submit the committed snapshot.' },
    };
  }
  const requestId = options.requestId || crypto.randomUUID();
  const response = await postRemote(options, '/v1/sync', createIncrementalUploadRequest({
    request_id: requestId,
    analysis_id: analysisId,
    project_id: analysisId,
    organization_id: loaded.config.project.organizationId,
    project_path: projectPath,
    changes,
    async: !options.wait,
  }), serverUrl);
  if (options.wait && (response as AnalyzeRemotelyResult).cas) {
    const completed = response as AnalyzeRemotelyResult;
    await saveAnalysis(projectPath, rewriteCasProjectName(completed as RemoteAnalyzeResponse, projectPath).cas!, 'in-flight');
  }
  return response as AnalyzeRemotelyResult;
}

export interface RemoteBranchDiffOptions extends RemoteSyncOptions {
  targetBranch: string;
  baseBranch?: string;
}






export async function analyzeBranchDiffRemotely(options: RemoteBranchDiffOptions): Promise<RemoteAnalyzeResponse> {
  const projectPath = path.resolve(options.projectPath);
  const loaded = await loadKlauroConfig(projectPath);
  const serverUrl = resolveAnalyzerUrl(loaded, options.serverUrl);
  assertRemoteAnalyzerAllowed(loaded, serverUrl);
  await requireConnectorEntitlement({ serverUrl, token: options.token });
  await assertUploadTargetIsReachable(loaded, serverUrl, options);
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
  const url = `${serverUrl}/v1/projects/${encodeURIComponent(analysisId)}/revisions`;
  const operation = 'GET revisions';


  const response = await hostedFetch(url, { headers }, { operation });
  if (!response.ok) throw new Error(await describeHttpFailure(response, { url, operation }));
  const payload = await response.json().catch(() => ({})) as RemoteProjectRevisionsResponse | { status: 'error'; error: string };
  if (payload.status === 'error') throw new Error(payload.error);
  return payload;
}

export function defaultAnalysisId(projectPath: string): string {
  return crypto.createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 24);
}







function remoteRequestTimeoutMs(): number {
  const override = Number(process.env.KLAURO_REMOTE_REQUEST_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : 120_000;
}




const REMOTE_RETRY_DELAYS_MS = [1_000, 3_000, 9_000];

async function withRemoteReadRetry<T>(read: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= REMOTE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (!isRetriableNetworkError(error) || attempt === REMOTE_RETRY_DELAYS_MS.length) throw error;
      await sleep(REMOTE_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}






class RetriableRemoteError extends Error {}













function isRetriableNetworkError(error: unknown): boolean {
  if (error instanceof RetriableRemoteError) return true;
  if (!(error instanceof Error)) return false;



  if (error.name === 'AbortError') return true;
  if (isDeadConnectionError(error)) return true;
  const cause = (error as { cause?: unknown }).cause;
  const causeCode = cause && typeof cause === 'object' ? (cause as { code?: string }).code : undefined;
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(causeCode || '')) {
    return true;
  }




  return error.message === 'fetch failed';
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  options: { artifact?: boolean } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {




    const streaming = isStreamingJsonRequestBody(init.body);
    const dispatcher = streaming
      ? getHostedUploadDispatcher()
      : options.artifact
        ? getHostedArtifactDispatcher()
        : getHostedDispatcher();
    return await undiciFetch(url, {
      ...init, signal: controller.signal, dispatcher,
      ...(streaming ? { duplex: 'half' } : {}),
    } as any) as unknown as Response;
  } catch (error) {
    if (options.artifact) resetHostedArtifactDispatcher();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isStreamingJsonRequestBody(body: BodyInit | null | undefined): boolean {
  return Boolean(body && typeof body === 'object' && typeof (body as any).pipe === 'function');
}







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
  const streaming = isStreamingJsonRequest(body);
  const payloadBytes = streaming ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const bufferedRequestBody = payloadBytes && payloadBytes.length > 1024 ? gzipSync(payloadBytes) : payloadBytes;
  if (streaming || (payloadBytes && bufferedRequestBody !== payloadBytes)) {
    headers['content-encoding'] = 'gzip';
    headers['x-klauro-wire-format'] = 'json+gzip';
    if (payloadBytes) headers['x-klauro-uncompressed-bytes'] = String(payloadBytes.length);
  } else {
    headers['x-klauro-wire-format'] = 'json';
  }

  const url = `${serverUrl}${endpoint}`;
  const maxAttempts = REMOTE_RETRY_DELAYS_MS.length + 1;
  let lastError: unknown;

  if (streaming) await body.prepare();
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const requestBody = streaming ? body.createBody() : bufferedRequestBody!;
        const response = await fetchWithTimeout(url, { method: 'POST', headers, body: requestBody } as RequestInit, timeoutMs);


      if (response.status >= 500) {
        const bodyText = await response.text().catch(() => '');
        const snippet = bodyText.slice(0, 200).replace(/\s+/g, ' ').trim();
        throw new RetriableRemoteError(
          `The Klauro server's edge returned HTTP ${response.status} for ${endpoint}` + (snippet ? `: ${snippet}` : '')
        );
      }
      const payload = await parseRemoteResponse(response, endpoint);
      if (!response.ok || payload.status === 'error') {


        throw new Error(payload.status === 'error' ? payload.error : `Remote analyzer returned ${response.status}`);
      }
        return payload as RemoteAnalyzeResponse;
      } catch (error) {
        lastError = error;
        const retriable = isRetriableNetworkError(error);
        const isLastAttempt = attempt === maxAttempts;
        if (!retriable || isLastAttempt) {
          if (retriable) {





          const timedOut = error instanceof Error && error.name === 'AbortError';
          const summary = timedOut
            ? `The Klauro server did not respond within ${Math.round(timeoutMs / 1000)}s for ${endpoint}. Target: ${url}.`
            : error instanceof RetriableRemoteError
              ? error.message
              : describeTransportFailure(error, { url, operation: `POST ${endpoint}`, attempts: maxAttempts });
            throw new Error(`${summary} (retried ${maxAttempts} times)`);
          }
          throw error;
        }



        if (streaming) resetHostedUploadDispatcher();
        else if (isDeadConnectionError(error)) resetHostedDispatcher();
        await sleep(REMOTE_RETRY_DELAYS_MS[attempt - 1]);
      }
    }
  } finally {
    if (streaming) await body.dispose();
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function rewriteCasProjectName(response: RemoteAnalyzeResponse, projectPath: string): RemoteAnalyzeResponse {
  response.cas.system.name = path.basename(projectPath);
  return response;
}
