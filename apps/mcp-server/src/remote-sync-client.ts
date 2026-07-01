import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { saveAnalysis } from './storage';
import type { RemoteAnalyzeResponse, RemoteAnalyzerResponse, RemoteProjectRevisionsResponse } from './remote-analyzer-protocol';
import { buildSourceSnapshot, buildWorkingTreeChangeContext } from './remote-source';
import { assertRemoteAnalyzerAllowed, loadKlauroConfig, resolveAnalysisId, resolveAnalyzerUrl } from './klauro-config';
import { connectorToken, requireConnectorEntitlement } from './connector-auth';
import { DEFAULT_KLAURO_CLOUD_URL } from './defaults';

export interface RemoteSyncOptions {
  projectPath: string;
  serverUrl?: string;
  token?: string;
  analysisId?: string;
}

export async function analyzeCodebaseRemotely(options: RemoteSyncOptions): Promise<RemoteAnalyzeResponse> {
  const projectPath = path.resolve(options.projectPath);
  const loaded = await loadKlauroConfig(projectPath);
  const serverUrl = resolveAnalyzerUrl(loaded, options.serverUrl);
  assertRemoteAnalyzerAllowed(loaded, serverUrl);
  await requireConnectorEntitlement({ serverUrl, token: options.token });
  const snapshot = await buildSourceSnapshot(projectPath);
  const analysisId = resolveAnalysisId(loaded, defaultAnalysisId(projectPath), options.analysisId);
  const response = await postRemote(options, '/v1/analyze', {
    project_id: analysisId,
    organization_id: loaded.config.project.organizationId,
    project_path: projectPath,
    snapshot,
  }, serverUrl);
  await saveAnalysis(projectPath, stampAnalyzedCommit(rewriteCasProjectName(response, projectPath).cas, response.base_commit));
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

async function postRemote(options: RemoteSyncOptions, endpoint: string, body: unknown, resolvedServerUrl?: string): Promise<RemoteAnalyzeResponse> {
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

  const response = await fetch(`${serverUrl}${endpoint}`, {
    method: 'POST',
    headers,
    body: requestBody,
  });
  const payload = await response.json() as RemoteAnalyzerResponse;
  if (!response.ok || payload.status === 'error') {
    throw new Error(payload.status === 'error' ? payload.error : `Remote analyzer returned ${response.status}`);
  }
  return payload as RemoteAnalyzeResponse;
}

function rewriteCasProjectName(response: RemoteAnalyzeResponse, projectPath: string): RemoteAnalyzeResponse {
  response.cas.system.name = path.basename(projectPath);
  return response;
}
