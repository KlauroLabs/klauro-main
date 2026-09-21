import { spawnSync } from 'node:child_process';
import { getBuildIdentity } from '../../../packages/analyzer-core/src/analyzer/core/build-identity';
import { loadKlauroConfig } from './klauro-config';
import { connectorToken, isNetworkUnreachableError, loadStoredConnectorAuth, normalizeServerUrl, resolveAuthStatus, unreachableServerError } from './connector-auth';
import { detectWorkspaceIdentity, resolveFabricSettings } from './coordination/fabric-config';
import { remoteActive } from './coordination/remote-transport';
import { getActiveClaims } from './coordination/local-store';
import { fetchReleaseManifest } from './self-update';
import { isNewerVersion } from './stale-client-hint';
import { getAnalysisEntry } from './storage';
import { summarizeAnalysisFreshness } from './freshness';
import { listActiveSessions } from './session-lock';






























export interface HostedAnalysisState {
  status: 'ready' | 'queryable' | 'populating' | 'degraded' | 'failed' | 'no_analysis' | 'inaccessible';
  project_id?: string;
  analysis_id?: string;
  analysis_error?: string;
  summary?: { name?: string | null; analysis_timestamp?: string | null };
}

export async function remoteJson<T>(serverUrl: string, token: string, route: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${serverUrl}${route}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (isNetworkUnreachableError(error)) throw unreachableServerError(serverUrl, error);
    throw error;
  }
  const payload = await response.json().catch(() => ({})) as any;
  if (response.status === 401) throw new Error(payload?.error || `Klauro authentication failed (HTTP 401) at ${serverUrl}. Run \`klauro login\` to sign in again.`);
  if (!response.ok) {
    const error = new Error(payload?.error || `Klauro API request failed with HTTP ${response.status}`) as Error & { httpStatus?: number };
    error.httpStatus = response.status;
    throw error;
  }
  return payload as T;
}











export async function fetchHostedAnalysisState(serverUrl: string, token: string, projectId: string): Promise<HostedAnalysisState | null> {
  try {
    const state = await remoteJson<HostedAnalysisState>(serverUrl, token, `/api/projects/${encodeURIComponent(projectId)}/analysis-status`);
    return state && typeof state.status === 'string' ? state : null;
  } catch (error) {
    if ((error as Error & { httpStatus?: number })?.httpStatus === 404) {
      return {
        status: 'inaccessible',
        project_id: projectId,
        analysis_error: 'The bound project does not exist or belongs to a workspace this account cannot access.',
      };
    }
    return null;
  }
}






export function buildAnalysisStatusLine(input: {
  repoPath: string;
  hosted: HostedAnalysisState | null;
  hostedProjectId: string | null;
  local: { analyzed: boolean; analysis_complete: boolean; system?: string; analyzed_at?: string; staleness?: string };
}): string {
  const { hosted, local } = input;
  if (hosted?.status === 'inaccessible') {
    return `Analysis: hosted project ${input.hostedProjectId || hosted.project_id || 'unknown'} is inaccessible — it does not exist or belongs to another workspace. Sign in with a workspace member account, ask an owner to add this account, or run \`klauro init --force\` only if you intend to bind a separate new project.`;
  }
  if (hosted?.status === 'populating') {
    return `Analysis: server analysis in progress (populating)${input.hostedProjectId ? ` · hosted project ${input.hostedProjectId}` : ''} — results appear shortly`;
  }







  if (hosted?.status === 'queryable') {
    const system = hosted.summary?.name || local.system || 'analyzed';
    return `Analysis: ${system} · structure ready on server, interpretation still running · queryable now`;
  }



  if (hosted?.status === 'failed') {
    const why = hosted.analysis_error ? ` — ${hosted.analysis_error}` : '';
    return `Analysis: server analysis FAILED${input.hostedProjectId ? ` · hosted project ${input.hostedProjectId}` : ''}${why} · retry with \`klauro analyze .\`; if it persists run \`klauro support-bundle .\``;
  }





  if (hosted?.status === 'degraded') {
    const system = hosted.summary?.name || local.system || 'analyzed';
    const when = hosted.summary?.analysis_timestamp || local.analyzed_at;
    return `Analysis: ${system} · structure ready, AI comprehension DEGRADED${hosted.analysis_error ? ` — ${hosted.analysis_error}` : ''}${when ? ` · ${when}` : ''} · retry with \`klauro analyze . --force\` to regenerate comprehension`;
  }
  if (hosted?.status === 'ready') {
    const system = hosted.summary?.name || local.system || 'analyzed';
    const when = hosted.summary?.analysis_timestamp || local.analyzed_at;
    const staleness = local.analyzed ? local.staleness : undefined;
    return `Analysis: ${system} · analyzed on server · ${staleness || 'fresh'}${when ? ` · ${when}` : ''}`;
  }

  return local.analyzed
    ? `Analysis: ${local.system || 'analyzed'} · ${local.analysis_complete ? (local.staleness || 'unknown') : 'populating (layers still filling in)'} · ${local.analyzed_at || ''}`.trim()
    : `Analysis: ${input.repoPath} not analyzed  (klauro analyze .)`;
}



