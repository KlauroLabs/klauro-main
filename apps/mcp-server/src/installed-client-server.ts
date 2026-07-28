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

async function hostedProjectGet(projectPath: string, suffix: string, params: Record<string, unknown> = {}) {
  const loaded = await loadKlauroConfig(projectPath);
  const serverUrl = resolveAnalyzerUrl(loaded)!.replace(/\/+$/, '');
  const projectId = loaded.config.project.id;
  if (!projectId) throw new Error(`No hosted Klauro project is bound to ${projectPath}. Run \`klauro init ${projectPath}\` first.`);
  const url = new URL(`${serverUrl}/api/projects/${encodeURIComponent(projectId)}${suffix}`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
  const token = connectorToken(undefined, serverUrl);
  const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const payload = await response.json().catch(() => ({ status: 'error', error: `Klauro returned HTTP ${response.status}` }));
  if (!response.ok || (payload as any).status === 'error') throw new Error((payload as any).error || `Klauro returned HTTP ${response.status}`);
  return payload;
}

async function hostedProjectQuery(projectPath: string, tool: string, args: Record<string, unknown> = {}) {
  const loaded = await loadKlauroConfig(projectPath);
  const serverUrl = resolveAnalyzerUrl(loaded)!.replace(/\/+$/, '');
  const projectId = loaded.config.project.id;
  if (!projectId) throw new Error(`No hosted Klauro project is bound to ${projectPath}. Run \`klauro init ${projectPath}\` first.`);
  const token = connectorToken(undefined, serverUrl);
  const response = await fetch(`${serverUrl}/api/projects/${encodeURIComponent(projectId)}/query`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ tool, args }),
  });
  const payload = await response.json().catch(() => ({ status: 'error', error: `Klauro returned HTTP ${response.status}` })) as any;
  if (!response.ok || payload.status === 'error') throw new Error(payload.error || `Klauro returned HTTP ${response.status}`);
  return payload.result;
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

export function createServer(): McpServer {
  const server = new McpServer({ name: 'klauro', version: '1.0.0' }, {
    instructions: 'Klauro installed client. Upload source and diffs for hosted analysis, query hosted slices, and watch in-flight changes. No analysis, CAS/WAS construction, graph construction, proposal materialization, or embeddings execute on this machine.',
  });
  const register = server.registerTool.bind(server) as any;

  register('analyze_codebase', {
    description: 'Upload a filtered source snapshot for hosted Klauro analysis. No analyzer executes locally.',
    inputSchema: { path: z.string() },
  }, async ({ path }: any) => json(await analyzeCodebaseRemotely({ projectPath: path })));

  register('sync_codebase_remote', {
    description: 'Upload in-flight working-tree changes for hosted incremental analysis.',
    inputSchema: { path: z.string() },
  }, async ({ path }: any) => json(await syncWorkingTreeRemotely({ projectPath: path })));

  register('get_upload_manifest', {
    description: 'Preview exactly which source files would be uploaded. This reads files but performs no parsing or analysis.',
    inputSchema: { path: z.string(), dirty_tree: z.boolean().optional() },
  }, async ({ path, dirty_tree }: any) => json(await buildUploadManifest(path, dirty_tree ? 'dirty-tree' : 'full')));

  register('resolve_agent_analysis', {
    description: 'Resolve the bound hosted project and return its analysis readiness and compact hosted summary.',
    inputSchema: { path: z.string() },
  }, async ({ path }: any) => json(await hostedProjectGet(path, '/analysis-status')));

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
