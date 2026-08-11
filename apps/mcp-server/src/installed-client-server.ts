import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { analyzeCodebaseRemotely, syncWorkingTreeRemotely } from './remote-sync-client';
import { buildUploadManifest, isDefaultSensitiveSourceFile } from './remote-source';
import { getAgentRevisionTracks } from './agent-revision-tracks';
import { loadKlauroConfig, resolveAnalyzerUrl } from './klauro-config';
import { connectorToken } from './connector-auth';
import { describeHttpFailure, findErrorCode, hostedFetch, redactUrl, unwrapCauseChain } from './hosted-transport';
import { checkRunningBundleStaleness } from './bundle-staleness';
import { getBuildIdentity } from './installed-client-runtime';
import * as watcher from './watcher';

export const INSTALLED_TOOL_NAMES = [
  'analyze_codebase', 'sync_codebase_remote', 'get_upload_manifest', 'resolve_agent_analysis',
  'get_summary', 'get_product_map', 'get_conceptual_analysis', 'get_data_entities',
  'get_semantic_coverage', 'get_agent_start_context', 'get_agent_tool_plan', 'get_agent_context',
  'search_nodes', 'get_coding_context', 'assess_change_risk', 'find_tests', 'get_user_journeys',
  'get_codebase_idioms', 'get_behavioral_invariants', 'validate_codebase_idioms',
  'validate_behavioral_invariants', 'run_answer_pack', 'get_agent_revision_tracks', 'start_watch', 'stop_watch',
  'get_watch_status', 'list_watches', 'poll_watch_changes',
  // Coordination fabric (task #130): advisory same-machine-or-cross-machine
  // awareness claims over the hosted /v1/coordination/* API — the product's
  // stated moat, previously wired into server.ts (the hosted-only MCP
  // surface) but never reachable from this shipped client.
  'get_module_health',
  'fab_claim_work', 'fab_extend', 'fab_check_collision', 'fab_release_work', 'fab_list_active_work',
  'check_conceptual_conflicts', 'plan_intent_merge', 'plan_parallel_work',
  // Account-workspace (parent-CAS) composition: the guided customer path
  // SPECIFICATION.md §0.12 item 7 says does not exist yet — these wrap the
  // already-hosted /api/workspaces/* endpoints (auto-rebuilt server-side),
  // giving an agent an analyze_codebase-shaped flow for "I have several
  // repos" (list_workspaces -> run_workspace_analysis -> get_workspace_analysis).
  'list_workspaces', 'run_workspace_analysis', 'get_workspace_analysis',
] as const;

const symbolChangeSchema = z.object({
  symbol_id: z.string(),
  name: z.string(),
  file: z.string(),
  change_kind: z.enum(['signature', 'return_type', 'nullability', 'param', 'rename', 'split', 'move', 'delete', 'body', 'add']),
  before: z.object({
    signature: z.string().optional(), return_type: z.string().optional(), nullable: z.boolean().optional(),
    name: z.string().optional(), split_into: z.array(z.string()).optional(),
    body_tags: z.array(z.enum(['early-return', 'guard', 'appends-after', 'other'])).optional(),
  }).optional(),
  after: z.object({
    signature: z.string().optional(), return_type: z.string().optional(), nullable: z.boolean().optional(),
    name: z.string().optional(), split_into: z.array(z.string()).optional(),
    body_tags: z.array(z.enum(['early-return', 'guard', 'appends-after', 'other'])).optional(),
  }).optional(),
});

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

/** Files/exclusions listed verbatim before the rollup takes over. Enough to
 *  eyeball that the right KIND of file was picked; the counts carry the rest. */
const MANIFEST_SAMPLE_LIMIT = 25;
/** Directory rows kept, largest first — a long tail of 1-file directories tells
 *  a customer nothing the totals do not. */
const MANIFEST_DIRECTORY_LIMIT = 25;

/**
 * Bounds `get_upload_manifest` and, more usefully, answers the question a
 * customer actually asks of it.
 *
 * Measured 2026-08-11 on a real ML repo: the raw manifest serialised to
 * 4,234,202 characters / 21,737 file paths, which no agent can consume — on the
 * one tool agents are instructed to call before uploading. Worse, the answer was
 * in there and unfindable: 21,381 of those paths sat under an installed
 * `site-packages` tree. The rollup surfaces that in a single row.
 *
 * Counts and byte totals are exact; only the per-file enumeration is capped, and
 * the response says how many rows it dropped so nothing looks complete when it
 * is not.
 */
