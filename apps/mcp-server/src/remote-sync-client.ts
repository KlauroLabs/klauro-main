import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { saveAnalysis } from './storage';
import type { RemoteAnalyzeResponse, RemoteAnalyzerResponse } from './remote-analyzer-protocol';
import { buildSourceSnapshot, buildWorkingTreeChangePacket } from './remote-source';
import { assertRemoteAnalyzerAllowed, loadKlauroConfig, resolveAnalysisId, resolveAnalyzerUrl } from './klauro-config';

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
  const snapshot = await buildSourceSnapshot(projectPath);
  const analysisId = resolveAnalysisId(loaded, defaultAnalysisId(projectPath), options.analysisId);
  const response = await postRemote(options, '/v1/analyze', {
    project_id: analysisId,
    organization_id: loaded.config.project.organizationId,
    project_path: projectPath,
    snapshot,
  }, serverUrl);
  await saveAnalysis(projectPath, rewriteCasProjectName(response, projectPath).cas);
  return response;
}

export async function syncWorkingTreeRemotely(options: RemoteSyncOptions): Promise<RemoteAnalyzeResponse> {
  const projectPath = path.resolve(options.projectPath);
  const loaded = await loadKlauroConfig(projectPath);
  const serverUrl = resolveAnalyzerUrl(loaded, options.serverUrl);
  assertRemoteAnalyzerAllowed(loaded, serverUrl);
  const changes = await buildWorkingTreeChangePacket(projectPath);
  const analysisId = resolveAnalysisId(loaded, defaultAnalysisId(projectPath), options.analysisId);
  const response = await postRemote(options, '/v1/sync', {
    analysis_id: analysisId,
    project_id: analysisId,
    organization_id: loaded.config.project.organizationId,
    project_path: projectPath,
    changes,
  }, serverUrl);
  await saveAnalysis(projectPath, rewriteCasProjectName(response, projectPath).cas);
  return response;
}

export function defaultAnalysisId(projectPath: string): string {
  return crypto.createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 24);
}

async function postRemote(options: RemoteSyncOptions, endpoint: string, body: unknown, resolvedServerUrl?: string): Promise<RemoteAnalyzeResponse> {
  const serverUrl = (resolvedServerUrl || options.serverUrl || process.env.KLAURO_ANALYZER_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = options.token || process.env.KLAURO_ANALYZER_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${serverUrl}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json() as RemoteAnalyzerResponse;
  if (!response.ok || payload.status === 'error') {
    throw new Error(payload.status === 'error' ? payload.error : `Remote analyzer returned ${response.status}`);
  }
  return payload;
}

function rewriteCasProjectName(response: RemoteAnalyzeResponse, projectPath: string): RemoteAnalyzeResponse {
  response.cas.system.name = path.basename(projectPath);
  return response;
}
