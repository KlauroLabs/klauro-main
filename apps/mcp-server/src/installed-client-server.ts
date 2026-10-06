import { localizeHostedWorkspacePath } from './hosted-path-localization';
import { overlayLocalFreshness } from './hosted-freshness-overlay';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { FIND_TESTS_INPUT_SCHEMA } from './test-query-schema';
import { analyzeCodebaseRemotely, syncWorkingTreeRemotely } from './remote-sync-client';
import { buildUploadManifest, isDefaultSensitiveSourceFile } from './remote-source';
import { getAgentRevisionTracks } from './agent-revision-tracks';
import { loadKlauroConfig, resolveAnalyzerUrl } from './klauro-config';
import { connectorToken } from './connector-auth';
import { describeHttpFailure, findErrorCode, hostedFetch, redactUrl, unwrapCauseChain } from './hosted-transport';
import { checkRunningBundleStaleness } from './bundle-staleness';
import { getBuildIdentity } from './installed-client-runtime';
import * as watcher from './watcher';
import { summarizeUploadManifest } from './upload-manifest-summary';
import { boundToolPayload } from './response-budget';
import { isInstalledToolName } from './installed-tool-registry';
import { INSTALLED_CLIENT_INSTRUCTIONS } from './installed-client-instructions';
import { executeDurableRemoteOperation, type RemoteOperationKind } from './coordination/durable-remote-operations';
export { summarizeUploadManifest } from './upload-manifest-summary';
export { INSTALLED_TOOL_NAMES } from './installed-tool-registry';

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








const MAX_TOOL_RESPONSE_CHARS = 400_000;


















function json(value: unknown, toolName?: string) {
  const text = JSON.stringify(value);
  if (text.length > MAX_TOOL_RESPONSE_CHARS) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'tool_response_over_budget',
          tool: toolName || 'unknown',
          response_chars: text.length,
          budget_chars: MAX_TOOL_RESPONSE_CHARS,
          detail:
            `This tool produced ${text.length} characters, over the ${MAX_TOOL_RESPONSE_CHARS}-character ` +
            'response budget, so it was withheld rather than truncated — a partial payload would look ' +
            'complete and be acted on. This is a product defect: the tool should summarise or paginate ' +
            'at source. Narrow the request (a specific path, entity, or section) as a workaround, and ' +
            'report the tool name.',
        }),
      }],
    };
  }
  return { content: [{ type: 'text' as const, text }] };
}





export function jsonForTest(value: unknown, toolName?: string) {
  return json(value, toolName);
}











export function buildHostedAnalysisResolution(
  projectPath: string,
  status: Record<string, unknown>,
  clientBuildWarning: string | null = null,
): Record<string, unknown> {
  const hostedSelectedPath = typeof status.selected_path === 'string' && status.selected_path.length > 0
    ? status.selected_path
    : null;
  const selectedPath = hostedSelectedPath || (status.status === 'ready' ? path.resolve(projectPath) : null);
  const recommendation = selectedPath
    ? 'Continue with the selected path; its bound hosted analysis is ready.'
    : 'Hosted analysis is ' + String(status.status || 'unavailable') + '; wait for a ready analysis before requesting agent context.';
  return {
    ...status,
    requested_path: projectPath,
    selected_path: selectedPath,
    recommendation,
    ...(clientBuildWarning ? { client_build_warning: clientBuildWarning } : {}),
  };
}

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
  if (payload?.status !== 'ready' && payload?.status !== 'queryable') return payload;
  const localPath = path.resolve(projectPath);
  return overlayLocalFreshness(localizeHostedWorkspacePath(payload.result, localPath), localPath);
}










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

async function hostedDurableCoordinationCall(
  projectPath: string,
  workspace: string,
  kind: RemoteOperationKind,
  route: string,
  body: Record<string, unknown>,
) {
  const { serverUrl, token } = await hostedServerAndToken(projectPath);
  const result = await executeDurableRemoteOperation({
    workspace,
    baseUrl: serverUrl,
    kind,
    route,
    body,
    send: async (pendingRoute, pendingBody) => {
      const url = `${serverUrl}${pendingRoute}`;
      const operation = `POST ${pendingRoute}`;
      const response = await hostedFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(pendingBody),
      }, { operation });
      if (!response.ok) throw new Error(await describeHttpFailure(response, { url, operation }));
      return readHostedJson(response, { url, operation });
    },
  });
  if (result.response !== undefined) return result.response;
  throw new Error(`Hosted Fabric operation queued durably as ${result.operation_id}; ${result.pending} operation(s) pending. ${result.error ?? ''}`.trim());
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





async function resolveCoordinationWorkspace(projectPath: string, explicitWorkspace: string | undefined): Promise<string> {
  if (explicitWorkspace && explicitWorkspace.trim()) return explicitWorkspace.trim();
  const { projectId } = await hostedServerAndToken(projectPath);
  return projectId || path.basename(projectPath);
}




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