export function summarizeUploadManifest(manifest: Record<string, any>): Record<string, unknown> {
  const files: Array<{ path?: string; bytes?: number }> = Array.isArray(manifest.files) ? manifest.files : [];
  const excluded: Array<{ path?: string; reason?: string }> = Array.isArray(manifest.excluded) ? manifest.excluded : [];

  const byDirectory = new Map<string, { files: number; bytes: number }>();
  for (const file of files) {
    // Group by the top TWO segments: one segment buries everything under `src`,
    // while the full path is what made this unreadable in the first place.
    const segments = String(file.path || '').split('/');
    const key = segments.length > 1 ? segments.slice(0, 2).join('/') : (segments[0] || '.');
    const row = byDirectory.get(key) || { files: 0, bytes: 0 };
    row.files += 1;
    row.bytes += Number(file.bytes) || 0;
    byDirectory.set(key, row);
  }
  const directories = [...byDirectory.entries()]
    .map(([directory, row]) => ({ directory, files: row.files, bytes: row.bytes }))
    .sort((a, b) => b.files - a.files || a.directory.localeCompare(b.directory));

  const exclusionReasons = new Map<string, number>();
  for (const entry of excluded) {
    const reason = String(entry.reason || 'unknown');
    exclusionReasons.set(reason, (exclusionReasons.get(reason) || 0) + 1);
  }

  const { files: _files, excluded: _excluded, ...rest } = manifest;
  return {
    ...rest,
    file_count: files.length,
    total_bytes: files.reduce((sum, file) => sum + (Number(file.bytes) || 0), 0),
    excluded_count: excluded.length,
    excluded_by_reason: Object.fromEntries([...exclusionReasons.entries()].sort((a, b) => b[1] - a[1])),
    largest_directories: directories.slice(0, MANIFEST_DIRECTORY_LIMIT),
    directories_omitted: Math.max(0, directories.length - MANIFEST_DIRECTORY_LIMIT),
    files_sample: files.slice(0, MANIFEST_SAMPLE_LIMIT).map(file => file.path),
    files_omitted_from_sample: Math.max(0, files.length - MANIFEST_SAMPLE_LIMIT),
    note: 'Counts and byte totals are exact. Per-file rows are sampled — use largest_directories to see where the bulk sits, and .klauroignore to exclude what you do not want uploaded.',
  };
}

/**
 * Every hosted read tool routes through hostedProjectGet, and every hosted
 * query tool through hostedProjectQuery. That makes these two functions the
 * product's entire failure surface for agents: whatever they throw is what an
 * agent sees for ALL hosted tools at once. Both therefore go through
 * hosted-transport.ts, which retries transport faults and reports the
 * unwrapped cause, the target URL, and a remediation — never a bare
 * `fetch failed` or a bare status number, neither of which gives an agent a
 * next step.
 */
async function hostedProjectGet(projectPath: string, suffix: string, params: Record<string, unknown> = {}) {
  const loaded = await loadKlauroConfig(projectPath);
  const serverUrl = resolveAnalyzerUrl(loaded)!.replace(/\/+$/, '');
  const projectId = loaded.config.project.id;
  if (!projectId) throw new Error(`No hosted Klauro project is bound to ${projectPath}. Run \`klauro init ${projectPath}\` first.`);
  const url = new URL(`${serverUrl}/api/projects/${encodeURIComponent(projectId)}${suffix}`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
  const token = connectorToken(undefined, serverUrl);
  const operation = `GET ${suffix.replace(/^\//, '') || 'analysis'}`;
  const response = await hostedFetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} }, { operation });
  if (!response.ok) throw new Error(await describeHttpFailure(response, { url: url.toString(), operation }));
  const payload = await readHostedJson(response, { url: url.toString(), operation });
  if ((payload as any)?.status === 'error') {
    throw new Error(`Klauro's hosted server reported an error for ${operation}. Target: ${redactUrl(url.toString())}. Detail: ${(payload as any).error || 'no detail provided'}.`);
  }
  return payload;
}

async function hostedProjectQuery(projectPath: string, tool: string, args: Record<string, unknown> = {}) {
  const loaded = await loadKlauroConfig(projectPath);
  const serverUrl = resolveAnalyzerUrl(loaded)!.replace(/\/+$/, '');
  const projectId = loaded.config.project.id;
  if (!projectId) throw new Error(`No hosted Klauro project is bound to ${projectPath}. Run \`klauro init ${projectPath}\` first.`);
  const token = connectorToken(undefined, serverUrl);
  const url = `${serverUrl}/api/projects/${encodeURIComponent(projectId)}/query`;
  const operation = `query ${tool}`;
  const response = await hostedFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ tool, args }),
  }, { operation });
  if (!response.ok) throw new Error(await describeHttpFailure(response, { url, operation }));
  const payload = await readHostedJson(response, { url, operation }) as any;
  if (payload?.status === 'error') {
    throw new Error(`Klauro's hosted server reported an error for ${operation}. Target: ${redactUrl(url)}. Detail: ${payload.error || 'no detail provided'}.`);
  }
  return payload.result;
}

/**
 * Coordination-fabric and account-workspace calls are not scoped to one
 * bound project's analysis (unlike hostedProjectGet/Query above) — they hit
 * the hosted server's own `/v1/coordination/*` and `/api/workspaces/*`
 * surfaces directly, using the same server URL + Bearer token resolution as
 * every other hosted call in this file. `path` is only used to resolve which
 * hosted server/credential to talk to (via .klaurorc); it is never uploaded
 * or analyzed.
 */
async function hostedServerAndToken(projectPath: string): Promise<{ serverUrl: string; token: string | undefined; projectId: string | undefined }> {
  const loaded = await loadKlauroConfig(projectPath);
  const serverUrl = resolveAnalyzerUrl(loaded)!.replace(/\/+$/, '');
  const token = connectorToken(undefined, serverUrl);
  return { serverUrl, token, projectId: loaded.config.project.id };
}

async function hostedCoordinationCall(projectPath: string, route: string, body: Record<string, unknown>) {
  const { serverUrl, token } = await hostedServerAndToken(projectPath);
  const url = `${serverUrl}${route}`;
  const operation = `POST ${route}`;
  const response = await hostedFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }, { operation });
  if (!response.ok) throw new Error(await describeHttpFailure(response, { url, operation }));
  return readHostedJson(response, { url, operation });
}

