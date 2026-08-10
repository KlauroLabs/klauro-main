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

/**
 * `klauro status` / `klauro doctor`'s "one glance, every subsystem `klauro
 * init` connects" report, and the small pieces of hosted-analysis-state
 * plumbing it needs. Lives HERE, not in cli.ts, for the same reason
 * self-update.ts does (see that file's header comment): cli.ts is the
 * developer entry point and is never bundled into the customer tarball
 * (scripts/build-bundle.mjs entryPoints only ever include installed-cli.ts).
 * `status` was ALSO missing from the shipped CLI through 1.0.129 — restoring
 * it by re-implementing it a second time inside installed-cli.ts would only
 * set up the next divergence; a module both entry points import cannot
 * silently drift apart the way two copies of the same logic did.
 */

// --- Hosted analysis state (`Analysis:` line) -------------------------------

/** 'failed' = a structural layer errored: the analysis crashed server-side.
 *  Distinct from 'populating' so a crashed run is visible, not an endless
 *  "in progress" (prod 2026-07-16: a torn deploy killed every analysis and
 *  status read 'populating' forever). */
export interface HostedAnalysisState {
  status: 'ready' | 'populating' | 'failed' | 'no_analysis';
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
  if (!response.ok) throw new Error(payload?.error || `Klauro API request failed with HTTP ${response.status}`);
  return payload as T;
}

/**
 * Hosted analysis state for `klauro status`: the SAME GET
 * /api/projects/{id}/analysis-status read `klauro init` (analyzeCodebaseRemotely)
 * and the web app's progress ladder key off. Cold-customer audit (2026-07,
 * v1.0.65): seconds after a successful hosted init+analysis, `status` said
 * "not analyzed (klauro analyze .)" because it consulted only the LOCAL
 * analysis store — a hosted-init repo has nothing there by design. Returns
 * null when unreachable/unauthorized so the caller can fall back to
 * local-store wording.
 */
export async function fetchHostedAnalysisState(serverUrl: string, token: string, projectId: string): Promise<HostedAnalysisState | null> {
  try {
    const state = await remoteJson<HostedAnalysisState>(serverUrl, token, `/api/projects/${encodeURIComponent(projectId)}/analysis-status`);
    return state && typeof state.status === 'string' ? state : null;
  } catch {
    return null;
  }
}

/**
 * The single human-readable `Analysis:` line for `klauro status`, assembled
 * from the hosted state (authoritative when the repo is bound + signed in)
 * with the local store as fallback.
 */
export function buildAnalysisStatusLine(input: {
  repoPath: string;
  hosted: HostedAnalysisState | null;
  hostedProjectId: string | null;
  local: { analyzed: boolean; analysis_complete: boolean; system?: string; analyzed_at?: string; staleness?: string };
}): string {
  const { hosted, local } = input;
  if (hosted?.status === 'populating') {
    return `Analysis: server analysis in progress (populating)${input.hostedProjectId ? ` · hosted project ${input.hostedProjectId}` : ''} — results appear shortly`;
  }
  // A crashed server-side analysis must SAY SO (and what to do), never masquerade
  // as "in progress" — zero dead ends: every error a customer can hit says the
  // next step.
  if (hosted?.status === 'failed') {
    const why = hosted.analysis_error ? ` — ${hosted.analysis_error}` : '';
    return `Analysis: server analysis FAILED${input.hostedProjectId ? ` · hosted project ${input.hostedProjectId}` : ''}${why} · retry with \`klauro analyze .\`; if it persists run \`klauro support-bundle .\``;
  }
  if (hosted?.status === 'ready') {
    const system = hosted.summary?.name || local.system || 'analyzed';
    const when = hosted.summary?.analysis_timestamp || local.analyzed_at;
    const staleness = local.analyzed ? local.staleness : undefined;
    return `Analysis: ${system} · analyzed on server · ${staleness || 'fresh'}${when ? ` · ${when}` : ''}`;
  }
  // hosted 'no_analysis', or unreachable/offline/unbound → local-store wording.
  return local.analyzed
    ? `Analysis: ${local.system || 'analyzed'} · ${local.analysis_complete ? (local.staleness || 'unknown') : 'populating (layers still filling in)'} · ${local.analyzed_at || ''}`.trim()
    : `Analysis: ${input.repoPath} not analyzed  (klauro analyze .)`;
}

// --- Connection report (`Project:`/`In-flight:`/`MCP:`/`Fabric:` lines) ----

type WorkspaceIdentityReport = ReturnType<typeof detectWorkspaceIdentity>;