type WorkspaceIdentityReport = ReturnType<typeof detectWorkspaceIdentity>;

export interface ConnectionReport {
  project: { initialized: boolean; config: string | null; name: string | null; id: string | null; workspace_id: string | null; kind: string | null };
  identity: WorkspaceIdentityReport;
  in_flight: { tracked: 'automatic'; dirty_files: number | null };
  mcp_registered: boolean | null;
  fabric: { enabled: boolean; mode: 'remote' | 'local'; endpoint: string | null; workspace: string; active_claims: number | null; note?: string };
}


export function listDirtyFiles(projectPath: string): string[] | undefined {
  const result = spawnSync('git', ['-C', projectPath, 'status', '--porcelain', '-uall'], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
  return result.stdout
    .split('\n')
    .filter(line => line.trim())

    .map(line => line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''));
}


export function countDirtyFiles(projectPath: string): number | undefined {
  return listDirtyFiles(projectPath)?.length;
}


export function detectClaudeMcpRegistration(): boolean | undefined {
  const probe = spawnSync('claude', ['mcp', 'get', 'klauro'], { encoding: 'utf8', timeout: 10000 });
  if (probe.error || probe.status === null) return undefined;
  return probe.status === 0;
}





export async function buildConnectionReport(
  repoPath: string,
  options: { fabricCliAvailable?: boolean } = {},
): Promise<ConnectionReport> {








  const fabricCliAvailable = options.fabricCliAvailable ?? true;
  const loaded = await loadKlauroConfig(repoPath).catch(() => undefined);
  const initialized = Boolean(loaded?.configPath);
  const identity = detectWorkspaceIdentity(repoPath, loaded?.config.project.id);
  const settings = await resolveFabricSettings({ cwd: repoPath });
  let activeClaims: number | null = null;
  let fabricNote: string | undefined;
  if (settings.remote) {
    try {
      activeClaims = (await remoteActive(settings.remote, settings.workspace)).count;
    } catch (error) {
      fabricNote = `remote fabric unreachable (${error instanceof Error ? error.message : String(error)})`;
    }
  } else {
    activeClaims = (await getActiveClaims(settings.workspace).catch(() => [])).length;
    fabricNote = settings.fabric && settings.fabric.enabled === false
      ? (fabricCliAvailable ? 'disabled by `klauro fabric off`' : 'disabled (fabric off in .klaurorc)')
      : 'local fabric (same-machine peers only)';
  }
  const dirty = countDirtyFiles(repoPath);
  return {
    project: {
      initialized,
      config: loaded?.configPath ?? null,
      name: loaded?.config.project.name ?? null,
      id: loaded?.config.project.id ?? null,
      workspace_id: loaded?.config.project.workspaceId ?? null,
      kind: loaded?.config.kind ?? null,
    },
    identity,
    in_flight: { tracked: 'automatic', dirty_files: dirty ?? null },
    mcp_registered: detectClaudeMcpRegistration() ?? null,
    fabric: {
      enabled: Boolean(settings.remote),
      mode: settings.remote ? 'remote' : 'local',
      endpoint: settings.remote?.baseUrl ?? null,
      workspace: settings.workspace,
      active_claims: activeClaims,
      note: fabricNote,
    },
  };
}