const OPAQUE_ERROR_MESSAGES = new Set(['fetch failed', 'failed to fetch', 'network error', 'terminated', 'other side closed', '']);

export function isOpaqueErrorMessage(message: string): boolean {
  return OPAQUE_ERROR_MESSAGES.has(message.trim().toLowerCase());
}












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

export function normalizeConceptualAnalysisParams(params: Record<string, unknown>): Record<string, unknown> {
  return {
    ...params,
    offset: params.flow_offset ?? params.offset,
    capability_limit: params.catalog_limit ?? params.capability_limit,
    capability_offset: params.catalog_offset ?? params.capability_offset,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'klauro', version: getBuildIdentity().version }, {
    instructions: INSTALLED_CLIENT_INSTRUCTIONS,
  });
  const registerWithErrors = withTransparentErrors(server.registerTool.bind(server) as any);
  const register = ((name: string, ...args: any[]) => {
    if (!isInstalledToolName(name)) throw new Error(`Installed MCP tool "${name}" is not declared in the canonical registry.`);
    return registerWithErrors(name, ...args);
  }) as typeof registerWithErrors;

  register('analyze_codebase', {
    description: 'Upload a filtered source snapshot for hosted Klauro analysis. No analyzer executes locally.',
    inputSchema: {
      path: z.string(),





      force: z.boolean().optional().describe('Bypass the server\'s snapshot-reuse gate AND the AI response cache, forcing a genuinely fresh analysis even if the last uploaded snapshot is unchanged.'),






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









  }, async ({ path, dirty_tree }: any) => json(summarizeUploadManifest(await buildUploadManifest(path, dirty_tree ? 'dirty-tree' : 'full'))));

  register('resolve_agent_analysis', {
    description: 'Resolve the bound hosted project and return its analysis readiness and compact hosted summary.',
    inputSchema: { path: z.string() },



  }, async ({ path }: any) => {
    const status = await hostedProjectGet(path, '/analysis-status') as Record<string, unknown>;
    let staleness: { note: string | null } = { note: null };
    try { staleness = checkRunningBundleStaleness(__dirname); } catch {   }
    return json(buildHostedAnalysisResolution(path, status, staleness.note));
  });

  register('get_summary', {
    description: 'Retrieve the compact hosted analysis summary. The client does not download or construct CAS.',
    inputSchema: { path: z.string() },
  }, async ({ path }: any) => json(boundToolPayload(await hostedProjectGet(path, '/analysis'), { tool: 'get_summary' })));

  register('get_product_map', {
    description: 'Retrieve a hosted product-map slice.',
    inputSchema: { path: z.string() },
  }, async ({ path }: any) => {
    const analysis = await hostedProjectGet(path, '/analysis') as any;
    const unavailable = analysis.status !== 'ready' || analysis.comprehension?.partial === true;
    return json({
      status: analysis.comprehension?.partial === true ? 'partial' : analysis.status,
      project_id: analysis.project_id,
      analysis_id: analysis.analysis_id,
      ...(analysis.failed_layers ? { failed_layers: analysis.failed_layers } : {}),
      ...(analysis.analysis_error ? { error: analysis.analysis_error } : {}),
      ...(analysis.comprehension?.partial ? { error: analysis.comprehension.detail || 'Analysis comprehension is partial.' } : {}),
      ...(unavailable ? {} : { product_map: await hostedProjectQuery(path, 'get_product_map', {}) }),
    });
  });

  register('get_conceptual_analysis', {
    description: 'Retrieve bounded, paginated hosted capability, intent-reconciliation, flow, and step comprehension without downloading CAS.',
    inputSchema: {
      path: z.string(), target: z.string().optional(), max_flows: z.number().optional(),
      flow_offset: z.number().optional(), catalog_limit: z.number().optional(), catalog_offset: z.number().optional(),
      offset: z.number().optional(), capability_limit: z.number().optional(), capability_offset: z.number().optional(),
    },
  }, async ({ path, ...params }: any) => {
    const compatibleParams = normalizeConceptualAnalysisParams(params);
    return json(boundToolPayload(
      await hostedProjectGet(path, '/conceptual', compatibleParams),
      { tool: 'get_conceptual_analysis', parameterNames: ['target', 'max_flows', 'flow_offset', 'catalog_limit', 'catalog_offset'] },
    ));
  });

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
    description: 'Find hosted test suites covering a node or file, with mocks and fixtures related to the returned page. With suite_id, limit and offset page the tests inside that suite.',
    inputSchema: FIND_TESTS_INPUT_SCHEMA,
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
    description: 'Retrieve a bounded answer-pack digest, then fetch any withheld answer by section id.',
    inputSchema: {
      path: z.string(), pack: z.literal('mastery').optional(),
      section: z.enum(['overview', 'entry-points', 'representative-flow', 'change-impact', 'data', 'tests', 'external-boundaries', 'security', 'runtime-readiness']).optional(),
    },
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

  register('evaluate_analysis_truth', {
    description: 'Compare hosted CAS against explicit ground-truth expectations. If omitted, Klauro uses a repo-local analysis expectation file when available.',
    inputSchema: {
      path: z.string(),
      expectation: z.object({
        name: z.string().optional(), frameworks: z.array(z.string()).optional(), languages: z.array(z.string()).optional(), libraries: z.array(z.string()).optional(),
        routes: z.array(z.object({ method: z.string().optional(), path: z.string(), handler: z.string().optional(), controller: z.string().optional() })).optional(),
        nodes: z.array(z.object({ name: z.string(), type: z.string().optional(), file: z.string().optional() })).optional(),
        entities: z.array(z.string()).optional(),
        relationships: z.array(z.object({ source: z.string(), target: z.string(), type: z.string().optional() })).optional(),
        method_calls: z.array(z.object({ caller: z.string(), target: z.string().optional(), method: z.string().optional(), resolution_type: z.string().optional() })).optional(),
        exit_points: z.array(z.object({ type: z.string().optional(), name: z.string().optional(), target: z.string().optional() })).optional(),
        runtime_signals: z.array(z.string()).optional(),
        minimums: z.object({
          nodes: z.number().int().nonnegative().optional(), edges: z.number().int().nonnegative().optional(), entry_points: z.number().int().nonnegative().optional(),
          exit_points: z.number().int().nonnegative().optional(), method_calls: z.number().int().nonnegative().optional(),
          runtime_static_links: z.number().int().nonnegative().optional(), analysis_facts: z.number().int().nonnegative().optional(),
        }).optional(),
      }).optional(),
    },
  }, async ({ path, ...args }: any) => json(await hostedProjectQuery(path, 'evaluate_analysis_truth', args)));

  register('get_semantic_map', {
    description: 'Retrieve a hosted CAS-derived file, symbol, data, relationship, and method-call map.',
    inputSchema: { path: z.string(), target: z.string().optional(), limit: z.number().int().positive().max(200).optional() },
  }, async ({ path, ...args }: any) => json(await hostedProjectQuery(path, 'get_semantic_map', args)));

  register('get_framework_depth_report', {
    description: 'Score hosted framework analysis depth using analyzers, nodes, entries, evidence, and runtime links.',
    inputSchema: { path: z.string() },
  }, async ({ path }: any) => json(await hostedProjectQuery(path, 'get_framework_depth_report', {})));

  register('get_cross_repo_contracts', {
    description: 'Retrieve bounded, evidence-backed provider/consumer contracts, links, journeys, and gaps from a hosted workspace CAS.',
    inputSchema: {
      path: z.string().describe('Any bound project path, used to resolve the hosted server and account.'),
      workspace_id: z.string().describe('Hosted account workspace id from list_workspaces.'),
      limit: z.number().int().positive().max(500).optional(),
      offset: z.number().int().nonnegative().optional(),
      journey_limit: z.number().int().positive().max(100).optional(),
    },
  }, async ({ path: projectPath, workspace_id, ...params }: any) => json(await hostedCoordinationGet(
    projectPath,
    `/api/workspaces/${encodeURIComponent(workspace_id)}/contracts`,
    params,
  )));

  register('get_runtime_instrumentation_plan', {
    description: 'Turn hosted runtime/static links into concrete event contracts and instrumentation points.',
    inputSchema: { path: z.string(), limit: z.number().int().positive().max(500).optional() },
  }, async ({ path, ...args }: any) => json(await hostedProjectQuery(path, 'get_runtime_instrumentation_plan', args)));

  register('evaluate_agent_task_proof', {
    description: 'Prove that hosted CAS supplies target, risk, test, follow-up, and source-reading context for representative agent tasks.',
    inputSchema: { path: z.string(), tasks: z.array(taskSchema).min(1).max(20).optional() },
  }, async ({ path, ...args }: any) => json(await hostedProjectQuery(path, 'evaluate_agent_task_proof', args)));

  register('evaluate_agent_readiness', {
    description: 'Score whether the hosted analysis is ready for agents to use by default.',
    inputSchema: { path: z.string() },
  }, async ({ path }: any) => json(await hostedProjectQuery(path, 'evaluate_agent_readiness', {})));






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
    const result: any = await hostedDurableCoordinationCall(projectPath, ws, 'claim', '/v1/coordination/claim', {
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
    const result: any = await hostedDurableCoordinationCall(projectPath, ws, 'extend', '/v1/coordination/claim', {
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
    const result = await hostedDurableCoordinationCall(projectPath, ws, 'release', '/v1/coordination/release', { workspace: ws, agent_id });
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