export interface ConnectionReport {
  project: { initialized: boolean; config: string | null; name: string | null; id: string | null; workspace_id: string | null; kind: string | null };
  identity: WorkspaceIdentityReport;
  in_flight: { tracked: 'automatic'; dirty_files: number | null };
  mcp_registered: boolean | null;
  fabric: { enabled: boolean; mode: 'remote' | 'local'; endpoint: string | null; workspace: string; active_claims: number | null; note?: string };
}

/** Best-effort list of uncommitted (dirty + untracked) file paths; undefined = not a git repo. */
export function listDirtyFiles(projectPath: string): string[] | undefined {
  const result = spawnSync('git', ['-C', projectPath, 'status', '--porcelain', '-uall'], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
  return result.stdout
    .split('\n')
    .filter(line => line.trim())
    // porcelain: "XY path" (or "XY old -> new" for renames — keep the new path).
    .map(line => line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''));
}

/** Best-effort count of uncommitted (dirty + untracked) files; undefined = not a git repo. */
export function countDirtyFiles(projectPath: string): number | undefined {
  return listDirtyFiles(projectPath)?.length;
}

/** true = registered, false = claude present but klauro not registered, undefined = no claude CLI. */
export function detectClaudeMcpRegistration(): boolean | undefined {
  const probe = spawnSync('claude', ['mcp', 'get', 'klauro'], { encoding: 'utf8', timeout: 10000 });
  if (probe.error || probe.status === null) return undefined;
  return probe.status === 0;
}

/**
 * One-glance connection report for `klauro status` / `klauro doctor`: every
 * subsystem `klauro init` connects, for the current repo.
 */
export async function buildConnectionReport(
  repoPath: string,
  options: { fabricCliAvailable?: boolean } = {},
): Promise<ConnectionReport> {
  // `klauro fabric on|off|status` is a cli.ts-only (developer) command — it
  // is never registered in installed-cli.ts, by design (coordination-fabric
  // fine-control is a dev/fleet feature, not a customer-facing one; see
  // installed-cli-ops-commands.test.ts's SCANNED_FILES comment). This
  // function is shared by BOTH entry points (`klauro status` in each), so
  // the fabric note must not claim a command exists that only cli.ts has —
  // fabricCliAvailable defaults to true (cli.ts's own behavior, unchanged)
  // and installed-cli.ts passes false.
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

// --- `klauro status`: the full composed report ------------------------------

export interface StatusReport {
  version: string;
  channel: string;
  node: string;
  platform: string;
  server_url: string;
  signed_in: boolean;
  /**
   * Real server-verified auth state (see connector-auth.ts resolveAuthStatus)
   * — 'no-token' | 'signed-in' | 'rejected' | 'unreachable'. `signed_in` is
   * derived from this, not from local token presence, so `klauro status`
   * can never report signed_in: true for a dead/expired token the way it
   * used to (task #117: local-only check said signed_in: true right up
   * until the next real call 401'd).
   */
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

/**
 * Renders a StatusReport as the human-readable multi-line form. Needs the
 * connection/hosted-state internals too (for the Analysis:/MCP: lines), so
 * it takes the same inputs `renderStatusReport` computed rather than
 * re-deriving them. Callers should use `renderStatusReport` below, which
 * does both steps together.
 */
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

/**
 * `klauro status`, end to end: builds the report and returns BOTH the JSON
 * shape and the human-readable lines. This is the single function
 * cli.ts's runStatusCommand and installed-cli.ts's `status` handler each
 * call, so `--json` and text output can never disagree between the two
 * entry points.
 */
export async function renderStatusReport(options: { repoPath: string; serverUrl?: string; fabricCliAvailable?: boolean }): Promise<{ report: StatusReport; lines: string[] }> {
  const identity = getBuildIdentity();
  const auth = loadStoredConnectorAuth();
  const serverUrl = normalizeServerUrl(options.serverUrl || auth.defaultServerUrl || process.env.KLAURO_URL);
  const manifest = await fetchReleaseManifest(serverUrl);
  const latest = manifest?.version || null;
  const stored = auth.accounts[serverUrl];
  // Server-verified, not local-token-presence — see the StatusReport.auth_state
  // doc comment and task #117. A dead/expired/server-dropped token must never
  // render as "signed in" just because a token file happens to exist.
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
    // #142: `latest !== identity.base_version` used to fire in BOTH
    // directions — including when a stalled/partial deploy left the server
    // advertising a version BEHIND what this client is already running, in
    // which case it told a customer "Release: <older version> available —
    // run: klauro update", which would have downgraded them had they
    // followed it (self-update.ts had the identical bug — see there).
    // isNewerVersion() is the direction-aware comparator this file already
    // had available (stale-client-hint.ts) but never used here.
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