export function formatConnectionReportLines(report: ConnectionReport): string[] {
  return [
    report.project.initialized
      ? `Project:  ${report.project.name || 'unnamed'}${report.project.id ? ` (hosted project ${report.project.id})` : ''} · identity ${report.identity.workspace} (${report.identity.source}) · ${report.project.config}`
      : `Project:  not connected  (run: klauro init)`,
    `In-flight: automatic${report.in_flight.dirty_files === null ? '' : ` · ${report.in_flight.dirty_files} uncommitted file(s)`}`,
    report.mcp_registered === null
      ? 'MCP:      unknown (claude CLI not found) — klauro install wires agent access'
      : report.mcp_registered
        ? 'MCP:      klauro registered with Claude Code'
        : 'MCP:      not registered  (run: klauro install)',
    report.fabric.mode === 'remote'
      ? `Fabric:   remote via ${report.fabric.endpoint} · workspace ${report.fabric.workspace} · ${report.fabric.active_claims === null ? (report.fabric.note || 'claims unavailable') : `${report.fabric.active_claims} active claim(s)`}`
      : `Fabric:   local · workspace ${report.fabric.workspace}${report.fabric.note ? ` · ${report.fabric.note}` : ''}${report.project.initialized ? '' : '  (klauro init connects it)'}`,
  ];
}

export { connectorToken };



export interface StatusReport {
  version: string;
  channel: string;
  node: string;
  platform: string;
  server_url: string;
  signed_in: boolean;








  auth_state: string;
  auth_detail: string;
  email: string | null;
  latest_available: string | null;
  update_available: boolean;
  repo: string;
  repo_analyzed: boolean;
  repo_analysis_complete: boolean;
  repo_layers_ready: unknown;
  repo_system: string | null;
  repo_analyzed_at: string | null;
  repo_staleness: string | null;
  server_analysis_status: string | null;
  server_analysis_id: string | null;
  server_analysis_system: string | null;
  server_analysis_timestamp: string | null;
  project: ConnectionReport['project'];
  workspace_identity: ConnectionReport['identity'];
  in_flight: ConnectionReport['in_flight'];
  mcp_registered: ConnectionReport['mcp_registered'];
  fabric: ConnectionReport['fabric'];
  running_mcp_sessions: number;
  running_mcp_sessions_on_old_build: number;
}








function formatStatusLines(
  report: StatusReport,
  connection: ConnectionReport,
  hosted: HostedAnalysisState | null,
  boundProjectId: string | null,
): string[] {
  const sessionsOnOldBuild = report.running_mcp_sessions_on_old_build;
  const mcpRegistration = report.mcp_registered === null
    ? 'registration unknown (claude CLI not found)'
    : report.mcp_registered
      ? 'klauro registered with Claude Code'
      : 'not registered  (run: klauro install)';
  const mcpSessions = sessionsOnOldBuild > 0
    ? `${sessionsOnOldBuild} running session(s) on an OLDER build — restart your MCP client`
    : report.running_mcp_sessions > 0
      ? `${report.running_mcp_sessions} running session(s), all on the current build`
      : 'no running sessions detected on this machine';
  return [
    `klauro ${report.version} (${report.channel}) · node ${report.node} · ${report.platform}`,
    report.auth_state === 'signed-in'
      ? `Account:  signed in to ${report.server_url}${report.email ? ` as ${report.email}` : ''}`
      : report.auth_state === 'rejected'
        ? `Account:  session rejected by ${report.server_url}${report.email ? ` for ${report.email}` : ''} — the stored token was not accepted (expired, or dropped server-side). Run: klauro login`
        : report.auth_state === 'unreachable'
          ? `Account:  could not verify with ${report.server_url} (server unreachable)${report.email ? ` — local token present for ${report.email}` : ''}`
          : `Account:  not signed in to ${report.server_url}  (klauro login --email you@example.com --register)`,
    report.latest_available
      ? (report.update_available ? `Release:  ${report.latest_available} available — run: klauro update` : `Release:  up to date (${report.latest_available})`)
      : `Release:  could not reach ${report.server_url}`,
    ...formatConnectionReportLines(connection).filter(line => !line.startsWith('MCP:')),
    buildAnalysisStatusLine({
      repoPath: report.repo,
      hosted,
      hostedProjectId: boundProjectId,
      local: {
        analyzed: report.repo_analyzed,
        analysis_complete: report.repo_analysis_complete,
        system: report.repo_system ?? undefined,
        analyzed_at: report.repo_analyzed_at ?? undefined,
        staleness: report.repo_staleness ?? undefined,
      },
    }),
    `MCP:      ${mcpRegistration} · ${mcpSessions}`,
  ];
}








