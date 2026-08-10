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
] as const;

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
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
    inputSchema: { path: z.string() },
  }, async ({ path }: any) => json(await analyzeCodebaseRemotely({ projectPath: path, requireBoundProject: true })));

  register('sync_codebase_remote', {
    description: 'Upload in-flight working-tree changes for hosted incremental analysis.',
    inputSchema: { path: z.string() },
  }, async ({ path }: any) => json(await syncWorkingTreeRemotely({ projectPath: path, requireBoundProject: true })));

  register('get_upload_manifest', {
    description: 'Preview exactly which source files would be uploaded. This reads files but performs no parsing or analysis.',
    inputSchema: { path: z.string(), dirty_tree: z.boolean().optional() },
  }, async ({ path, dirty_tree }: any) => json(await buildUploadManifest(path, dirty_tree ? 'dirty-tree' : 'full')));

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
  return server;
}
