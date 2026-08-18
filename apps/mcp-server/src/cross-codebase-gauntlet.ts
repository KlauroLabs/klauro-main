import * as fs from 'fs-extra';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getAnalysis } from './analyzer';
import { analyzeForBench } from './gauntlet/product-analysis';
import { buildCrossCodebaseSystemGraph, summarizeCrossCodebaseSystemGraph, type CrossCodebaseSystemGraph } from './cross-codebase-analysis';
import { discoverRealRepos } from './repo-discovery';
import { loadCrossCodebaseSystemGraph } from './storage';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

interface TargetResult {
  name: string;
  path: string;
  status: 'missing-path' | 'missing-analysis' | 'included' | 'skipped';
  reason?: string;
}

interface TargetSpec {
  name: string;
  path: string;
  family: string;
}

interface SystemReport {
  name: string;
  paths: string[];
  graph: CrossCodebaseSystemGraph;
  generated_via: 'mcp' | 'internal';
}

interface SystemInput {
  name: string;
  paths: string[];
  repositories: Array<{ path: string; name: string; cas: CASOutput }>;
}

interface McpConsumerResult {
  system: string;
  status: 'pass' | 'fail';
  error?: string;
  analysis_id?: string;
  overview_bytes?: number;
  context_bytes?: number;
  overview_truncated?: boolean;
  context_truncated?: boolean;
  deployables_sample?: string[];
  deployables_returned?: number;
  deployables_total?: number;
  distribution_units?: string[];
  selected_distribution_units?: string[];
  environments?: string[];
  entity_count?: number;
  entity_path_count?: number;
  entity_path_sample?: Array<Record<string, unknown>>;
  traversable_entity_paths?: {
    status: 'pass' | 'fail';
    checked: number;
    invalid_count: number;
    invalid_examples: Array<Record<string, unknown>>;
  };
  contract_status?: string;
  contract_conforms?: boolean;
  freshness_status?: string;
  next_tools?: string[];
  context_excerpt?: {
    selected_surfaces: Array<Record<string, unknown>>;
    linked_supporting_surfaces?: Array<Record<string, unknown>>;
    source_backed_connections: Array<Record<string, unknown>>;
    candidate_connections: Array<Record<string, unknown>>;
    warnings: string[];
    agent_should_read_next: Array<Record<string, unknown>>;
    next_mcp_calls: Array<Record<string, unknown>>;
  };
  generated_via_mcp?: boolean;
  ai_enrichment?: boolean;
  ai_provider?: Record<string, unknown>;
  narrative_source?: string;
  ai_quality_flags?: string[];
  semantic_quality?: Record<string, unknown>;
  semantic_preview?: Record<string, unknown>;
  repo_drilldown?: {
    status: 'pass' | 'fail' | 'skipped';
    path?: string;
    file_read_plan_count?: number;
    has_work_context?: boolean;
    has_tests_or_invariants?: boolean;
    error?: string;
  };
  exclude_run?: {
    status: 'pass' | 'fail' | 'skipped';
    skipped_paths?: string[];
    included_codebases?: number;
    error?: string;
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selection = await resolveTargets(args);
  const devRoot = selection.root;
  const targets = selection.targets;
  const repositories: Array<{ path: string; name: string; family: string; cas: CASOutput }> = [];
  const targetResults: TargetResult[] = [];

  for (const target of targets) {
    if ((target as any).skipped) {
      targetResults.push({ ...target, status: 'skipped', reason: (target as any).reason });
      continue;
    }
    if (!(await fs.pathExists(target.path))) {
      targetResults.push({ ...target, status: 'missing-path' });
      continue;
    }
    try {
      const cas = args.fresh || selection.analyze
        ? await analyzeProjectDeterministicFirstPass(target.path)
        : await getAnalysis(target.path);
      repositories.push({ path: target.path, name: cas.system?.name || path.basename(target.path), family: target.family, cas });
      targetResults.push({ ...target, status: 'included' });
    } catch (error) {
      targetResults.push({
        ...target,
        status: 'missing-analysis',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const systemInputs = buildSystemInputs(repositories);
  const pipeline = args.mcpConsumer
    ? await runMcpWorkspacePipeline(systemInputs, args.withAi)
    : { systems: buildInternalSystemReports(systemInputs), mcpConsumerResults: [] };
  const systems = pipeline.systems;
  const mcpConsumerResults = pipeline.mcpConsumerResults;
  const checks = [
    {
      name: 'at-least-two-analyses',
      pass: repositories.length >= 2,
      observed: repositories.length,
    },
    {
      name: 'interfaces-extracted',
      pass: systems.some(system => system.graph.interfaces.length > 0),
      observed: systems.reduce((sum, system) => sum + system.graph.interfaces.length, 0),
    },
    {
      name: 'unmatched-interfaces-reported',
      pass: systems.every(system => Array.isArray(system.graph.unmatched_interfaces)),
      observed: systems.reduce((sum, system) => sum + system.graph.unmatched_interfaces.length, 0),
    },
    {
      name: 'all-selected-repositories-analyzed',
      pass: targets.length >= 2 && targetResults.length === targets.length && targetResults.every(target => target.status === 'included'),
      observed: targetResults.map(target => ({ path: path.relative(devRoot, target.path) || path.basename(target.path), status: target.status, reason: target.reason })),
    },
    {
      name: 'meaningful-cross-codebase-links',
      pass: systems.length > 0 && (!selection.requireLinks || systems.every(system => system.graph.codebases.length < 2 || system.graph.links.length >= 1)),
      observed: Object.fromEntries(systems.map(system => [system.name, system.graph.links.length])),
    },
    {
      name: 'workspace-applications-extracted',
      pass: systems.length > 0 && systems.every(system => (system.graph.applications || []).length >= system.graph.codebases.length),
      observed: Object.fromEntries(systems.map(system => [system.name, (system.graph.applications || []).length])),
    },
    {
      name: 'workspace-insights-generated',
      pass: systems.length > 0 && systems.every(system => (system.graph.system_insights || []).length > 0 || system.graph.codebases.length === 1),
      observed: Object.fromEntries(systems.map(system => [system.name, (system.graph.system_insights || []).map(insight => insight.title).slice(0, 8)])),
    },
    {
      name: 'workspace-structural-semantics-usable',
      pass: systems.length > 0 && systems.every(system => workspaceStructuralSemanticCoverage(system.graph).pass),
      observed: Object.fromEntries(systems.map(system => [system.name, workspaceStructuralSemanticCoverage(system.graph)])),
    },
    {
      name: 'workspace-primary-semantics-ai-enriched',
      pass: !args.withAi || systems.length > 0 && systems.every(system => workspacePrimarySemanticAiCoverage(system.graph).pass),
      observed: args.withAi
        ? Object.fromEntries(systems.map(system => [system.name, workspacePrimarySemanticAiCoverage(system.graph)]))
        : 'skipped; run with --with-ai to prove AI-authored workspace semantics',
    },
    {
      name: 'workspace-critical-flows-have-intent',
      pass: systems.length > 0 && systems.every(system => workspaceWorkflowIntentCoverage(system.graph).pass),
      observed: Object.fromEntries(systems.map(system => [system.name, workspaceWorkflowIntentCoverage(system.graph)])),
    },
    {
      name: 'communication-modes-covered',
      pass: systems.length > 0 && (!selection.requireLinks || systems.every(system => communicationCoverage(system.graph).pass)),
      observed: Object.fromEntries(systems.map(system => [system.name, communicationCoverage(system.graph)])),
    },
    {
      name: 'runtime-topology-exposed',
      pass: systems.length > 0 && systems.every(system =>
        system.graph.application_links.length > 0 ||
        system.graph.runtime_components.length > 0 && system.graph.runtime_links.length > 0
      ),
      observed: Object.fromEntries(systems.map(system => [system.name, {
        components: system.graph.runtime_components.length,
        links: system.graph.runtime_links.length,
        application_links: system.graph.application_links.length,
      }])),
    },
    {
      name: 'actionable-unmatched-consumers-bounded',
      pass: systems.length > 0 && systems.every(system => actionableUnmatchedBudget(system.graph).pass),
      observed: Object.fromEntries(systems.map(system => [
        system.name,
        actionableUnmatchedBudget(system.graph),
      ])),
    },
    {
      name: 'mcp-product-path-workspace-analysis-usable',
      pass: !args.mcpConsumer || mcpConsumerResults.length === systems.length && mcpConsumerResults.every(result => result.status === 'pass'),
      observed: args.mcpConsumer ? mcpConsumerResults : 'skipped',
    },
    {
      name: 'mcp-product-path-default-ai-enrichment-proven',
      pass: !args.withAi || mcpConsumerResults.length === systems.length && mcpConsumerResults.every(result =>
        result.status === 'pass' &&
        result.ai_enrichment === true &&
        result.narrative_source === 'ai' &&
        (!process.env.KLAURO_EXPECT_AI_PROVIDER || String(result.ai_provider?.provider || '') === process.env.KLAURO_EXPECT_AI_PROVIDER) &&
        (result.ai_quality_flags || []).length === 0
      ),
      observed: args.withAi ? Object.fromEntries(mcpConsumerResults.map(result => [result.system, {
        ai_enrichment: result.ai_enrichment,
        ai_provider: result.ai_provider,
        narrative_source: result.narrative_source,
        ai_quality_flags: result.ai_quality_flags,
        semantic_quality: result.semantic_quality,
      }])) : 'skipped; run with --with-ai to prove required default AI workspace descriptions',
    },
    {
      name: 'mcp-product-path-semantic-preview-clean',
      pass: !args.withAi || mcpConsumerResults.length === systems.length && mcpConsumerResults.every(result =>
        validateMcpSemanticPreview(result).pass
      ),
      observed: args.withAi ? Object.fromEntries(mcpConsumerResults.map(result => [
        result.system,
        validateMcpSemanticPreview(result),
      ])) : 'skipped; run with --with-ai to prove visible semantic preview quality',
    },
    {
      name: 'mcp-product-path-connection-trust-model-clear',
      pass: !args.mcpConsumer || mcpConsumerResults.length === systems.length && mcpConsumerResults.every(result =>
        validateMcpConnectionTrustModel(result).pass
      ),
      observed: args.mcpConsumer ? Object.fromEntries(mcpConsumerResults.map(result => [
        result.system,
        validateMcpConnectionTrustModel(result),
      ])) : 'skipped',
    },
    {
      name: 'mcp-product-path-repo-drilldown-proven',
      pass: !args.mcpConsumer || mcpConsumerResults.length === systems.length && mcpConsumerResults.every(result =>
        result.repo_drilldown?.status === 'pass'
      ),
      observed: args.mcpConsumer ? Object.fromEntries(mcpConsumerResults.map(result => [result.system, result.repo_drilldown])) : 'skipped',
    },
    {
      name: 'mcp-product-path-validates-was-contract-and-freshness',
      pass: !args.mcpConsumer || mcpConsumerResults.length === systems.length && mcpConsumerResults.every(result =>
        result.contract_conforms === true &&
        result.freshness_status === 'fresh' &&
        (result.contract_status === 'pass' || result.contract_status === 'warn')
      ),
      observed: args.mcpConsumer ? Object.fromEntries(mcpConsumerResults.map(result => [result.system, {
        contract_status: result.contract_status,
        contract_conforms: result.contract_conforms,
        freshness_status: result.freshness_status,
      }])) : 'skipped',
    },
    {
      name: 'mcp-product-path-builds-canonical-workspace-analyses',
      pass: !args.mcpConsumer || systems.length > 0 && systems.every(system => system.generated_via === 'mcp') && mcpConsumerResults.every(result => result.generated_via_mcp),
      observed: args.mcpConsumer ? {
        systems: systems.map(system => ({ name: system.name, generated_via: system.generated_via })),
        mcp_results: mcpConsumerResults.map(result => ({ system: result.system, generated_via_mcp: result.generated_via_mcp, analysis_id: result.analysis_id })),
      } : 'skipped',
    },
    {
      name: 'mcp-product-path-keeps-workspace-contexts-compact',
      pass: !args.mcpConsumer || mcpConsumerResults.every(result =>
        result.status === 'pass' &&
        !result.overview_truncated &&
        !result.context_truncated &&
        (result.overview_bytes || 0) <= 20_000 &&
        (result.context_bytes || 0) <= 20_000
      ),
      observed: args.mcpConsumer ? Object.fromEntries(mcpConsumerResults.map(result => [result.system, {
        overview_bytes: result.overview_bytes,
        context_bytes: result.context_bytes,
        overview_truncated: result.overview_truncated,
        context_truncated: result.context_truncated,
      }])) : 'skipped',
    },
    {
      name: 'mcp-product-path-keeps-workspace-entity-paths-traversable',
      pass: !args.mcpConsumer || mcpConsumerResults.every(result =>
        result.status === 'pass' &&
        ((result.entity_path_count || 0) === 0 || result.traversable_entity_paths?.status === 'pass')
      ),
      observed: args.mcpConsumer ? Object.fromEntries(mcpConsumerResults.map(result => [result.system, {
        entity_count: result.entity_count,
        entity_path_count: result.entity_path_count,
        traversable_entity_paths: result.traversable_entity_paths,
        entity_path_sample: result.entity_path_sample,
      }])) : 'skipped',
    },
    {
      name: 'mcp-product-path-honors-workspace-excludes',
      pass: !args.mcpConsumer || mcpConsumerResults.every(result => result.exclude_run?.status !== 'fail'),
      observed: args.mcpConsumer ? Object.fromEntries(mcpConsumerResults.map(result => [result.system, result.exclude_run])) : 'skipped',
    },
  ];
  const report = {
    generated_at: new Date().toISOString(),
    dev_root: devRoot,
    status: checks.every(check => check.pass) ? 'pass' : 'fail',
    targets: targetResults,
    checks,
    mcp_consumer_results: mcpConsumerResults,
    systems: systems.map(system => ({
      name: system.name,
      summary: summarizeCrossCodebaseSystemGraph(system.graph),
      ai_provider: system.graph.ai_enrichment,
      unmatched_breakdown: unmatchedBreakdown(system.graph),
      mermaid: formatMermaid(system.graph),
      graph: args.includeGraph ? system.graph : undefined,
    })),
    summary: summarizeSystems(systems.map(system => system.graph)),
  };

  if (args.output) {
    await fs.ensureDir(path.dirname(path.resolve(args.output)));
    await fs.writeJson(path.resolve(args.output), report, { spaces: 2 });
  }
  if (args.markdown) {
    await fs.ensureDir(path.dirname(path.resolve(args.markdown)));
    await fs.writeFile(path.resolve(args.markdown), formatMarkdown(report));
  }
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatMarkdown(report));
  if (report.status !== 'pass') process.exitCode = 1;
}

function buildSystemInputs(repositories: Array<{ path: string; name: string; family: string; cas: CASOutput }>): SystemInput[] {
  const grouped = new Map<string, Array<{ path: string; name: string; cas: CASOutput }>>();
  for (const repository of repositories) {
    const group = grouped.get(repository.family) || [];
    group.push({ path: repository.path, name: repository.name, cas: repository.cas });
    grouped.set(repository.family, group);
  }
  return [...grouped.entries()]
    .filter(([, group]) => group.length >= 1)
    .map(([family, group]) => ({
      name: family,
      paths: group.map(repository => repository.path),
      repositories: group,
    }));
}

function buildInternalSystemReports(inputs: SystemInput[]): SystemReport[] {
  return inputs.map(input => ({
    name: input.name,
    paths: input.paths,
    graph: buildCrossCodebaseSystemGraph(`${input.name.toLowerCase()}-system`, input.repositories),
    generated_via: 'internal',
  }));
}

async function runMcpWorkspacePipeline(inputs: SystemInput[], aiEnrichment: boolean): Promise<{ systems: SystemReport[]; mcpConsumerResults: McpConsumerResult[] }> {
  if (inputs.length === 0) return { systems: [], mcpConsumerResults: [] };
  const results: McpConsumerResult[] = [];
  const systems: SystemReport[] = [];
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  for (const input of inputs) {
    const result = await runMcpWorkspacePipelineInput(input, aiEnrichment, suffix);
    if (result.system) systems.push(result.system);
    results.push(result.consumerResult);
  }
  return { systems, mcpConsumerResults: results };
}

async function runMcpWorkspacePipelineInput(
  input: SystemInput,
  aiEnrichment: boolean,
  suffix: string,
): Promise<{ system?: SystemReport; consumerResult: McpConsumerResult }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [require.resolve('tsx/cli'), localMcpEntryPath()],
    cwd: process.cwd(),
    stderr: 'pipe',
	    env: {
	      ...process.env,
	      KLAURO_TOOL_PROFILE: 'full',
	      KLAURO_WORKSPACE_AI_TIMEOUT_MS: aiEnrichment
	        ? (process.env.KLAURO_WORKSPACE_AI_TIMEOUT_MS || '120000')
	        : (process.env.KLAURO_WORKSPACE_AI_TIMEOUT_MS || '15000'),
	    } as Record<string, string>,
	  });
  const client = new Client({ name: 'klauro-workspace-gauntlet', version: '1.0.0' }, { capabilities: {} });
  const stderrChunks: string[] = [];
  transport.stderr?.on('data', chunk => stderrChunks.push(String(chunk)));
  try {
    await client.connect(transport);
    const analysisName = `gauntlet-${input.name.toLowerCase()}-${suffix}`;
    const buildResult = await runMcpWorkspaceBuild(client, input, analysisName, aiEnrichment);
    if (!buildResult.graph || !buildResult.analysisId) {
      return {
        consumerResult: {
          system: input.name,
          status: 'fail',
          error: buildResult.error || 'MCP workspace generation did not produce a saved graph.',
          generated_via_mcp: false,
          ai_enrichment: aiEnrichment,
        },
      };
    }
    const system: SystemReport = {
      name: input.name,
      paths: input.paths,
      graph: buildResult.graph,
      generated_via: 'mcp',
    };
    await client.close().catch(() => undefined);
    return {
      system,
      consumerResult: await runMcpConsumerCheckFreshClient(system, buildResult.analysisId, true, aiEnrichment),
    };
  } catch (error) {
    const message = [
      error instanceof Error ? error.message : String(error),
      stderrChunks.join('').trim(),
    ].filter(Boolean).join('\n');
    return {
      consumerResult: { system: input.name, status: 'fail', error: message, generated_via_mcp: false, ai_enrichment: aiEnrichment },
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runMcpConsumerCheckFreshClient(
  system: SystemReport,
  analysisId: string,
  generatedViaMcp: boolean,
  aiEnrichment: boolean,
): Promise<McpConsumerResult> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [require.resolve('tsx/cli'), localMcpEntryPath()],
    cwd: process.cwd(),
    stderr: 'pipe',
    env: {
      ...process.env,
      KLAURO_TOOL_PROFILE: 'full',
      KLAURO_WORKSPACE_AI_TIMEOUT_MS: aiEnrichment
        ? (process.env.KLAURO_WORKSPACE_AI_TIMEOUT_MS || '120000')
        : (process.env.KLAURO_WORKSPACE_AI_TIMEOUT_MS || '15000'),
    } as Record<string, string>,
  });
  const client = new Client({ name: 'klauro-workspace-gauntlet-consumer', version: '1.0.0' }, { capabilities: {} });
  const stderrChunks: string[] = [];
  transport.stderr?.on('data', chunk => stderrChunks.push(String(chunk)));
  try {
    await client.connect(transport);
    return await runMcpConsumerCheck(client, system, analysisId, generatedViaMcp, aiEnrichment);
  } catch (error) {
    const message = [
      error instanceof Error ? error.message : String(error),
      stderrChunks.join('').trim(),
    ].filter(Boolean).join('\n');
    return {
      system: system.name,
      status: 'fail',
      generated_via_mcp: generatedViaMcp,
      ai_enrichment: aiEnrichment,
      error: message,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runMcpWorkspaceBuild(
  client: Client,
  input: SystemInput,
  analysisName: string,
  aiEnrichment: boolean
): Promise<{ analysisId?: string; graph?: CrossCodebaseSystemGraph; error?: string }> {
  try {
    const aiTimeout = Number(process.env.KLAURO_WORKSPACE_GAUNTLET_AI_TIMEOUT_MS || process.env.KLAURO_WORKSPACE_AI_TIMEOUT_MS || 900_000);
    const timeout = aiEnrichment ? Math.max(360_000, aiTimeout) : 120_000;
    const payload = await callMcpTool(client, 'run_workspace_analysis', {
      name: analysisName,
      paths: input.paths,
      ai_enrichment: aiEnrichment,
    }, { timeout });
    const analysisId = String((payload as any)?.saved?.id || analysisName);
    const graph = await loadCrossCodebaseSystemGraph(analysisId);
    if (!graph) return { analysisId, error: `Saved WAS not found after MCP generation: ${analysisId}` };
    return { analysisId, graph };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runMcpConsumerCheck(client: Client, system: SystemReport, analysisName: string, generatedViaMcp: boolean, aiEnrichment: boolean): Promise<McpConsumerResult> {
  try {
    const resolvedPayload = await callMcpTool(client, 'resolve_workspace_analysis', {
      paths: system.paths,
    });
    const savedId = String(readNested(resolvedPayload, ['selected', 'id']) || analysisName);
    const overviewPayload = await callMcpTool(client, 'get_workspace_analysis', {
      analysis_id_or_name: savedId,
      detail_level: 'overview',
    });
    const contextPayload = await callMcpTool(client, 'get_workspace_agent_context', {
      analysis_id_or_name: savedId,
      task: {
        task_type: 'cross-repo',
        target: system.name,
        max_apps: 16,
        max_connections: 24,
        max_external_dependencies: 16,
      },
    });
    const contractPayload = await callMcpTool(client, 'validate_was_contract', {
      analysis_id_or_name: savedId,
    });
    const entityPayload = await callMcpTool(client, 'get_workspace_entity_map', {
      analysis_id_or_name: savedId,
      limit: 12,
    });
    const freshnessPayload = await callMcpTool(client, 'get_workspace_freshness', {
      analysis_id_or_name: savedId,
    });
    const overview = unwrapToolPayload(overviewPayload);
    const context = unwrapToolPayload(contextPayload);
    const contract = unwrapToolPayload(contractPayload);
    const entityMap = unwrapToolPayload(entityPayload);
    const freshness = unwrapToolPayload(freshnessPayload);
    const repoDrilldown = await runMcpRepoDrilldownCheck(client, context, system.name);
    const overviewText = JSON.stringify(overviewPayload);
    const contextText = JSON.stringify(contextPayload);
    const savedGraph = await loadCrossCodebaseSystemGraph(savedId);
    const excludeRun = await runMcpExcludeGenerationCheck(client, system, analysisName);
    return {
      system: system.name,
      status: isMcpWorkspacePayloadUsable(overview, context) ? 'pass' : 'fail',
      analysis_id: savedId,
      overview_bytes: Buffer.byteLength(overviewText, 'utf8'),
      context_bytes: Buffer.byteLength(contextText, 'utf8'),
      overview_truncated: Boolean((overviewPayload as any)?.truncated),
      context_truncated: Boolean((contextPayload as any)?.truncated),
      deployables_sample: ((overview as any)?.deployables || []).map((app: any) => String(app.name)).slice(0, 24),
      deployables_returned: ((overview as any)?.deployables || []).length,
      deployables_total: Number((overview as any)?.summary?.application_count || savedGraph?.applications?.length || 0),
      distribution_units: ((overview as any)?.distribution_units || []).map(formatMcpDistributionUnit).slice(0, 12),
      selected_distribution_units: ((context as any)?.selected_distribution_units || []).map(formatMcpDistributionUnit).slice(0, 12),
      environments: ((overview as any)?.environments || []).map((environment: any) => String(environment.name)).sort(),
      entity_count: ((entityMap as any)?.entities || []).length,
      entity_path_count: ((entityMap as any)?.entity_paths || []).length,
      entity_path_sample: ((entityMap as any)?.entity_paths || []).slice(0, 3),
      traversable_entity_paths: validateMcpEntityPaths((entityMap as any)?.entity_paths || []),
      contract_status: String((contract as any)?.status || ''),
      contract_conforms: Boolean((contract as any)?.conforms_to_was),
      freshness_status: String((freshness as any)?.status || ''),
      next_tools: (((context as any)?.agent_guidance?.next_mcp_calls || []) as Array<{ tool?: string }>).map(call => String(call.tool)).slice(0, 12),
      context_excerpt: {
        selected_surfaces: (((context as any)?.selected_surfaces || []) as Array<Record<string, unknown>>).slice(0, 6),
        linked_supporting_surfaces: (((context as any)?.linked_supporting_surfaces || []) as Array<Record<string, unknown>>).slice(0, 4),
        source_backed_connections: (((context as any)?.source_backed_connections || []) as Array<Record<string, unknown>>).slice(0, 6),
        candidate_connections: (((context as any)?.candidate_connections || []) as Array<Record<string, unknown>>).slice(0, 4),
        warnings: (((context as any)?.agent_guidance?.warnings || []) as string[]).slice(0, 4),
        agent_should_read_next: (((context as any)?.agent_guidance?.agent_should_read_next || []) as Array<Record<string, unknown>>).slice(0, 5),
        next_mcp_calls: (((context as any)?.agent_guidance?.next_mcp_calls || []) as Array<Record<string, unknown>>).slice(0, 4),
      },
      generated_via_mcp: generatedViaMcp,
      ai_enrichment: aiEnrichment,
      ai_provider: savedGraph?.ai_enrichment || system.graph.ai_enrichment,
      narrative_source: system.graph.workspace_narrative?.source,
      semantic_quality: workspacePrimarySemanticAiCoverage(system.graph),
      semantic_preview: workspaceSemanticPreview(savedGraph || system.graph),
      ai_quality_flags: (system.graph.quality_flags || [])
        .map(flag => flag.code)
        .filter(code => ['workspace-narrative-ai-degraded', 'capability-descriptions-degraded', 'domain-descriptions-degraded'].includes(code)),
      repo_drilldown: repoDrilldown,
      exclude_run: excludeRun,
      error: isMcpWorkspacePayloadUsable(overview, context) ? undefined : 'MCP response did not include overview surface sample, context selected surfaces, agent read-next guidance, next MCP calls, or usable context budget.',
    };
  } catch (error) {
    return {
      system: system.name,
      status: 'fail',
      generated_via_mcp: generatedViaMcp,
      ai_enrichment: aiEnrichment,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runMcpExcludeGenerationCheck(client: Client, system: SystemReport, analysisName: string): Promise<NonNullable<McpConsumerResult['exclude_run']>> {
  const workspaceRoot = commonPathPrefix(system.paths);
  if (!workspaceRoot || system.paths.length < 3) return { status: 'skipped' };
  const excludedPath = system.paths[system.paths.length - 1];
  const excludedName = path.basename(excludedPath);
  try {
    const payload = await callMcpTool(client, 'run_workspace_analysis', {
      name: `${analysisName}-exclude-proof`,
      workspace_root: workspaceRoot,
      paths: system.paths,
      exclude: [`${excludedName}/**`],
      ai_enrichment: false,
    }, { timeout: 120_000 });
    const skippedPaths = ((payload as any)?.skipped_inputs || []).map((input: any) => String(input.path));
    const includedCodebases = Number((payload as any)?.summary?.codebase_count || 0);
    const excluded = skippedPaths.some((inputPath: string) => path.resolve(inputPath) === path.resolve(excludedPath));
    return {
      status: excluded && includedCodebases === system.paths.length - 1 ? 'pass' : 'fail',
      skipped_paths: skippedPaths,
      included_codebases: includedCodebases,
      error: excluded ? undefined : `${excludedName} was not reported as skipped by run_workspace_analysis`,
    };
  } catch (error) {
    return {
      status: 'fail',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runMcpRepoDrilldownCheck(
  client: Client,
  context: any,
  systemName: string
): Promise<NonNullable<McpConsumerResult['repo_drilldown']>> {
  const calls = (((context as any)?.agent_guidance?.next_mcp_calls || []) as Array<{ tool?: string; args?: Record<string, any> }>);
  const agentContextCall = calls.find(call => call.tool === 'get_agent_context' && typeof call.args?.path === 'string');
  if (!agentContextCall?.args?.path) return { status: 'skipped', error: 'No get_agent_context drilldown call was present in workspace context.' };
  try {
    const payload = await callMcpTool(client, 'get_agent_context', {
      path: agentContextCall.args.path,
      workspace_analysis_id: agentContextCall.args.workspace_analysis_id,
      task: {
        ...(agentContextCall.args.task || {}),
        response_profile: 'first-turn',
        target: agentContextCall.args.task?.target || systemName,
      },
    }, { timeout: 120_000 });
    const repoContext = unwrapToolPayload(payload);
    const fileReadPlanCount = Array.isArray(repoContext?.file_read_plan)
      ? repoContext.file_read_plan.length
      : Array.isArray(repoContext?.files)
        ? repoContext.files.length
        : 0;
    const workContext = repoContext?.work_context || {};
    const compactContextPresent = Boolean(repoContext?.capsule || repoContext?.context_capsule || repoContext?.selected || repoContext?.execution);
    const tests = workContext?.tests;
    const invariants = workContext?.behavioral_invariants;
    const hasTestsOrInvariants = Boolean(
      (Array.isArray(tests) && tests.length > 0) ||
      (Array.isArray(invariants) && invariants.length > 0) ||
      (invariants && typeof invariants === 'object' && Object.keys(invariants).length > 0) ||
      (Array.isArray(repoContext?.execution?.validate) && repoContext.execution.validate.length > 0)
    );
    return {
      status: fileReadPlanCount > 0 && (Boolean(workContext) || compactContextPresent) ? 'pass' : 'fail',
      path: agentContextCall.args.path,
      file_read_plan_count: fileReadPlanCount,
      has_work_context: Boolean(workContext) || compactContextPresent,
      has_tests_or_invariants: hasTestsOrInvariants,
    };
  } catch (error) {
    return {
      status: 'fail',
      path: agentContextCall.args.path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateMcpEntityPaths(paths: any[]): NonNullable<McpConsumerResult['traversable_entity_paths']> {
  const checked = paths.length;
  const invalidExamples = paths
    .filter(pathItem => {
      const steps = Array.isArray(pathItem.steps) ? pathItem.steps : [];
      return !pathItem.id ||
        !pathItem.entity_name ||
        !pathItem.description ||
        !pathItem.source?.project_id ||
        !pathItem.target?.project_id ||
        steps.length === 0 ||
        steps.some((step: any) => !step.project_id || !step.label || !step.edge_type || !step.evidence_quality) ||
        typeof pathItem.confidence !== 'number' ||
        !pathItem.evidence_quality ||
        !Array.isArray(pathItem.next_mcp_calls);
    })
    .slice(0, 5)
    .map(pathItem => ({
      id: pathItem?.id,
      entity_name: pathItem?.entity_name,
      has_description: Boolean(pathItem?.description),
      has_source: Boolean(pathItem?.source?.project_id),
      has_target: Boolean(pathItem?.target?.project_id),
      step_count: Array.isArray(pathItem?.steps) ? pathItem.steps.length : 0,
      confidence: pathItem?.confidence,
      evidence_quality: pathItem?.evidence_quality,
      next_mcp_call_count: Array.isArray(pathItem?.next_mcp_calls) ? pathItem.next_mcp_calls.length : 0,
    }));
  return {
    status: checked > 0 && invalidExamples.length === 0 ? 'pass' : 'fail',
    checked,
    invalid_count: invalidExamples.length,
    invalid_examples: invalidExamples,
  };
}

function validateMcpSemanticPreview(result: McpConsumerResult): Record<string, unknown> {
  const preview = result.semantic_preview || {};
  const narrative = (preview as any).narrative || {};
  const items: Array<{ section: string; name?: unknown; description?: unknown; description_source?: unknown }> = [
    ...(((preview as any).domains || []) as Array<Record<string, unknown>>).map(item => ({ ...item, section: 'domain' })),
    ...(((preview as any).capabilities || []) as Array<Record<string, unknown>>).map(item => ({ ...item, section: 'capability' })),
  ];
  const text = [
    narrative.product_value_summary,
    narrative.description,
    ...items.flatMap(item => [item.name, item.description, item.description_source]),
  ].map(value => String(value || '')).join('\n');
  const badPattern = /\.\.\.\[truncated\]|whole-workspace domain inferred|Product Catalog|RES Tful|AP Is|SD Ks|ID Es|U Is|\bin ai(?:,|\s+domain|\s+workflows?\b)|AI workflows?|machine to-machine|\bTrace \[ai\]/i;
  const degradedItems = items.filter(item => String(item.description_source || '') !== 'ai');
  const emptyDescriptions = items.filter(item => String(item.description || '').trim().length < 55);
  const duplicateNames = [
    ...duplicateSemanticNames(items.filter(item => item.section === 'domain').map(item => String(item.name || ''))).map(name => `domain:${name}`),
    ...duplicateSemanticNames(items.filter(item => item.section === 'capability').map(item => String(item.name || ''))).map(name => `capability:${name}`),
  ];
  const badMatches = text.match(badPattern) || [];
  return {
    pass: result.status === 'pass' &&
      result.narrative_source === 'ai' &&
      badMatches.length === 0 &&
      degradedItems.length === 0 &&
      emptyDescriptions.length === 0 &&
      duplicateNames.length === 0 &&
      Boolean(String(narrative.product_value_summary || '').trim()),
    narrative_source: result.narrative_source,
    item_count: items.length,
    bad_matches: badMatches.slice(0, 6),
    degraded_items: degradedItems.map(item => `${item.section}:${item.name}:${item.description_source}`).slice(0, 8),
    empty_items: emptyDescriptions.map(item => `${item.section}:${item.name}`).slice(0, 8),
    duplicate_names: duplicateNames.slice(0, 8),
  };
}

function duplicateSemanticNames(names: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    const normalized = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!normalized) continue;
    if (seen.has(normalized)) duplicates.add(name);
    seen.add(normalized);
  }
  return [...duplicates];
}

function validateMcpConnectionTrustModel(result: McpConsumerResult): Record<string, unknown> {
  const sourceBacked = result.context_excerpt?.source_backed_connections || [];
  const candidates = result.context_excerpt?.candidate_connections || [];
  const visibleSurfaceIds = new Set([
    ...(((result.context_excerpt as any)?.selected_surfaces || []) as Array<Record<string, unknown>>).map(surface => String(surface.id || '')),
    ...(((result.context_excerpt as any)?.linked_supporting_surfaces || []) as Array<Record<string, unknown>>).map(surface => String(surface.id || '')),
  ].filter(Boolean));
  const invalidSourceBacked = sourceBacked.filter(connection =>
    String(connection.evidence_quality || '') !== 'source-backed' ||
    !['yes', 'no', 'unknown'].includes(String(connection.runtime_behavior || '')) ||
    !connection.connection_nature ||
    !connection.link_id ||
    !visibleSurfaceIds.has(String(connection.source_id || '')) ||
    !visibleSurfaceIds.has(String(connection.target_id || ''))
  );
  const invalidCandidates = candidates.filter(connection =>
    String(connection.evidence_quality || '') === 'source-backed' ||
    !connection.inferred_reason ||
    !connection.connection_nature ||
    !connection.link_id ||
    String(connection.runtime_behavior || '') === 'yes' ||
    !visibleSurfaceIds.has(String(connection.source_id || '')) ||
    !visibleSurfaceIds.has(String(connection.target_id || ''))
  );
  return {
    pass: result.status === 'pass' && invalidSourceBacked.length === 0 && invalidCandidates.length === 0,
    source_backed_checked: sourceBacked.length,
    candidate_checked: candidates.length,
    invalid_source_backed: invalidSourceBacked.slice(0, 4),
    invalid_candidates: invalidCandidates.slice(0, 4),
  };
}

function commonPathPrefix(paths: string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const splitPaths = paths.map(inputPath => path.resolve(inputPath).split(path.sep));
  const first = splitPaths[0];
  let index = 0;
  while (index < first.length && splitPaths.every(parts => parts[index] === first[index])) index++;
  return first.slice(0, index).join(path.sep) || path.sep;
}

function localMcpEntryPath(): string {
  return path.resolve(process.cwd(), 'src/gauntlet/local-mcp-entry.ts');
}

async function callMcpTool(client: Client, name: string, args: Record<string, unknown>, options: { timeout?: number } = {}): Promise<any> {
  const response = await client.callTool({ name, arguments: args }, undefined, options);
  if ((response as any).isError) {
    throw new Error(readMcpText(response) || `MCP tool failed: ${name}`);
  }
  const text = readMcpText(response);
  if (!text) throw new Error(`MCP tool returned no text: ${name}`);
  return JSON.parse(text);
}

function readMcpText(response: unknown): string {
  const content = (response as any)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(item => item?.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('\n');
}

function unwrapToolPayload(payload: any): any {
  return payload?.truncated && payload?.data ? payload.data : payload;
}

function readNested(value: unknown, keys: string[]): unknown {
  let current: any = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function isMcpWorkspacePayloadUsable(overview: any, context: any): boolean {
  return Boolean(
    overview?.summary &&
    Array.isArray(overview?.deployables) &&
    Array.isArray(overview?.connections) &&
    context?.product === 'workspace_agent_context' &&
    Array.isArray(context?.selected_surfaces) &&
    context?.selected_surfaces.length > 0 &&
    Array.isArray(context?.agent_guidance?.agent_should_read_next) &&
    Array.isArray(context?.agent_guidance?.next_mcp_calls) &&
    context?.context_budget?.estimated_token_reduction_percentage >= 0
  );
}

function formatMcpDistributionUnit(unit: any): string {
  return `${unit.name || unit.id}: ${(unit.component_names || []).join(', ')}`;
}

function summarizeSystems(graphs: CrossCodebaseSystemGraph[]) {
  return {
    system_count: graphs.length,
    codebase_count: graphs.reduce((sum, graph) => sum + graph.codebase_count, 0),
    interface_count: graphs.reduce((sum, graph) => sum + graph.interfaces.length, 0),
    link_count: graphs.reduce((sum, graph) => sum + graph.links.length, 0),
    data_flow_path_count: graphs.reduce((sum, graph) => sum + graph.data_flow_paths.length, 0),
    unmatched_interface_count: graphs.reduce((sum, graph) => sum + graph.unmatched_interfaces.length, 0),
  };
}

async function resolveTargets(args: ReturnType<typeof parseArgs>): Promise<{
  root: string;
  targets: TargetSpec[];
  analyze: boolean;
  requireLinks: boolean;
}> {
  if (args.repos.length > 0) {
    const paths = args.repos.map(repo => path.resolve(repo.path));
    return {
      root: commonPathPrefix(paths) || process.cwd(),
      targets: args.repos.map(repo => ({ ...repo, path: path.resolve(repo.path), family: args.workspaceName })),
      analyze: args.fresh,
      requireLinks: args.requireLinks,
    };
  }

  if (args.devRoot) {
    const root = path.resolve(args.devRoot);
    const discovery = await discoverRealRepos(root);
    const targets = discovery.repos
      .filter(repo => repo.status === 'eligible')
      .sort((left, right) => right.source_files - left.source_files || left.path.localeCompare(right.path))
      .map(repo => ({ name: repo.name, path: repo.path, family: args.workspaceName }));
    return { root, targets, analyze: args.fresh, requireLinks: args.requireLinks };
  }

  const root = path.resolve(process.cwd(), 'fixtures/cross-repo-contracts/web-api');
  const entries = await fs.readdir(root, { withFileTypes: true });
  const targets = entries
    .filter(entry => entry.isDirectory())
    .map(entry => ({ name: entry.name, path: path.join(root, entry.name), family: args.workspaceName }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return { root, targets, analyze: true, requireLinks: true };
}

async function analyzeProjectDeterministicFirstPass(projectPath: string): Promise<CASOutput> {
  const previous = {
    interpretation: process.env.KLAURO_AI_INTERPRETATION,
    interpretationEnabled: process.env.KLAURO_AI_INTERPRETATION_ENABLED,
  };
  process.env.KLAURO_AI_INTERPRETATION = 'false';
  process.env.KLAURO_AI_INTERPRETATION_ENABLED = 'false';
  try {
    return await analyzeForBench(projectPath);
  } finally {
    restoreEnv('KLAURO_AI_INTERPRETATION', previous.interpretation);
    restoreEnv('KLAURO_AI_INTERPRETATION_ENABLED', previous.interpretationEnabled);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function parseArgs(argv: string[]) {
  const parsed: {
    devRoot?: string;
    repos: Array<{ name: string; path: string }>;
    workspaceName: string;
    output?: string;
    markdown?: string;
    json: boolean;
    includeGraph: boolean;
    fresh: boolean;
    mcpConsumer: boolean;
    withAi: boolean;
    requireLinks: boolean;
  } = {
    repos: [],
    workspaceName: 'portable-workspace',
    json: false,
    includeGraph: false,
    fresh: false,
    mcpConsumer: true,
    withAi: false,
    requireLinks: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dev-root') parsed.devRoot = argv[++i];
    else if (arg === '--repo') {
      const value = argv[++i];
      if (!value) throw new Error('--repo requires a path or name=path value');
      const separator = value.indexOf('=');
      const repoPath = separator >= 0 ? value.slice(separator + 1) : value;
      const name = separator >= 0 ? value.slice(0, separator) : path.basename(repoPath);
      parsed.repos.push({ name, path: repoPath });
    }
    else if (arg === '--workspace-name') parsed.workspaceName = argv[++i];
    else if (arg === '--output') parsed.output = argv[++i];
    else if (arg === '--markdown') parsed.markdown = argv[++i];
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--include-graph') parsed.includeGraph = true;
    else if (arg === '--fresh') parsed.fresh = true;
    else if (arg === '--no-mcp-consumer') parsed.mcpConsumer = false;
    else if (arg === '--with-ai' || arg === '--ai-enrichment') parsed.withAi = true;
    else if (arg === '--require-links') parsed.requireLinks = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(formatUsage());
      process.exit(0);
    }
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return parsed;
}

function formatUsage(): string {
  return [
    'Usage: npm run workspace-analysis-gauntlet -- [options]',
    '',
    'Options:',
    '  --repo [name=]<path>    Add a repository to one workspace. May be repeated.',
    '  --dev-root <path>       Discover eligible repositories below a root as one workspace.',
    '  --workspace-name <name> Name assigned to the selected workspace.',
    '  --output <file>         Write JSON report.',
    '  --markdown <file>       Write Markdown report.',
    '  --json                  Print JSON report to stdout.',
    '  --include-graph         Include full workspace graphs in the report.',
    '  --fresh                 Re-analyze target repos before building workspace graphs.',
    '  --no-mcp-consumer       Use internal graph builder only; skip MCP consumer validation.',
    '  --with-ai               Enable AI enrichment checks when provider config is available.',
    '  --require-links         Require at least one resolved cross-repository link.',
    '  -h, --help              Show this help.',
    '',
  ].join('\n');
}

function formatMarkdown(report: any): string {
  const targetLines = report.targets.map((target: TargetResult) =>
    `- ${target.name}: ${target.status} (${target.path})${target.reason ? ` - ${target.reason}` : ''}`
  );
  const checkLines = report.checks.map((check: any) =>
    `- ${check.pass ? 'PASS' : 'FAIL'} ${check.name}: ${formatObserved(check.observed)}`
  );
  return [
    '# Workspace Analysis Mini Gauntlet',
    '',
    `Status: ${String(report.status).toUpperCase()}`,
    `Generated: ${report.generated_at}`,
    `Dev root: ${report.dev_root}`,
    '',
    '## Targets',
    ...(targetLines.length ? targetLines : ['- none']),
    '',
    '## Checks',
    ...checkLines,
    '',
    '## Summary',
    report.summary ? `Systems: ${report.summary.system_count}` : 'Systems: 0',
    report.summary ? `Codebases: ${report.summary.codebase_count}` : 'Codebases: 0',
    report.summary ? `Interfaces: ${report.summary.interface_count}` : 'Interfaces: 0',
    report.summary ? `Links: ${report.summary.link_count}` : 'Links: 0',
    report.summary ? `Unmatched interfaces: ${report.summary.unmatched_interface_count}` : 'Unmatched interfaces: 0',
    '',
    '## MCP Consumer Evidence',
    ...((report.mcp_consumer_results || []).flatMap((result: McpConsumerResult) => [
      `### ${result.system}`,
      `Status: ${result.status}`,
      `Context bytes: ${result.context_bytes ?? 'unknown'}${result.context_truncated ? ' (truncated)' : ''}`,
      `Deployables sample: ${(result.deployables_sample || []).join(', ') || 'none'} (${result.deployables_returned ?? 0}/${result.deployables_total ?? 0} returned)`,
      `Narrative: ${String((result.semantic_preview as any)?.narrative?.product_value_summary || '')}`,
      `Domains: ${(((result.semantic_preview as any)?.domains || []) as any[]).map(item => `${item.name} [${item.description_source}] - ${item.description}`).join(' | ') || 'none'}`,
      `Capabilities: ${(((result.semantic_preview as any)?.capabilities || []) as any[]).map(item => `${item.name} [${item.description_source}] - ${item.description}`).join(' | ') || 'none'}`,
      `AI quality flags: ${(result.ai_quality_flags || []).join(' | ') || 'none'}`,
      `Selected surfaces: ${((result.context_excerpt?.selected_surfaces || []) as any[]).map(item => `${item.name} (${item.deployable ? 'deployable' : 'non-deployable'} ${item.surface_kind || item.kind || 'surface'})`).join(', ') || 'none'}`,
      `Source-backed connections: ${((result.context_excerpt?.source_backed_connections || []) as any[]).map(item => `${item.source}->${item.target} ${item.kind}/${item.runtime_behavior}/${item.connection_nature}`).join(', ') || 'none'}`,
      `Candidate connections: ${((result.context_excerpt?.candidate_connections || []) as any[]).map(item => `${item.source}->${item.target} ${item.evidence_quality}: ${item.inferred_reason}`).join(', ') || 'none'}`,
      '',
    ])),
    '',
    '## Systems',
    ...((report.systems || []).flatMap((system: any) => [
      `### ${system.name}`,
      `Codebases: ${system.summary.codebase_count}`,
      `Interfaces: ${system.summary.interface_count}`,
      `Links: ${system.summary.link_count}`,
      `Unmatched interfaces: ${system.summary.unmatched_interface_count}`,
      `Unmatched breakdown: ${formatObserved(system.unmatched_breakdown)}`,
      '',
      system.mermaid || 'No graph generated.',
      '',
    ])),
    '',
  ].join('\n');
}

function hasLinkedMode(graph: CrossCodebaseSystemGraph, mode: string): boolean {
  return [...graph.links, ...(graph.application_links || [])].some(link => link.mode === mode);
}

function communicationCoverage(graph: CrossCodebaseSystemGraph) {
  const linked = countLinkModes(graph);
  const interfaceModes = graph.interfaces.reduce((counts, item) => {
    counts[item.mode] = (counts[item.mode] || 0) + 1;
    return counts;
  }, {} as Record<string, number>);
  const hasAnyLink = Object.values(linked).some(count => count > 0);
  const needsNonSyncProof = graph.codebases.length > 1 && ((interfaceModes.async || 0) + (interfaceModes.stream || 0) + (interfaceModes.passive || 0)) > 0;
  return {
    pass: hasAnyLink && (!needsNonSyncProof || hasLinkedMode(graph, 'async') || hasLinkedMode(graph, 'stream') || hasLinkedMode(graph, 'passive')),
    linked,
    interface_modes: interfaceModes,
    requirement: needsNonSyncProof ? 'sync plus at least one non-sync workspace link' : 'at least one workspace link',
  };
}

function countLinkModes(graph: CrossCodebaseSystemGraph): Record<string, number> {
  return [...graph.links, ...(graph.application_links || [])].reduce((counts, link) => {
    counts[link.mode] = (counts[link.mode] || 0) + 1;
    return counts;
  }, {} as Record<string, number>);
}

function workspaceStructuralSemanticCoverage(graph: CrossCodebaseSystemGraph | undefined): Record<string, unknown> {
  if (!graph) return { pass: false, reason: 'missing graph' };
  const domains = graph.workspace_domains || [];
  const entities = graph.workspace_entities || [];
  const workflows = graph.workspace_workflows || [];
  const describedDomains = domains.filter(item => usefulDescription(item.description)).length;
  const describedEntities = entities.filter(item => usefulDescription(item.description)).length;
  const describedWorkflows = workflows.filter(item => usefulDescription(item.description)).length;
  return {
    pass: domains.length > 0 &&
      workflows.length > 0 &&
      describedEntities === entities.length &&
      describedWorkflows === workflows.length,
    domains: domains.length,
    described_domains: describedDomains,
    entities: entities.length,
    described_entities: describedEntities,
    workflows: workflows.length,
    described_workflows: describedWorkflows,
  };
}

function workspacePrimarySemanticAiCoverage(graph: CrossCodebaseSystemGraph | undefined): Record<string, unknown> {
  if (!graph) return { pass: false, reason: 'missing graph' };
  const primaryCapabilities = (graph.workspace_capabilities || []).slice(0, Math.min(8, Math.max(1, graph.workspace_capabilities?.length || 0)));
  const primaryDomains = (graph.workspace_domains || []).slice(0, Math.min(6, Math.max(1, graph.workspace_domains?.length || 0)));
  const aiCapabilities = primaryCapabilities.filter(item => item.description_source === 'ai' && usefulDescription(item.description)).length;
  const aiDomains = primaryDomains.filter(item => item.description_source === 'ai' && usefulDescription(item.description)).length;
  const capabilityRatio = primaryCapabilities.length ? aiCapabilities / primaryCapabilities.length : 1;
  const domainRatio = primaryDomains.length ? aiDomains / primaryDomains.length : 1;
  return {
    pass: graph.workspace_narrative?.source === 'ai' &&
      primaryCapabilities.length > 0 &&
      primaryDomains.length > 0 &&
      capabilityRatio === 1 &&
      domainRatio === 1,
    narrative_source: graph.workspace_narrative?.source,
    primary_capabilities: primaryCapabilities.length,
    primary_capability_ai_descriptions: aiCapabilities,
    primary_capability_ai_ratio: Number(capabilityRatio.toFixed(2)),
    primary_domains: primaryDomains.length,
    primary_domain_ai_descriptions: aiDomains,
    primary_domain_ai_ratio: Number(domainRatio.toFixed(2)),
    degraded_primary_capabilities: primaryCapabilities.filter(item => item.description_source !== 'ai').map(item => item.name).slice(0, 5),
    degraded_primary_domains: primaryDomains.filter(item => item.description_source !== 'ai').map(item => item.name).slice(0, 5),
  };
}

function workspaceSemanticPreview(graph: CrossCodebaseSystemGraph | undefined): Record<string, unknown> {
  if (!graph) return { error: 'missing graph' };
  const semanticItem = (item: any) => ({
    name: item.name,
    description: item.description,
    description_source: item.description_source,
    semantic_role: item.semantic_role,
    terminal_score: item.terminal_score,
    semantic_trust_guidance: item.description_source === 'ai' && Number(item.terminal_score || 0) <= 0
      ? 'AI-enriched orientation with little terminal/last-in-chain evidence; drill into repo CAS before treating as core product truth.'
      : undefined,
    confidence: item.confidence,
  });
  const ready = (item: any) => item?.description_source === 'ai';
  return {
    narrative: {
      source: graph.workspace_narrative?.source,
      ai_provider: graph.workspace_narrative?.ai_provider || graph.ai_enrichment?.provider,
      ai_model: graph.workspace_narrative?.ai_model || graph.ai_enrichment?.model,
      product_value_summary: graph.workspace_narrative?.product_value_summary,
      description: graph.workspace_narrative?.description,
      key_capabilities: graph.workspace_narrative?.key_capabilities?.slice(0, 8),
      relationship_summary: graph.workspace_narrative?.relationship_summary?.slice(0, 6),
    },
    domains: (graph.workspace_domains || []).filter(ready).slice(0, 8).map(semanticItem),
    capabilities: (graph.workspace_capabilities || []).filter(ready).slice(0, 8).map(semanticItem),
    workflows: (graph.workspace_workflows || []).slice(0, 5).map(semanticItem),
  };
}

function workspaceWorkflowIntentCoverage(graph: CrossCodebaseSystemGraph | undefined): Record<string, unknown> {
  if (!graph) return { pass: false, reason: 'missing graph' };
  const workflows = graph.workspace_workflows || [];
  const useful = workflows.filter(workflow =>
    usefulDescription(workflow.description) &&
    !/^\w+(?:\s+\w+){0,4}\s+with\s+\d+\s+endpoint\(s\)/i.test(workflow.description)
  ).length;
  const ratio = workflows.length ? useful / workflows.length : 1;
  return {
    pass: workflows.length > 0 && ratio >= 0.8,
    workflows: workflows.length,
    useful_descriptions: useful,
    useful_ratio: Number(ratio.toFixed(2)),
    examples: workflows.slice(0, 3).map(workflow => ({ name: workflow.name, description: workflow.description })),
  };
}

function usefulDescription(value: unknown): boolean {
  const text = String(value || '').trim();
  return text.length >= 80 &&
    !/^(unnamed|null|undefined)$/i.test(text) &&
    !/\[object Object\]/.test(text);
}

function actionableUnmatchedBudget(graph: CrossCodebaseSystemGraph) {
  const diagnostics = unmatchedBreakdown(graph);
  const budget = Math.max(2, Math.ceil(graph.links.length * 0.5));
  return {
    pass: diagnostics.actionable <= budget,
    actionable: diagnostics.actionable,
    budget,
    provider_surplus: diagnostics.provider_surplus,
    external_or_local: diagnostics.external_or_local,
    ratio: diagnostics.consumer_surface === 0 ? 0 : Number((diagnostics.actionable / diagnostics.consumer_surface).toFixed(3)),
  };
}

function unmatchedBreakdown(graph: CrossCodebaseSystemGraph) {
  const interfaces = new Map(graph.interfaces.map(item => [item.id, item]));
  const counts = {
    provider_surplus: 0,
    external_or_local: 0,
    actionable: 0,
    consumer_surface: graph.unmatched_interfaces.filter(item => item.role === 'consumer' || item.role === 'publisher').length,
  };
  for (const unmatched of graph.unmatched_interfaces) {
    const item = interfaces.get(unmatched.interface_id);
    if (!item) continue;
    const category = unmatchedCategory(item, graph);
    counts[category]++;
  }
  return counts;
}

function unmatchedCategory(item: CrossCodebaseSystemGraph['interfaces'][number], graph: CrossCodebaseSystemGraph): 'provider_surplus' | 'external_or_local' | 'actionable' {
  if (item.role === 'provider' || item.role === 'listener') return 'provider_surplus';
  if (looksExternalOrLocal(item, graph)) return 'external_or_local';
  return 'actionable';
}

function looksExternalOrLocal(item: CrossCodebaseSystemGraph['interfaces'][number], graph: CrossCodebaseSystemGraph): boolean {
  const aliases = new Set([
    ...graph.codebases.map(codebase => codebase.name.toLowerCase()),
    ...graph.runtime_components.flatMap(component => component.service_aliases),
  ]);
  const itemAliases = (item.service_aliases || []).map(alias => alias.toLowerCase());
  if (itemAliases.includes('external_api')) return true;
  if (item.kind === 'sdk') return true;
  if (/^(EXTERNAL-SERVICE|SERVICE-DEPENDENCY|SERVICE-REFERENCE)\b/i.test(item.name)) return true;
  if (item.endpoint && /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0)(?::|\/|$)/i.test(item.endpoint)) return true;
  const host = endpointHost(item.endpoint || item.key);
  if (host && !aliases.has(host) && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(host)) return true;
  const refFiles = item.refs.map(ref => String(ref.file || '').toLowerCase());
  if (refFiles.some(file => file.includes('/libs/external/') || file.includes('/adapters/') || file.includes('/tests/'))) return true;
  if (item.kind === 'message' && /(?:^|[:.])(?:error|tunerror|exception)(?:[:.]|$)/i.test(item.key)) return true;
  return false;
}

function endpointHost(value: string | undefined): string {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('/') || raw.includes('${')) return '';
  try {
    const url = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(`http://${raw}`);
    return url.hostname.toLowerCase();
  } catch {
    return '';
  }
}

function formatMermaid(graph: CrossCodebaseSystemGraph): string {
  const visibleApplicationIds = new Set((graph.detail_views?.overview?.deployables || graph.deployables || []).map(item => item.id));
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_]/g, '_');
  const lines = ['```mermaid', 'flowchart LR'];
  const overviewDeployables = (graph.detail_views?.overview?.deployables || graph.deployables || []) as any[];
  for (const codebase of graph.codebases) {
    const apps = overviewDeployables.filter(app => app.project_id === codebase.id || app.codebase_id === codebase.id);
    if (apps.length === 0) {
      lines.push(`  ${safe(codebase.id)}["${escapeMermaidLabel(codebase.name)}"]`);
      continue;
    }
    lines.push(`  subgraph ${safe(codebase.id)}["${escapeMermaidLabel(codebase.name)}"]`);
    for (const app of apps) {
      const meta = [app.kind, app.isolated ? 'isolated' : '', app.ports?.length ? `ports ${app.ports.join(',')}` : ''].filter(Boolean).join(' / ');
      lines.push(`    ${safe(app.id)}["${escapeMermaidLabel(app.name)}<br/>${escapeMermaidLabel(meta)}"]`);
    }
    lines.push('  end');
  }
  const renderedApplicationEdges = new Set<string>();
  const overviewConnections = [
    ...(graph.detail_views?.overview?.trusted_connections || []),
    ...(graph.detail_views?.overview?.candidate_connections || []),
  ];
  for (const link of overviewConnections
    .filter(item => visibleApplicationIds.has(item.source_id) && visibleApplicationIds.has(item.target_id))
    .slice(0, 60)) {
    const key = `${link.source_id}->${link.target_id}:${link.kind}:${link.mode}`;
    if (renderedApplicationEdges.has(key)) continue;
    const label = `${link.kind} / ${link.mode} / ${link.evidence_quality} / ${Math.round(link.confidence * 100)}%`;
    const arrow = link.evidence_quality === 'source-backed' || link.evidence_quality === 'package-declared' ? '-->' : '-.->';
    lines.push(`  ${safe(link.source_id)} ${arrow}|"${escapeMermaidLabel(label)}"| ${safe(link.target_id)}`);
    renderedApplicationEdges.add(key);
  }
  for (const dependency of (graph.detail_views?.overview?.external_dependencies || []).slice(0, 12)) {
    const depId = safe(`external_${dependency.project}_${dependency.name}`);
    lines.push(`  ${depId}[("${escapeMermaidLabel(`${dependency.name}<br/>${dependency.usage}`)}")]`);
  }
  if (overviewConnections.length === 0) lines.push('  empty["No workspace links detected"]');
  lines.push('```');
  return lines.join('\n');
}

function escapeMermaidLabel(value: string): string {
  return String(value).replace(/"/g, '\\"');
}

function formatObserved(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.some(item => item && typeof item === 'object')) return JSON.stringify(value);
    return value.join(', ');
  }
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : error}\n`);
  process.exit(1);
});