export async function renderStatusReport(options: { repoPath: string; serverUrl?: string; fabricCliAvailable?: boolean }): Promise<{ report: StatusReport; lines: string[] }> {
  const identity = getBuildIdentity();
  const auth = loadStoredConnectorAuth();
  const serverUrl = normalizeServerUrl(options.serverUrl || auth.defaultServerUrl || process.env.KLAURO_URL);
  const manifest = await fetchReleaseManifest(serverUrl);
  const latest = manifest?.version || null;
  const stored = auth.accounts[serverUrl];



  const authStatus = await resolveAuthStatus({ serverUrl });

  const repoPath = options.repoPath;
  let repo: { analyzed: boolean; analysis_complete: boolean; system?: string; analyzed_at?: string; staleness?: string; layers_ready?: unknown } = { analyzed: false, analysis_complete: false };
  try {
    const entry = await getAnalysisEntry(repoPath);
    if (!entry) throw new Error('No stored analysis metadata');
    const freshness = summarizeAnalysisFreshness(repoPath, entry.analyzed_at);
    const layersReady = entry.layers_ready;
    repo = {
      analyzed: true,
      analysis_complete: !layersReady || (layersReady as { complete?: boolean }).complete !== false,
      system: entry.name,
      analyzed_at: entry.analyzed_at,
      staleness: freshness?.staleness,
      ...(layersReady ? { layers_ready: layersReady } : {}),
    };
  } catch {
    repo = { analyzed: false, analysis_complete: false };
  }

  const connection = await buildConnectionReport(repoPath, { fabricCliAvailable: options.fabricCliAvailable });
  const token = connectorToken(undefined, serverUrl);
  const boundProjectId = connection.project.id && /^prj_/.test(connection.project.id) ? connection.project.id : null;
  const hosted = token && boundProjectId ? await fetchHostedAnalysisState(serverUrl, token, boundProjectId) : null;

  const activeSessions = listActiveSessions();
  const sessionsOnOldBuild = activeSessions.filter(s => s.version !== identity.version);

  const report: StatusReport = {
    version: identity.version,
    channel: identity.channel,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    server_url: serverUrl,
    signed_in: authStatus.state === 'signed-in',
    auth_state: authStatus.state,
    auth_detail: authStatus.detail,
    email: authStatus.email ?? stored?.email ?? null,
    latest_available: latest,








    update_available: Boolean(latest && isNewerVersion(latest, identity.base_version)),
    repo: repoPath,
    repo_analyzed: repo.analyzed,
    repo_analysis_complete: repo.analysis_complete,
    repo_layers_ready: repo.layers_ready ?? null,
    repo_system: repo.system ?? null,
    repo_analyzed_at: repo.analyzed_at ?? null,
    repo_staleness: repo.staleness ?? null,
    server_analysis_status: hosted?.status ?? null,
    server_analysis_id: hosted?.analysis_id ?? null,
    server_analysis_system: hosted?.summary?.name ?? null,
    server_analysis_timestamp: hosted?.summary?.analysis_timestamp ?? null,
    project: connection.project,
    workspace_identity: connection.identity,
    in_flight: connection.in_flight,
    mcp_registered: connection.mcp_registered,
    fabric: connection.fabric,
    running_mcp_sessions: activeSessions.length,
    running_mcp_sessions_on_old_build: sessionsOnOldBuild.length,
  };

  return { report, lines: formatStatusLines(report, connection, hosted, boundProjectId) };
}