async function hostedCoordinationGet(projectPath: string, route: string, params: Record<string, unknown> = {}) {
  const { serverUrl, token } = await hostedServerAndToken(projectPath);
  const url = new URL(`${serverUrl}${route}`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
  const operation = `GET ${route}`;
  const response = await hostedFetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} }, { operation });
  if (!response.ok) throw new Error(await describeHttpFailure(response, { url: url.toString(), operation }));
  return readHostedJson(response, { url: url.toString(), operation });
}

/** Default coordination workspace id: an explicit `workspace` argument wins;
 *  otherwise the bound hosted project id (stable across machines for the
 *  same repo) so agents on the same project land in the same room without
 *  having to agree on a string out of band. */
async function resolveCoordinationWorkspace(projectPath: string, explicitWorkspace: string | undefined): Promise<string> {
  if (explicitWorkspace && explicitWorkspace.trim()) return explicitWorkspace.trim();
  const { projectId } = await hostedServerAndToken(projectPath);
  return projectId || path.basename(projectPath);
}

/** Parse a 2xx hosted body. A truncated or non-JSON 2xx body (an edge that
 *  answered instead of the server, or a connection cut mid-stream) must not
 *  surface as a parser error with no indication of where it came from. */
async function readHostedJson(response: Response, context: { url: string; operation: string }): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    const snippet = text.slice(0, 300).replace(/\s+/g, ' ').trim();
    throw new Error(
      `Klauro's hosted server returned an unreadable body for ${context.operation} (HTTP ${response.status}, ` +
      `content-type "${response.headers.get('content-type') || 'none'}", ${text.length} bytes). ` +
      `Target: ${redactUrl(context.url)}. Parse error: ${error instanceof Error ? error.message : String(error)}. ` +
      `Body starts: ${snippet || '(empty)'}. Retry; if it persists, run \`klauro doctor\`.`
    );
  }
}

const MAX_VALIDATION_DIFF_BYTES = 2_000_000;

export function collectExplicitWorkingChanges(projectPath: string): { files: string[]; diff_text: string } {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: projectPath, encoding: 'utf8' }).trim();
  let base = 'HEAD';
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, stdio: 'ignore' });
  } catch {
    base = execFileSync('git', ['hash-object', '-t', 'tree', '/dev/null'], { cwd: root, encoding: 'utf8' }).trim();
  }
  const trackedDiff = execFileSync('git', ['diff', '--no-ext-diff', '--binary', base, '--'], {
    cwd: root, encoding: 'utf8', maxBuffer: MAX_VALIDATION_DIFF_BYTES * 2,
  });
  const changed = execFileSync('git', ['diff', '--name-only', base, '--'], { cwd: root, encoding: 'utf8' })
    .split('\n').map(value => value.trim()).filter(value => Boolean(value) && !isDefaultSensitiveSourceFile(value));
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\n').map(value => value.trim()).filter(value => Boolean(value) && !isDefaultSensitiveSourceFile(value));
  let diffText = filterSensitiveDiffSections(trackedDiff);
  for (const file of untracked) {
    if (Buffer.byteLength(diffText) >= MAX_VALIDATION_DIFF_BYTES) break;
    const absolute = path.join(root, file);
    let content: string;
    try {
      content = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\0')) continue;
    const body = content.split('\n').map(line => `+${line}`).join('\n');
    diffText += `\ndiff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${content.split('\n').length} @@\n${body}\n`;
  }
  if (Buffer.byteLength(diffText) > MAX_VALIDATION_DIFF_BYTES) {
    throw new Error(`Working diff exceeds ${MAX_VALIDATION_DIFF_BYTES} bytes; validate a smaller change set before finalizing.`);
  }
  const files = [...new Set([...changed, ...untracked])].sort();
  if (files.length > 5000) throw new Error(`Working change set contains ${files.length} files; validate a smaller change set before finalizing.`);
  return { files, diff_text: diffText };
}

function filterSensitiveDiffSections(diffText: string): string {
  return diffText
    .split(/(?=^diff --git )/m)
    .filter(section => {
      const match = section.match(/^diff --git a\/(.+) b\/(.+)$/m);
      return !match || !isDefaultSensitiveSourceFile(match[2]);
    })
    .join('');
}

const taskSchema = z.object({
  task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
  target: z.string().optional(), related_paths: z.array(z.string()).optional(),
  runtime_event: z.record(z.unknown()).optional(), instructions: z.string().optional(),
  success_criteria: z.array(z.string()).optional(),
  response_profile: z.enum(['standard', 'minimal', 'first-turn', 'capsule-only']).optional(),
  runtime: z.enum(['auto', 'include', 'exclude']).optional(), exclude_sections: z.array(z.string()).optional(),
});

/** Messages that name no cause and imply no next step. An agent that receives
 *  one of these is stuck: it cannot tell a misconfiguration from an outage
 *  from a credential problem, and has nothing to act on. */
const OPAQUE_ERROR_MESSAGES = new Set(['fetch failed', 'failed to fetch', 'network error', 'terminated', 'other side closed', '']);

export function isOpaqueErrorMessage(message: string): boolean {
  return OPAQUE_ERROR_MESSAGES.has(message.trim().toLowerCase());
}

