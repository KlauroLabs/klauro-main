import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { analyzeProjectIncremental, analyzeProjectDeferred } from './analyzer';
import type { RemoteAnalyzeDiffRequest, RemoteAnalyzeRequest, RemoteAnalyzeResponse, RemoteGreenfieldPreviewRequest, RemoteProjectRevision, RemoteProjectRevisionsResponse, RemoteProposalPreviewRequest, RemoteSyncRequest } from './remote-analyzer-protocol';
import type { BranchDiffContext, RemoteFileChange, SourceManifest } from './remote-source';
import { previewCodebaseIteration, previewGreenfieldCodebase } from './proposal-preview';
import { isDirectCliInvocation } from './cli-invocation';
import { AccountHttpError, AccountStore } from './account-store';
import { arbitrate, type AgentKind, type WorkClaim } from './coordination';
import { appendClaim, getActiveClaims, getPresence, getStoreDir, readClaimLog } from './coordination/local-store';
import { appendSecurityAudit, assertSameTenant, getSecurityStoreDir, TenantMismatchError } from './coordination/security';
import { ingestAndPersist } from './telemetry-fusion';
import { getAnalysis } from './analyzer';

const DEFAULT_PORT = 8787;
const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 25_000;

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

  return http.createServer(async (request, response) => {
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

      if (route.startsWith('/api/')) {
        const apiAuthorization = await authorizeAccountApiRequest(accounts, request, token);
        if (!apiAuthorization.authorized) {
          writeJson(response, 401, { status: 'error', error: 'Sign in required' });
          return;
        }
        const accountResult = await handleAccountApi(accounts, apiAuthorization.userId, route, request, maxBodyBytes, apiAuthorization.sharedToken);
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
        const result = await handleAnalyze(dataDir, body, deferAiEnrichment);
        await appendProjectRevision(dataDir, result, 'local_commit_submission');
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
        return;
      }

      if (request.method === 'POST' && route === '/v1/analyze-diff') {
        const body = await readJsonBody<RemoteAnalyzeDiffRequest>(request, maxBodyBytes);
        const result = await handleAnalyzeDiff(dataDir, body);
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
        const result = await readProjectRevisions(dataDir, decodeURIComponent(revisionsMatch[1]));
        writeJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && route === '/v1/sync') {
        const body = await readJsonBody<RemoteSyncRequest>(request, maxBodyBytes);
        const result = await handleSync(dataDir, body);
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
        const result = await handleProposalPreview(dataDir, body);
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
      // committed pure core — this route layer only appends/reads via
      // coordination/local-store.ts and calls arbitrate()).
      if (request.method === 'POST' && route === '/v1/coordination/claim') {
        const body = await readJsonBody<{
          workspace: string; agent_id: string; intent: string; agent_kind?: AgentKind;
          paths?: string[]; symbols?: string[]; capability?: string; ttl_ms?: number;
          base_commit?: string; branch?: string; claim_id?: string;
        }>(request, maxBodyBytes);
        const now = new Date().toISOString();
        const claimId = body.claim_id || `${body.agent_id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        const newClaim: WorkClaim = {
          claim_id: claimId,
          seq: 0,
          workspace_id: body.workspace,
          agent_id: body.agent_id,
          agent_kind: body.agent_kind || 'other',
          scope: { repo: body.workspace, paths: body.paths || [], symbols: body.symbols || [], capability: body.capability },
          intent: body.intent,
          status: 'active',
          created_at: now,
          ttl_ms: body.ttl_ms || 5 * 60 * 1000,
          heartbeat_at: now,
          base_commit: body.base_commit,
          branch: body.branch,
        };
        const activeBefore = await getActiveClaims(body.workspace);
        const casEdges = await casEdgesForWorkspace(body.workspace);
        const result = arbitrate(newClaim, activeBefore, casEdges, []);
        const stored = await appendClaim(body.workspace, newClaim);
        broadcastCoordinationEvent(body.workspace, 'claim', {
          claim_id: stored.claim_id,
          seq: stored.seq,
          agent_id: stored.agent_id,
          status: stored.status,
          verdict: result.verdict,
        });
        writeJson(response, 200, {
          claim_id: stored.claim_id,
          seq: stored.seq,
          verdict: result.verdict,
          kind: result.kind,
          evidence: result.evidence,
          with_claim: result.with_claim
            ? { claim_id: result.with_claim.claim_id, agent_id: result.with_claim.agent_id, intent: result.with_claim.intent, scope: result.with_claim.scope }
            : undefined,
        });
        return;
      }

      if (request.method === 'POST' && route === '/v1/coordination/release') {
        const body = await readJsonBody<{ workspace: string; claim_id: string }>(request, maxBodyBytes);
        const log = await readClaimLog(body.workspace);
        const prior = [...log].reverse().find((entry) => entry.claim_id === body.claim_id);
        if (!prior) {
          writeJson(response, 200, { status: 'not_found', claim_id: body.claim_id });
          return;
        }
        const stored = await appendClaim(body.workspace, { ...prior, status: 'released', heartbeat_at: new Date().toISOString() });
        broadcastCoordinationEvent(body.workspace, 'release', {
          claim_id: stored.claim_id,
          seq: stored.seq,
          agent_id: stored.agent_id,
          status: stored.status,
        });
        writeJson(response, 200, { status: 'released', claim_id: stored.claim_id, seq: stored.seq });
        return;
      }

      if (request.method === 'POST' && route === '/v1/coordination/heartbeat') {
        const body = await readJsonBody<{ workspace: string; claim_id: string }>(request, maxBodyBytes);
        const log = await readClaimLog(body.workspace);
        const prior = [...log].reverse().find((entry) => entry.claim_id === body.claim_id);
        if (!prior) {
          writeJson(response, 200, { status: 'not_found', claim_id: body.claim_id });
          return;
        }
        const now = new Date().toISOString();
        const stored = await appendClaim(body.workspace, { ...prior, heartbeat_at: now });
        broadcastCoordinationEvent(body.workspace, 'heartbeat', {
          claim_id: stored.claim_id,
          seq: stored.seq,
          agent_id: stored.agent_id,
          heartbeat_at: now,
        });
        writeJson(response, 200, { status: 'heartbeat', claim_id: stored.claim_id, seq: stored.seq, heartbeat_at: now });
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
        const log = await readClaimLog(workspace);
        const claims = await getActiveClaims(workspace);
        const presence = await getPresence(workspace);
        const maxSeq = log.reduce((max, entry) => Math.max(max, entry.seq), 0);
        writeJson(response, 200, {
          workspace,
          max_seq: maxSeq,
          claims: Number.isFinite(since) ? claims.filter((c) => c.seq > (since as number)) : claims,
          presence,
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

      // §WS-B in-flight publish — persists the latest (workspace, agent_id)
      // in-flight snapshot, tenant-gated (§WS-F) and audited. Mirrors the
      // /v1/coordination/claim handler's shape: read body -> authz -> persist
      // -> audit -> respond `{status:'success'}`. Storage is a sibling
      // append-only log (`in-flight.jsonl`) alongside `claims.jsonl` in the
      // same per-workspace coordination store dir, read back reduced to
      // latest-per-(workspace,agent_id) the same way /coordination/state
      // reduces claims.jsonl to the active set.
      if (request.method === 'POST' && route === '/v1/coordination/in-flight') {
        const body = await readJsonBody<{
          workspace: string; agent_id: string; org_id?: string;
          base_commit?: string; branch?: string; diff_context: string;
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

        const snapshot: InFlightSnapshotRecord = {
          workspace: body.workspace,
          agent_id: body.agent_id,
          org_id: body.org_id,
          base_commit: body.base_commit || '',
          branch: body.branch,
          diff_context: body.diff_context,
          updated_at: new Date().toISOString(),
        };
        await appendInFlightSnapshot(body.workspace, snapshot);
        broadcastCoordinationEvent(body.workspace, 'in-flight', {
          agent_id: snapshot.agent_id,
          base_commit: snapshot.base_commit,
          branch: snapshot.branch,
          updated_at: snapshot.updated_at,
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

      writeJson(response, 404, { status: 'error', error: 'Not found' });
    } catch (error) {
      if (error instanceof AccountHttpError) {
        writeJson(response, error.statusCode, { status: 'error', error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, 500, { status: 'error', error: message });
    }
  });
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

async function authorizeAnalyzerRequest(accounts: AccountStore, request: http.IncomingMessage, sharedToken: string | undefined): Promise<{ authorized: boolean; clientId?: string }> {
  const token = bearerToken(request);
  if (!sharedToken) return { authorized: true, clientId: request.socket.remoteAddress || 'anonymous' };
  if (token && token === sharedToken) return { authorized: true, clientId: 'shared-token' };
  const user = await accounts.authenticate(token);
  return user ? { authorized: true, clientId: `user:${user.id}` } : { authorized: false };
}

async function authorizeAccountApiRequest(accounts: AccountStore, request: http.IncomingMessage, sharedToken: string | undefined): Promise<{ authorized: boolean; userId: string; sharedToken?: boolean }> {
  const token = bearerToken(request);
  if (sharedToken && token && token === sharedToken) {
    return { authorized: true, userId: 'shared-token', sharedToken: true };
  }
  const user = await accounts.authenticate(token);
  return user ? { authorized: true, userId: user.id } : { authorized: false, userId: '' };
}

async function handleAccountApi(
  accounts: AccountStore,
  userId: string,
  route: string,
  request: http.IncomingMessage,
  maxBodyBytes: number,
  sharedToken = false,
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

  const projectMatch = route.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && request.method === 'GET') {
    const project = await accounts.getProjectForUser(userId, decodeURIComponent(projectMatch[1]));
    if (!project) throw new AccountHttpError(404, 'Project not found');
    return { statusCode: 200, body: { project } };
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

async function handleProposalPreview(dataDir: string, request: RemoteProposalPreviewRequest): Promise<unknown> {
  if (!request.snapshot?.files?.length && !request.project_path) {
    throw new Error('Remote proposal preview requires a source snapshot or project_path');
  }
  const analysisId = request.project_id || makeAnalysisId(request.project_path || request.snapshot?.project_name || 'proposal');
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

async function handleAnalyze(dataDir: string, request: RemoteAnalyzeRequest, deferAiEnrichment = false): Promise<RemoteAnalyzeResponse> {
  if (!request.snapshot?.files?.length) throw new Error('Remote analyze requires a source snapshot with files');
  const analysisId = request.project_id || makeAnalysisId(request.project_path || request.snapshot.project_name);
  const workspace = workspacePath(dataDir, analysisId);

  await fs.remove(workspace);
  await fs.ensureDir(workspace);
  await writeSnapshot(workspace, request.snapshot.files);

  if (deferAiEnrichment) {
    // Progressive path: return the deterministic CAS now; the AI enrichment
    // runs in the background and upgrades the stored analysis for later fetches.
    const deferred = await analyzeProjectDeferred(workspace);
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

  const result = await analyzeProjectIncremental(workspace);
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

async function handleAnalyzeDiff(dataDir: string, request: RemoteAnalyzeDiffRequest): Promise<RemoteAnalyzeResponse> {
  const diff = request.diff_context;
  if (!diff?.files?.length) throw new Error('Remote analyze-diff requires a diff_context with changed source files');
  const analysisId = request.project_id || makeAnalysisId(request.project_path || diff.target_branch);
  // Scope the diff workspace to the target branch so it never overwrites the
  // full ('/v1/analyze') workspace for the same analysis_id.
  const workspace = workspacePath(dataDir, `${analysisId}-branch-${diff.target_branch}`);

  await fs.remove(workspace);
  await fs.ensureDir(workspace);
  await writeSnapshot(workspace, diff.files);

  const result = await analyzeProjectIncremental(workspace);
  const cas = result.output;
  cas.analyzed_track = 'other-branch';
  cas.diff_only = true;
  if (diff.head_commit) cas.base_commit = diff.head_commit;
  cas.branch = diff.target_branch;

  return {
    status: 'success',
    analysis_id: analysisId,
    analysis_revision: Date.now(),
    analysis_type: result.wasFullRebuild ? 'full' : 'incremental',
    base_commit: diff.head_commit,
    manifest: buildDiffManifest(workspace, diff),
    cas,
    change_report: result.changeReport,
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

async function handleSync(dataDir: string, request: RemoteSyncRequest): Promise<RemoteAnalyzeResponse> {
  if (!request.analysis_id) throw new Error('Remote sync requires analysis_id');
  const workspace = workspacePath(dataDir, request.analysis_id);
  if (!(await fs.pathExists(workspace))) {
    throw new Error(`No remote workspace found for analysis_id=${request.analysis_id}; run remote analyze first`);
  }

  await applyChanges(workspace, request.changes.changed_files || []);
  const result = await analyzeProjectIncremental(workspace);
  return {
    status: 'success',
    analysis_id: request.analysis_id,
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

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120);
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