/**
 * Last line of defence on the tool surface.
 *
 * The per-callsite work in hosted-transport.ts covers the paths this file
 * owns, but a tool handler can reach code that raises its own bare transport
 * rejection. Rather than trust every present and future callsite, every
 * handler is wrapped: any error whose message names no cause is re-reported
 * with the tool name, the unwrapped `cause` chain, and a remediation before it
 * leaves the process. The invariant this enforces is that no opaque message
 * can reach an agent, whatever a callsite forgets.
 */
export function withTransparentErrors<T extends (...args: any[]) => any>(registerFn: T): T {
  return ((name: string, config: unknown, handler: (...args: any[]) => any) =>
    registerFn(name, config, async (...args: any[]) => {
      try {
        return await handler(...args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isOpaqueErrorMessage(message)) throw error;
        const chain = unwrapCauseChain(error);
        const code = findErrorCode(error);
        throw new Error(
          `Klauro's \`${name}\` tool failed with a transport error that carried no message of its own. ` +
          `Underlying error: ${chain.join(' <- ') || message || 'none reported'}${code ? ` (${code})` : ''}. ` +
          'This is a client-side connectivity or configuration failure, not a missing analysis. ' +
          'Run `klauro doctor` to check the configured server URL, network reachability, and credentials, then retry.'
        );
      }
    })) as unknown as T;
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'klauro', version: getBuildIdentity().version }, {
    instructions: 'Klauro installed client. Upload source and diffs for hosted analysis, query hosted slices, and watch in-flight changes. No analysis, CAS construction at any level, graph construction, proposal materialization, or embeddings execute on this machine.',
  });
  const register = withTransparentErrors(server.registerTool.bind(server) as any);

  register('analyze_codebase', {
    description: 'Upload a filtered source snapshot for hosted Klauro analysis. No analyzer executes locally.',
    inputSchema: {
      path: z.string(),
      // task #132: mirrors `klauro analyze --force` — bypasses BOTH the
      // server's snapshot/analyzer-identity reuse gate and the AI response
      // cache, so a caller asking for a fresh analysis actually gets one
      // (including regenerated AI names/descriptions), not a silent replay
      // of a prior result.
      force: z.boolean().optional().describe('Bypass the server\'s snapshot-reuse gate AND the AI response cache, forcing a genuinely fresh analysis even if the last uploaded snapshot is unchanged.'),
      // task #134: `path` resolving to a folder that structurally looks like
      // several unrelated projects (no Git repo/manifest of its own, multiple
      // nested repos beneath it) refuses with an explanatory error unless
      // this is explicitly set — there is no terminal here to prompt on, so
      // this call fails loudly instead. Set it only after you've confirmed
      // `path` is really the folder you intend to upload wholesale.
      confirm_scope: z.boolean().optional().describe('Confirms uploading `path` even though it looks like a container of several unrelated projects rather than one project. Omit/false refuses that upload with an explanatory error instead of silently proceeding.'),
    },
  }, async ({ path, force, confirm_scope }: any) => json(await analyzeCodebaseRemotely({ projectPath: path, requireBoundProject: true, force: Boolean(force), confirmScope: Boolean(confirm_scope) })));

  register('sync_codebase_remote', {
    description: 'Upload in-flight working-tree changes for hosted incremental analysis.',
    inputSchema: {
      path: z.string(),
      confirm_scope: z.boolean().optional().describe('Confirms uploading `path` even though it looks like a container of several unrelated projects rather than one project. Omit/false refuses that upload with an explanatory error instead of silently proceeding.'),
    },
  }, async ({ path, confirm_scope }: any) => json(await syncWorkingTreeRemotely({ projectPath: path, requireBoundProject: true, confirmScope: Boolean(confirm_scope) })));

  register('get_upload_manifest', {
    description: 'Preview which source files would be uploaded, as counts plus a per-directory breakdown and a sample. Reads files but performs no parsing or analysis.',
    inputSchema: { path: z.string(), dirty_tree: z.boolean().optional() },
    // Measured 2026-08-11 on a real ML repo: this returned 4,234,202 characters —
    // 21,737 individual file paths — because it serialised the raw manifest. Every
    // other tool on this surface is budgeted; this one handed a customer's coding
    // agent a 4MB payload that blows its context, on the tool agents are told to
    // call BEFORE uploading. A preview nobody can read is not a preview.
    //
    // The per-directory rollup is also what a customer actually needs: on that
    // same repo it says "21,381 files under a site-packages tree" in one line,
    // which is the answer to "why is my upload enormous?" that 21,737 paths bury.
  }, async ({ path, dirty_tree }: any) => json(summarizeUploadManifest(await buildUploadManifest(path, dirty_tree ? 'dirty-tree' : 'full'))));

  register('resolve_agent_analysis', {
    description: 'Resolve the bound hosted project and return its analysis readiness and compact hosted summary.',
    inputSchema: { path: z.string() },
    // Agents call this first to orient, so it is the one place a stale client
    // build reaches the consumer that would otherwise act on stale behaviour
    // without ever seeing the stderr warning emitted at startup.
  }, async ({ path }: any) => {
    const status = await hostedProjectGet(path, '/analysis-status') as Record<string, unknown>;
    let staleness: { note: string | null } = { note: null };
    try { staleness = checkRunningBundleStaleness(__dirname); } catch { /* never fail a read on the guard */ }
    return json(staleness.note ? { ...status, client_build_warning: staleness.note } : status);
  });

  register('get_summary', {
    description: 'Retrieve the compact hosted analysis summary. The client does not download or construct CAS.',
    inputSchema: { path: z.string() },
  }, async ({ path }: any) => json(await hostedProjectGet(path, '/analysis')));

  register('get_product_map', {
    description: 'Retrieve a hosted product-map slice.',
    inputSchema: { path: z.string() },
  }, async ({ path }: any) => {
    const analysis = await hostedProjectGet(path, '/analysis') as any;
    return json({ status: analysis.status, project_id: analysis.project_id, analysis_id: analysis.analysis_id, product_map: analysis.product_map });
  });

  register('get_conceptual_analysis', {
    description: 'Retrieve hosted capability, flow, and step comprehension without downloading CAS.',
    inputSchema: { path: z.string(), max_flows: z.number().optional() },
  }, async ({ path, max_flows }: any) => json(await hostedProjectGet(path, '/conceptual', { max_flows })));

  register('get_data_entities', {
    description: 'Retrieve a paginated hosted domain-entity slice without downloading CAS.',
    inputSchema: { path: z.string(), entity_name: z.string().optional(), role: z.string().optional(), limit: z.number().optional(), offset: z.number().optional() },
  }, async ({ path, ...params }: any) => json(await hostedProjectGet(path, '/entities', params)));

  register('get_semantic_coverage', {
    description: 'Retrieve hosted semantic coverage and confidence.',
    inputSchema: { path: z.string() },
  }, async ({ path }: any) => json(await hostedProjectGet(path, '/semantic-coverage')));

  register('get_agent_start_context', {
    description: 'Retrieve compact hosted orientation before broad source exploration.',
    inputSchema: { path: z.string(), task: taskSchema.optional() },
  }, async ({ path, task }: any) => json(await hostedProjectQuery(path, 'get_agent_start_context', { task })));

  register('get_agent_tool_plan', {
    description: 'Retrieve the hosted CAS-backed query sequence for the task.',
    inputSchema: { path: z.string(), task: taskSchema.optional() },
  }, async ({ path, task }: any) => json(await hostedProjectQuery(path, 'get_agent_tool_plan', { task })));

  register('get_agent_context', {
    description: 'Retrieve task-scoped hosted graph context, risks, tests, invariants, and first files to inspect.',
    inputSchema: { path: z.string(), task: taskSchema.optional() },
  }, async ({ path, task }: any) => json(await hostedProjectQuery(path, 'get_agent_context', { task })));

  register('search_nodes', {
    description: 'Search hosted CAS nodes by name and meaning.',
    inputSchema: { path: z.string(), query: z.string(), type: z.string().optional(), file: z.string().optional(), limit: z.number().optional(), offset: z.number().optional() },
  }, async ({ path, ...args }: any) => json(await hostedProjectQuery(path, 'search_nodes', args)));

  register('get_coding_context', {
    description: 'Retrieve hosted target details, conventions, boundaries, connected code, and relevant tests before editing.',
    inputSchema: {
      path: z.string(), target: z.string(), task_type: z.enum(['add', 'modify', 'delete', 'refactor']).optional(),
      include: z.array(z.string()).optional(), caller_limit: z.number().optional(), callee_limit: z.number().optional(),
    },
  }, async ({ path, ...args }: any) => json(await hostedProjectQuery(path, 'get_coding_context', args)));

  register('assess_change_risk', {
    description: 'Assess hosted CAS blast radius and test protection for a node.',
    inputSchema: { path: z.string(), node_id: z.string() },
  }, async ({ path, ...args }: any) => json(await hostedProjectQuery(path, 'assess_change_risk', args)));

  register('find_tests', {
    description: 'Find hosted test suites and cases covering a node or file.',
    inputSchema: { path: z.string(), node_id: z.string().optional(), file_path: z.string().optional(), limit: z.number().optional(), offset: z.number().optional() },
  }, async ({ path, ...args }: any) => json(await hostedProjectQuery(path, 'find_tests', args)));

  register('get_user_journeys', {
    description: 'Retrieve hosted source-to-terminal user journeys and their concrete steps.',
    inputSchema: {
      path: z.string(), journey_id: z.string().optional(), kind: z.string().optional(), limit: z.number().optional(), offset: z.number().optional(),
      format: z.enum(['json', 'markdown']).optional(), include_steps: z.boolean().optional(),
    },
  }, async ({ path, ...args }: any) => json(await hostedProjectQuery(path, 'get_user_journeys', args)));

  register('get_codebase_idioms', {
    description: 'Retrieve hosted repo-local conventions and evidence before editing.',
    inputSchema: {
      path: z.string(), category: z.enum(['naming', 'file-organization', 'module-boundary', 'dependency-injection', 'data-access', 'error-handling', 'validation', 'auth-tenant-scope', 'logging', 'testing', 'migrations', 'async-style', 'configuration']).optional(),
      target: z.string().optional(), min_confidence: z.number().optional(), limit: z.number().optional(), offset: z.number().optional(),
    },
  }, async ({ path, ...args }: any) => json(await hostedProjectQuery(path, 'get_codebase_idioms', args)));

  register('get_behavioral_invariants', {
    description: 'Retrieve hosted auth, tenant, data, migration, test, and business invariants before editing.',
    inputSchema: {
      path: z.string(), invariant_type: z.enum(['tenant-scope', 'auth-boundary', 'authorization', 'db-constraint', 'migration-contract', 'test-coverage', 'data-lifecycle', 'business-rule']).optional(),
      target: z.string().optional(), limit: z.number().optional(), offset: z.number().optional(),
    },
  }, async ({ path, ...args }: any) => json(await hostedProjectQuery(path, 'get_behavioral_invariants', args)));

  register('validate_codebase_idioms', {
    description: 'Validate the local working diff against hosted repo-local conventions. Source analysis remains hosted.',
    inputSchema: {
      path: z.string(), target: z.string().optional(), category: z.enum(['naming', 'file-organization', 'module-boundary', 'dependency-injection', 'data-access', 'error-handling', 'validation', 'auth-tenant-scope', 'logging', 'testing', 'migrations', 'async-style', 'configuration']).optional(),
      min_confidence: z.number().optional(), limit: z.number().optional(),
    },
  }, async ({ path: projectPath, ...args }: any) => json(await hostedProjectQuery(projectPath, 'validate_codebase_idioms', {
    ...args, ...collectExplicitWorkingChanges(projectPath),
  })));

  register('validate_behavioral_invariants', {
    description: 'Validate the local working diff against hosted behavioral invariants. Source analysis remains hosted.',
    inputSchema: {
      path: z.string(), target: z.string().optional(), invariant_type: z.enum(['tenant-scope', 'auth-boundary', 'authorization', 'db-constraint', 'migration-contract', 'test-coverage', 'data-lifecycle', 'business-rule']).optional(), limit: z.number().optional(),
    },
  }, async ({ path: projectPath, ...args }: any) => json(await hostedProjectQuery(projectPath, 'validate_behavioral_invariants', {
    ...args, ...collectExplicitWorkingChanges(projectPath),
  })));

  register('run_answer_pack', {
    description: 'Answer the core codebase-understanding questions from the hosted CAS.',
    inputSchema: { path: z.string(), pack: z.literal('mastery').optional() },
  }, async ({ path, ...args }: any) => json(await hostedProjectQuery(path, 'run_answer_pack', args)));

  register('get_agent_revision_tracks', {
    description: 'Retrieve committed, incoming, and in-flight revision tracks from Klauro.',
    inputSchema: { path: z.string() },
  }, async ({ path }: any) => json(await getAgentRevisionTracks({ projectPath: path })));

  register('start_watch', { description: 'Watch IDE-style file events and upload coalesced changes for hosted analysis.', inputSchema: { path: z.string() } }, async ({ path }: any) => json(watcher.startWatch(path)));
  register('stop_watch', { description: 'Stop a Klauro in-flight watch.', inputSchema: { watch_id: z.string() } }, async ({ watch_id }: any) => json(watcher.stopWatch(watch_id)));
  register('get_watch_status', { description: 'Get one in-flight watch status.', inputSchema: { watch_id: z.string() } }, async ({ watch_id }: any) => json(watcher.getWatchStatus(watch_id)));
  register('list_watches', { description: 'List in-flight watches.', inputSchema: {} }, async () => json(watcher.listWatches()));
  register('poll_watch_changes', { description: 'Poll coalesced file changes accepted for hosted analysis.', inputSchema: { watch_id: z.string(), since: z.string().optional() } }, async ({ watch_id, since }: any) => json(watcher.pollWatchChanges(watch_id, since)));

  register('get_module_health', {
    description: 'Which parts of this system are dangerous to touch, and why. Every finding is a file that is a statistical OUTLIER within this codebase\'s OWN file-size/90-day-churn/cross-file-fan-in/capability-anchor-count distribution (median + MAD modified z-score), never a fixed cutoff. is_healthy is true only when zero findings. available is false when the analysis has fewer than 10 resolvable-source files.',
    inputSchema: {
      path: z.string(), kind: z.enum(['size-outlier', 'change-concentration', 'fan-in-hotspot', 'mixed-concerns', 'danger-composite']).optional(),
      severity: z.enum(['info', 'warning', 'error']).optional(), limit: z.number().optional(), offset: z.number().optional(),
    },
  }, async ({ path, ...args }: any) => json(await hostedProjectQuery(path, 'get_module_health', args)));

  // -- Coordination fabric (advisory, over the hosted /v1/coordination/* API) --
  // Same product surface as server.ts's fab_* tools; thin HTTP calls only, no
  // local claim store or CAS blast-radius expansion runs on this machine —
  // that enrichment already lives server-side behind these same routes.

  register('fab_claim_work', {
    description: 'ADVISORY awareness claim (CLI-parity for `fab.ts claim`) — announces intent to peers over the hosted coordination fabric, never blocks or queues, takes no lease. The claim always succeeds; overlap with another agent\'s active claim comes back as `conflicts`/`warning` inline. Call fab_release_work when done.',
    inputSchema: {
      path: z.string(), agent_id: z.string().describe('Stable identifier for the calling agent/session'),
      intent: z.string().describe('Short description of the work being claimed'),
      paths: z.array(z.string()).optional().describe('File/dir paths this work will touch'),
      symbols: z.array(z.string()).optional().describe('Symbol/node ids this work will touch'),
      workspace: z.string().optional().describe('Coordination workspace id. Defaults to the bound hosted project id.'),
      agent_kind: z.enum(['claude', 'cursor', 'codex', 'human', 'other']).optional(),
      ttl_ms: z.number().optional().describe('Claim TTL in ms (default 30 min, WAN-appropriate)'),
    },
  }, async ({ path: projectPath, agent_id, intent, paths, symbols, workspace, agent_kind, ttl_ms }: any) => {
    const ws = await resolveCoordinationWorkspace(projectPath, workspace);
    const result: any = await hostedCoordinationCall(projectPath, '/v1/coordination/claim', {
      mode: 'advisory', workspace: ws, agent_id, intent, paths: paths || [], symbols: symbols || [],
      agent_kind: agent_kind || 'claude', ttl_ms,
    });
    return json({ ...result, workspace: ws });
  });

  register('fab_extend', {
    description: 'Extend an ACTIVE advisory claim mid-task ("I also need to touch X") without losing claim identity — reads the claim\'s current active scope back from the fabric, unions in the added paths/symbols, and re-claims under the same claim_id. This is also how a path-less exploration claim localizes.',
    inputSchema: {
      path: z.string(), agent_id: z.string().describe('Agent whose active advisory claim to extend'),
      add_paths: z.array(z.string()).optional(), add_symbols: z.array(z.string()).optional(),
      workspace: z.string().optional().describe('Coordination workspace id. Defaults to the bound hosted project id.'),
    },
  }, async ({ path: projectPath, agent_id, add_paths, add_symbols, workspace }: any) => {
    const ws = await resolveCoordinationWorkspace(projectPath, workspace);
    const active: any = await hostedCoordinationGet(projectPath, '/v1/coordination/active', { workspace: ws });
    const mine = (active?.active || []).find((c: any) => c.agent_id === agent_id);
    const paths = [...new Set([...(mine?.paths || []), ...(add_paths || [])])];
    const symbols = [...new Set([...(mine?.symbols || []), ...(add_symbols || [])])];
    const result: any = await hostedCoordinationCall(projectPath, '/v1/coordination/claim', {
      mode: 'advisory', workspace: ws, agent_id, intent: mine?.intent || '',
      claim_id: mine?.claim_id, paths, symbols, agent_kind: mine?.agent_kind || 'claude',
    });
    return json({ ...result, workspace: ws, paths, symbols, note: mine ? undefined : 'No prior active claim found for this agent_id — extended from an empty scope; call fab_claim_work first for an intent-carrying claim.' });
  });

  register('fab_check_collision', {
    description: 'ADVISORY read-only preflight (pairs with fab_claim_work) — do the proposed paths overlap any OTHER active agent\'s claim on the hosted coordination fabric? Takes no claim. Awareness-only, never a gate.',
    inputSchema: {
      path: z.string(), agent_id: z.string().describe('Your agent_id (excluded from the overlap scan)'),
      paths: z.array(z.string()).describe('Proposed file/dir paths to check for overlap'),
      workspace: z.string().optional().describe('Coordination workspace id. Defaults to the bound hosted project id.'),
    },
  }, async ({ path: projectPath, agent_id, paths, workspace }: any) => {
    const ws = await resolveCoordinationWorkspace(projectPath, workspace);
    const result = await hostedCoordinationCall(projectPath, '/v1/coordination/check', { workspace: ws, agent_id, paths });
    return json({ ...(result as any), workspace: ws });
  });

  register('fab_release_work', {
    description: 'ADVISORY release (counterpart to fab_claim_work) — clears every advisory claim this agent holds on the hosted coordination fabric so peers see the scope free again. Call the moment you are done or handing off.',
    inputSchema: {
      path: z.string(), agent_id: z.string().describe('Agent id whose claims to release'),
      workspace: z.string().optional().describe('Coordination workspace id. Defaults to the bound hosted project id.'),
    },
  }, async ({ path: projectPath, agent_id, workspace }: any) => {
    const ws = await resolveCoordinationWorkspace(projectPath, workspace);
    const result = await hostedCoordinationCall(projectPath, '/v1/coordination/release', { workspace: ws, agent_id });
    return json({ ...(result as any), workspace: ws });
  });

  register('fab_list_active_work', {
    description: 'List every active advisory claim on the hosted coordination fabric for a workspace: each agent\'s intent and claimed paths/symbols. Call before starting work to see who else is here and what they are touching.',
    inputSchema: {
      path: z.string(), workspace: z.string().optional().describe('Coordination workspace id. Defaults to the bound hosted project id.'),
    },
  }, async ({ path: projectPath, workspace }: any) => {
    const ws = await resolveCoordinationWorkspace(projectPath, workspace);
    const result = await hostedCoordinationGet(projectPath, '/v1/coordination/active', { workspace: ws });
    return json({ ...(result as any), workspace: ws });
  });

  register('check_conceptual_conflicts', {
    description: 'Detects semantic incoherence textual/merge conflicts CANNOT — two changes that each compile and merge cleanly but are JOINTLY incoherent (e.g. one agent retyping a function\'s return type while another edits a caller that assumes the old contract). Persists your reported `changes` (SymbolChange[]) to the hosted fabric so OTHER agents\' next check can detect conflicts with you, and returns the conflicts that involve YOU. Unlike server.ts\'s ambient git-diff capture, this client reports only what you pass explicitly in `changes` — call it whenever your edit changes a symbol\'s CONTRACT or STRUCTURE.',
    inputSchema: {
      path: z.string(), agent_id: z.string().describe('Your stable agent/session id'),
      agent_kind: z.enum(['claude', 'cursor', 'codex', 'human', 'other']).optional(),
      intent: z.string().describe('Short description of the work you are about to do'),
      changes: z.array(symbolChangeSchema).describe('The symbol changes you are about to make (or are making), with before/after shape where known'),
      workspace: z.string().optional().describe('Coordination workspace id. Defaults to the bound hosted project id.'),
    },
  }, async ({ path: projectPath, agent_id, agent_kind, intent, changes, workspace }: any) => {
    const ws = await resolveCoordinationWorkspace(projectPath, workspace);
    const result = await hostedCoordinationCall(projectPath, '/v1/coordination/conceptual-conflicts', {
      workspace: ws, agent_id, agent_kind: agent_kind || 'claude', intent, changes: changes || [],
    });
    return json({ ...(result as any), workspace: ws });
  });

  register('plan_intent_merge', {
    description: 'When agents finish overlapping work, reconcile by INTENT rather than by textual 3-way diff — the higher-level question of whether the changes COHERE. Returns a MergePlan: auto_mergeable, needs_resolution, duplicate_work. Uses every OTHER active agent\'s persisted conceptual-conflict state for `workspace` (from check_conceptual_conflicts) unless you pass `states` explicitly.',
    inputSchema: {
      path: z.string(), agent_id: z.string().describe('Your stable agent/session id (excluded from the persisted-state lookup)'),
      states: z.array(z.object({ agent_id: z.string(), intent: z.string(), changes: z.array(symbolChangeSchema) })).optional()
        .describe('Explicit agent states to plan a merge over. Omit to use every other agent\'s persisted conceptual-conflict state.'),
      workspace: z.string().optional().describe('Coordination workspace id. Defaults to the bound hosted project id.'),
    },
  }, async ({ path: projectPath, agent_id, states, workspace }: any) => {
    const ws = await resolveCoordinationWorkspace(projectPath, workspace);
    const result = await hostedCoordinationCall(projectPath, '/v1/coordination/intent-merge', { workspace: ws, agent_id, states });
    return json({ ...(result as any), workspace: ws });
  });

  register('plan_parallel_work', {
    description: 'Given a pending task list, compute the maximally-parallel non-conflicting batching up front — run BEFORE any agent starts, so a fleet can be routed to avoid most collisions rather than merely surviving them. Pass each task\'s declared target_symbols/target_paths when known; pass `path` so the hosted CAS-backed heuristic can match real identifiers/file mentions in free-text `intent`, and so declared footprints get expanded one hop of call-graph blast radius before conflicts are computed.',
    inputSchema: {
      path: z.string().describe('Project path — resolves the hosted server and, when include_blast_radius is on, the CAS used for blast-radius expansion.'),
      tasks: z.array(z.object({
        id: z.string(), intent: z.string(),
        target_symbols: z.array(z.string()).optional(), target_paths: z.array(z.string()).optional(),
        flow_id: z.string().optional(), capability_id: z.string().optional(),
      })).describe('Pending tasks to partition into maximally-parallel non-conflicting batches'),
      include_blast_radius: z.boolean().optional().describe('Expand each task footprint by one hop of CAS call-graph edges. Default true.'),
    },
  }, async ({ path: projectPath, tasks, include_blast_radius }: any) => {
    const { projectId } = await hostedServerAndToken(projectPath);
    const result = await hostedCoordinationCall(projectPath, '/v1/coordination/plan-parallel-work', {
      tasks, path: projectId || projectPath, include_blast_radius,
    });
    return json(result);
  });

  // -- Account-workspace (parent-CAS) composition --
  // Wraps the already-hosted /api/workspaces/* endpoints (auto-rebuilt
  // server-side on member-project analysis landing). This is the reachable
  // customer path SPECIFICATION.md §0.12 item 7 says is missing: an
  // analyze_codebase-shaped flow for composing several analyzed repos into
  // one queryable parent analysis.

  register('list_workspaces', {
    description: 'List the hosted account workspaces (groups of analyzed projects) visible to the signed-in Klauro account, each with its member project count. Use to find a workspace_id for run_workspace_analysis/get_workspace_analysis.',
    inputSchema: { path: z.string().describe('Any bound project path, used only to resolve the hosted server and credentials.') },
  }, async ({ path: projectPath }: any) => json(await hostedCoordinationGet(projectPath, '/api/workspaces')));

  register('run_workspace_analysis', {
    description: 'Trigger a hosted rebuild of the parent CAS for an account workspace (a workspace-level CAS composing its member repos\' CAS analyses: projects, deployables, interfaces, runtime topology, cross-repo links, workspace capabilities, entities, health, risk, AI narrative). Accepted 202 and runs in the background — poll get_workspace_analysis for status:\'ready\'. This is the multi-repo analog of analyze_codebase.',
    inputSchema: { path: z.string().describe('Any bound project path, used only to resolve the hosted server and credentials.'), workspace_id: z.string().describe('Hosted account workspace id (from list_workspaces).') },
  }, async ({ path: projectPath, workspace_id }: any) => json(await hostedCoordinationCall(projectPath, `/api/workspaces/${encodeURIComponent(workspace_id)}/reanalyze`, {})));

  register('get_workspace_analysis', {
    description: 'Load the persisted parent CAS for a hosted account workspace: status (none/pending/ready), member projects, AI-required narrative, and the full workspace-level CAS graph. Call run_workspace_analysis first if status is \'none\'.',
    inputSchema: { path: z.string().describe('Any bound project path, used only to resolve the hosted server and credentials.'), workspace_id: z.string().describe('Hosted account workspace id (from list_workspaces).') },
  }, async ({ path: projectPath, workspace_id }: any) => json(await hostedCoordinationGet(projectPath, `/api/workspaces/${encodeURIComponent(workspace_id)}/analysis`)));

  return server;
}
