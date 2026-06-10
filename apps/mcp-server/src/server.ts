import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appendFileSync } from 'fs';
import { analyzeProject, getAnalysis, analyzeProjectIncremental } from './analyzer';
import { getStorageHealth, listAgenticBenchmarkReports, listAnalyses, listWorkspaceGraphs, loadAgenticBenchmarkReport, loadGoldenSnapshot, loadLatestAgenticBenchmarkReportByType, loadRuntimeObservations, loadWorkspaceGraph, saveAgenticBenchmarkReport, saveGoldenSnapshot, saveRuntimeObservation, saveWorkspaceGraph } from './storage';
import * as query from './query';
import * as watcher from './watcher';
import * as product from './product';
import * as agentAdoption from './agent-adoption';
import * as agentBootstrap from './agent-bootstrap';
import * as analysisMastery from './analysis-mastery';
import * as runtimeContract from './runtime-contract';
import * as casContract from './cas-contract';
import * as testDiscovery from './test-discovery';
import * as freshness from './freshness';
import * as runtimeSdk from './runtime-sdk';
import * as agentDoctor from './agent-doctor';
import * as workspaceGraph from './workspace-graph';
import * as agentDefaults from './agent-defaults';
import * as integrationDepth from './integration-depth';
import * as invariantValidation from './invariant-validation';
import * as agentProjectMap from './agent-project-map';
import * as idiomQuery from './idiom-query';
import * as agentWorkflow from './agent-workflow';
import { formatMarkdownReport, runAgenticBenchmark } from './agent-benchmark';
import { formatQualityMarkdownReport, runAgentQualityBenchmark } from './agent-quality-benchmark';
import { formatIncrementalValueMarkdownReport, runIncrementalValueBenchmark } from './incremental-benchmark';
import { buildAgentPerformanceProof, formatStoredBenchmarkReport } from './agent-performance-proof';
import { formatIdiomBenchmarkMarkdown, runAgentIdiomBenchmark } from './agent-idiom-benchmark';
import { runMachineAgentProof } from './machine-gauntlet';
import { analyzeCodebaseRemotely, syncWorkingTreeRemotely } from './remote-sync-client';
import { buildUploadManifest } from './remote-source';
import { loadKlauroConfig, writeDefaultKlauroConfig } from './klauro-config';
import { buildGithubImportPlan } from './github-import';
import * as proposalPreview from './proposal-preview';
import * as greenfieldGuidance from './greenfield-guidance';
import * as greenfieldBuildSession from './greenfield-build-session';
import * as descriptionEnrichment from './description-enrichment';
import * as runtimeSimulation from './runtime-simulation';
import * as telemetryIngestion from './telemetry-ingestion';
import { semanticSearch } from './semantic-search';
import { pruneKlauroStorage } from './storage-maintenance';

const SERVER_INSTRUCTIONS = [
  'Klauro serves a precomputed code analysis (CAS) for analyzed repositories.',
  'In analyzed repositories, call resolve_agent_analysis before reading files;',
  'it reports whether an analysis exists for the path.',
  'When an analysis exists, get_agent_start_context replaces exploratory reading.',
  'Call get_agent_work_packet before edits and validate_agent_change after.',
  'If no analysis exists or a tool errors, fall back to direct file reading.',
].join(' ');

export type ToolProfile = 'core' | 'full';

export function resolveToolProfile(): ToolProfile {
  return (process.env.KLAURO_TOOL_PROFILE || '').trim().toLowerCase() === 'core' ? 'core' : 'full';
}

export const CORE_TOOL_NAMES = [
  'resolve_agent_analysis',
  'get_agent_start_context',
  'get_agent_tool_plan',
  'get_agent_work_packet',
  'search_nodes',
  'get_coding_context',
  'assess_change_risk',
  'find_tests',
  'validate_agent_change',
  'get_product_map',
  'get_user_journeys',
  'run_answer_pack',
];

const GATEWAY_TOOL_NAME = 'klauro_query';

interface RegisteredToolEntry {
  config: { description?: string; inputSchema?: Record<string, z.ZodTypeAny> };
  handler: (...args: any[]) => any;
}

export function createServer(): McpServer {
  const toolProfile = resolveToolProfile();
  const server = new McpServer(
    { name: 'klauro', version: '1.0.0' },
    {
      capabilities: {
        resources: {},
        tools: {},
        prompts: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  const toolRegistry = recordToolRegistrations(server, toolProfile);
  enableToolCallLogging(server);
  registerTools(server);
  if (toolProfile === 'core') registerToolGateway(server, toolRegistry);
  registerResources(server);
  registerPrompts(server);

  return server;
}

function recordToolRegistrations(server: McpServer, profile: ToolProfile): Map<string, RegisteredToolEntry> {
  const registry = new Map<string, RegisteredToolEntry>();
  const originalRegisterTool = server.registerTool.bind(server);
  (server as any).registerTool = (name: string, config: any, handler: (...args: any[]) => any) => {
    registry.set(name, { config, handler });
    if (profile === 'core' && !CORE_TOOL_NAMES.includes(name) && name !== GATEWAY_TOOL_NAME) return undefined;
    return originalRegisterTool(name as any, config as any, handler as any);
  };
  return registry;
}

const GATEWAY_TOOL_GROUPS: Array<{ label: string; tools: string[] }> = [
  { label: 'Analysis management', tools: ['analyze_codebase', 'generate_element_description', 'get_element_description', 'get_analysis_phases', 'run_analysis_layer', 'initialize_klauro_project', 'get_klauro_project_config', 'get_upload_manifest', 'get_github_import_plan', 'analyze_codebase_remote', 'sync_codebase_remote', 'list_analyses', 'validate_cas_contract', 'get_storage_health', 'get_storage_maintenance_report', 'prune_storage_artifacts', 'preview_codebase_iteration', 'get_greenfield_architecture_guidance', 'get_greenfield_build_packet', 'preview_greenfield_codebase', 'get_preview_analysis', 'compare_analysis_iterations', 'get_analysis_freshness', 'get_test_discovery_evidence', 'save_cas_golden_snapshot', 'compare_cas_golden_snapshot'] },
  { label: 'System understanding and agent workflow', tools: ['get_summary', 'get_system_overview', 'get_architecture_context', 'list_answer_packs', 'get_mcp_demo_flow', 'get_cross_repo_links', 'save_workspace_graph', 'get_workspace_graph', 'list_workspace_graphs', 'verify_workspace_link', 'get_agent_bootstrap', 'get_agent_project_map', 'get_agent_doctor', 'get_agent_default_config', 'install_agent_default_config', 'get_capability_memory', 'get_idiom_aware_work_packet', 'open_agent_workbench', 'preflight_agent_change', 'get_codebase_agent_rules', 'explain_change_shape', 'evaluate_analysis_truth', 'get_semantic_map', 'get_framework_depth_report', 'get_integration_depth_report', 'get_cross_repo_contracts', 'get_runtime_instrumentation_plan', 'get_runtime_event_contract', 'get_runtime_sdk_package', 'evaluate_agent_task_proof', 'evaluate_agent_readiness', 'run_agentic_benchmark', 'get_agentic_benchmark_report', 'get_agent_performance_proof', 'run_agent_quality_benchmark', 'run_agent_idiom_benchmark', 'run_machine_agent_proof', 'run_incremental_value_benchmark', 'get_patterns', 'get_codebase_idioms', 'get_idiom_examples', 'validate_codebase_idioms', 'get_pattern_instances', 'get_perspectives'] },
  { label: 'Navigation and search', tools: ['semantic_search', 'get_embedding_status', 'get_node', 'get_file_nodes', 'get_level'] },
  { label: 'Entry points, routes, and call graph', tools: ['get_entry_points', 'get_exit_points', 'get_route_table', 'get_external_services', 'get_callers', 'get_callees', 'get_call_chain', 'get_method_calls'] },
  { label: 'Component hierarchy', tools: ['get_component_parents', 'get_component_children', 'get_component_metrics', 'get_shared_components'] },
  { label: 'Coding context and conventions', tools: ['get_conventions', 'get_modification_guide', 'get_pattern_examples', 'find_similar_code', 'get_comments', 'get_error_contracts', 'get_framework_guidance', 'get_usage_examples', 'get_configuration'] },
  { label: 'Intent, data, and risk', tools: ['get_intent', 'get_data_entities', 'get_security_overview', 'get_behavioral_invariants', 'validate_behavioral_invariants', 'get_stability', 'get_flow_coverage'] },
  { label: 'Workflows, capabilities, and runtime', tools: ['get_workflows', 'get_paradigm_conformance', 'get_data_lineage', 'diff_behavior', 'get_flow_graph', 'get_runtime_static_links', 'simulate_runtime_telemetry', 'correlate_runtime_event', 'record_runtime_event', 'ingest_telemetry', 'get_runtime_observations', 'get_operational_priorities', 'get_runtime_trace', 'get_analysis_facts', 'get_domain_concepts'] },
  { label: 'Behaviors, testing, data, and health', tools: ['get_behaviors', 'get_lifecycle_hooks', 'get_test_summary', 'get_database_schema', 'get_implementation_health', 'get_system_health', 'get_documentation_coverage', 'get_todos'] },
  { label: 'Dependencies', tools: ['get_dependencies', 'get_libraries'] },
  { label: 'Change history', tools: ['get_changes_since', 'get_changes_between', 'get_changes_for_node', 'get_changes_for_file', 'get_changes_for_entry_point', 'get_change_summary', 'get_hot_spots', 'get_analysis_at', 'get_analysis_snapshots'] },
  { label: 'Watch mode', tools: ['start_watch', 'stop_watch', 'get_watch_status', 'list_watches', 'poll_watch_changes'] },
];

function buildGatewayDescription(registry: Map<string, RegisteredToolEntry>): string {
  const available = new Set(
    [...registry.keys()].filter(name => !CORE_TOOL_NAMES.includes(name) && name !== GATEWAY_TOOL_NAME)
  );
  const lines: string[] = [];
  for (const group of GATEWAY_TOOL_GROUPS) {
    const names = group.tools.filter(name => available.has(name));
    for (const name of names) available.delete(name);
    if (names.length > 0) lines.push(`${group.label}: ${names.join(', ')}`);
  }
  if (available.size > 0) lines.push(`Other: ${[...available].join(', ')}`);
  return [
    'Run any Klauro analysis tool that is not exposed directly in this core profile.',
    'Pass the tool name and its arguments object; the call dispatches to the same handler as the full tool.',
    'Available tools by purpose:',
    ...lines,
  ].join('\n');
}

function registerToolGateway(server: McpServer, registry: Map<string, RegisteredToolEntry>): void {
  server.registerTool(
    GATEWAY_TOOL_NAME,
    {
      title: 'Klauro Query Gateway',
      description: buildGatewayDescription(registry),
      inputSchema: {
        tool: z.string().describe('Name of the Klauro tool to run'),
        args: z.record(z.unknown()).optional().describe('Arguments object for the tool, matching its documented input schema'),
      } as any,
    } as any,
    async ({ tool, args }: any) => withErrorHandling(async () => {
      const entry = registry.get(tool);
      if (!entry || tool === GATEWAY_TOOL_NAME) {
        const names = [...registry.keys()].filter(name => name !== GATEWAY_TOOL_NAME).sort();
        throw new Error(`Unknown Klauro tool '${tool}'. Available tools: ${names.join(', ')}`);
      }
      return await entry.handler(parseGatewayArgs(tool, entry, args ?? {}));
    })
  );
}

function parseGatewayArgs(tool: string, entry: RegisteredToolEntry, args: Record<string, unknown>): Record<string, unknown> {
  const shape = entry.config?.inputSchema;
  if (!shape) return args;
  const schema = typeof (shape as any).safeParse === 'function' ? (shape as unknown as z.ZodTypeAny) : z.object(shape);
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new Error(`Invalid arguments for '${tool}': ${issues}`);
  }
  return parsed.data as Record<string, unknown>;
}

function enableToolCallLogging(server: McpServer): void {
  const logPath = process.env.KLAURO_TOOL_CALL_LOG;
  if (!logPath) return;

  const originalRegisterTool = server.registerTool.bind(server);
  (server as any).registerTool = (name: string, config: unknown, handler: (...args: any[]) => any) =>
    originalRegisterTool(name as any, config as any, (async (...args: any[]) => {
      try {
        appendFileSync(logPath, `${JSON.stringify({ tool: name, at: new Date().toISOString() })}\n`);
      } catch {
        // Logging must never break tool execution.
      }
      return handler(...args);
    }) as any);
}

function json(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errorResponse(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

async function withErrorHandling(fn: () => Promise<{ content: Array<{ type: 'text'; text: string }> }>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    return await fn();
  } catch (error) {
    return errorResponse(error);
  }
}

async function loadRepositoryAnalyses(paths?: string[]): Promise<Array<{ path: string; name: string; cas: Awaited<ReturnType<typeof getAnalysis>> }>> {
  const selectedPaths = paths && paths.length > 0
    ? paths
    : (await listAnalyses()).map(analysis => analysis.path);

  const repositories = [];
  for (const repositoryPath of selectedPaths) {
    const cas = await getAnalysis(repositoryPath);
    repositories.push({
      path: repositoryPath,
      name: cas.system?.name || repositoryPath.split('/').pop() || repositoryPath,
      cas,
    });
  }

  return repositories;
}

function runtimeObservationId(): string {
  return `runtime_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

type AnalysisFocus = 'agent-fast' | 'ui-overview' | 'deep-context' | 'full';

async function withAnalysisFocus<T>(focus: AnalysisFocus | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = {
    interpretation: process.env.KLAURO_AI_INTERPRETATION,
    interpretationForce: process.env.KLAURO_AI_INTERPRETATION_FORCE,
    deterministicKeep: process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP,
    interpretationBudget: process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS,
    elementBudget: process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS,
    elementBatchSize: process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE,
    elements: process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS,
    embeddings: process.env.KLAURO_EMBEDDING_ENABLED,
  };

  try {
    if (focus === 'agent-fast') {
      process.env.KLAURO_AI_INTERPRETATION = 'false';
      process.env.KLAURO_AI_INTERPRETATION_FORCE = 'false';
      process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = 'false';
      process.env.KLAURO_EMBEDDING_ENABLED = 'false';
    } else if (focus === 'ui-overview') {
      process.env.KLAURO_AI_INTERPRETATION = process.env.KLAURO_AI_INTERPRETATION || 'true';
      process.env.KLAURO_AI_INTERPRETATION_FORCE = process.env.KLAURO_AI_INTERPRETATION_FORCE || 'true';
      process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP = 'false';
      process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS = process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS || '45000';
      process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS = process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS || '90000';
      process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE = process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE || '4';
      process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS || 'true';
      process.env.KLAURO_EMBEDDING_ENABLED = 'false';
    } else if (focus === 'deep-context') {
      process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS || 'false';
    }

    return await fn();
  } finally {
    restoreEnv('KLAURO_AI_INTERPRETATION', previous.interpretation);
    restoreEnv('KLAURO_AI_INTERPRETATION_FORCE', previous.interpretationForce);
    restoreEnv('KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP', previous.deterministicKeep);
    restoreEnv('KLAURO_AI_INTERPRETATION_BUDGET_MS', previous.interpretationBudget);
    restoreEnv('KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS', previous.elementBudget);
    restoreEnv('KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE', previous.elementBatchSize);
    restoreEnv('KLAURO_AI_ELEMENT_DESCRIPTIONS', previous.elements);
    restoreEnv('KLAURO_EMBEDDING_ENABLED', previous.embeddings);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function registerTools(server: McpServer) {

  // -- Analysis Management --

  server.registerTool(
    'analyze_codebase',
    {
      title: 'Analyze Codebase',
      description: 'Run full CAS analysis on a local directory path. Detects languages, frameworks, and libraries. Stores results for querying.',
      inputSchema: {
        path: z.string().describe('Absolute path to the project directory'),
        force_full: z.boolean().optional().describe('Force full rebuild even if incremental is possible'),
        analysis_focus: z.enum(['agent-fast', 'ui-overview', 'deep-context', 'full']).optional().describe('Optional layered analysis profile. agent-fast prioritizes MCP context speed, ui-overview prioritizes AI narrative and visualization, deep-context enables deeper semantic layers, full uses default configured behavior.'),
      } as any,
    } as any,
    async ({ path, force_full, analysis_focus }: any) => withErrorHandling(async () => withAnalysisFocus(analysis_focus, async () => {
      if (force_full) {
        const result = await analyzeProject(path);
        return json({
          status: 'success',
          analysis_type: 'full',
          analysis_focus: analysis_focus || 'full',
          path,
          name: result.system?.name || path.split('/').pop(),
          nodes: result.nodes?.length || 0,
          edges: result.edges?.length || 0,
          entry_points: result.entry_points?.length || 0,
          analyzers_run: result.analyzer_contributions?.length || 0,
          errors: result.analysis_errors?.length || 0,
          phases: result.analysis_phases || [],
        });
      }

      const result = await analyzeProjectIncremental(path);
      return json({
        status: 'success',
        analysis_type: result.wasFullRebuild ? 'full' : 'incremental',
        analysis_focus: analysis_focus || 'full',
        path,
        name: result.output.system?.name || path.split('/').pop(),
        nodes: result.output.nodes?.length || 0,
        edges: result.output.edges?.length || 0,
        entry_points: result.output.entry_points?.length || 0,
        analyzers_run: result.output.analyzer_contributions?.length || 0,
        errors: result.output.analysis_errors?.length || 0,
        phases: result.output.analysis_phases || [],
        change_summary: result.wasFullRebuild ? undefined : {
          files_changed: result.changeReport.summary.filesAdded +
                        result.changeReport.summary.filesModified +
                        result.changeReport.summary.filesDeleted,
          nodes_added: result.changeReport.summary.nodesAdded,
          nodes_modified: result.changeReport.summary.nodesModified,
          nodes_deleted: result.changeReport.summary.nodesDeleted,
          risk_level: result.changeReport.impact.riskLevel,
        },
      });
    }))
  );

  server.registerTool(
    'generate_element_description',
    {
      title: 'Generate Element Description',
      description: 'Manually generate and store an AI description for one CAS element. Use this for drilldown descriptions of nodes, services, entities, capabilities, entry points, or exit points after the fast default analysis has completed.',
      inputSchema: {
        path: z.string().describe('Absolute path to the analyzed project directory'),
        target: z.string().describe('Element id or name to describe'),
        target_kind: z.enum(['node', 'service', 'entity', 'capability', 'entry_point', 'exit_point']).optional().describe('Optional target kind to disambiguate ids/names'),
        instructions: z.string().optional().describe('Optional guidance for the description, such as audience or what to emphasize'),
      } as any,
    } as any,
    async ({ path, target, target_kind, instructions }: any) => withErrorHandling(async () => {
      return json(await descriptionEnrichment.generateElementDescription({
        projectPath: path,
        target,
        targetKind: target_kind,
        instructions,
      }));
    })
  );

  server.registerTool(
    'get_element_description',
    {
      title: 'Get Element Description',
      description: 'Fetch a stored manual AI description for one CAS element and report whether it is still valid or invalidated by source/fingerprint changes.',
      inputSchema: {
        path: z.string().describe('Absolute path to the analyzed project directory'),
        target: z.string().describe('Element id or name to fetch'),
        target_kind: z.enum(['node', 'service', 'entity', 'capability', 'entry_point', 'exit_point']).optional().describe('Optional target kind to disambiguate ids/names'),
      } as any,
    } as any,
    async ({ path, target, target_kind }: any) => withErrorHandling(async () => {
      return json(await descriptionEnrichment.getElementDescription({
        projectPath: path,
        target,
        targetKind: target_kind,
      }));
    })
  );

  server.registerTool(
    'get_analysis_phases',
    {
      title: 'Get Analysis Phases',
      description: 'Inspect which Klauro analysis layers have completed, which were deferred, and what each layer contributes to UI visualization and AI-agent development.',
      inputSchema: {
        path: z.string().describe('Absolute path to the analyzed project directory'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json({
        analysis_id: cas.analysis_id,
        analysis_timestamp: cas.analysis_timestamp,
        phases: cas.analysis_phases || [],
        ai_description_status: {
          system: cas.enhanced_system_purpose?.description_generation || null,
          capabilities: (cas.system_capabilities || []).slice(0, 25).map(capability => ({
            id: capability.id,
            name: capability.name,
            source: capability.description_source || null,
            generation: capability.description_generation || null,
          })),
        },
      });
    })
  );

  server.registerTool(
    'run_analysis_layer',
    {
      title: 'Run Analysis Layer',
      description: 'Manually trigger a focused Klauro analysis layer without making agents run a full default workflow. Use for fast agent refreshes, UI overview refreshes, deep context refreshes, manual element descriptions, or simulated telemetry.',
      inputSchema: {
        path: z.string().describe('Absolute path to the analyzed project directory'),
        layer: z.enum(['agent-fast-refresh', 'ui-overview-refresh', 'deep-context-refresh', 'manual-element-description', 'runtime-simulation']).describe('Layer to run'),
        target: z.string().optional().describe('Element id/name for manual-element-description'),
        target_kind: z.enum(['node', 'service', 'entity', 'capability', 'entry_point', 'exit_point']).optional().describe('Element kind for manual-element-description'),
        instructions: z.string().optional().describe('Description instructions for manual-element-description'),
        scenario: z.enum(['balanced', 'bug-hunt', 'traffic-spike', 'slow-dependencies']).optional().describe('Runtime simulation scenario'),
        event_count: z.number().optional().describe('Runtime simulation event count'),
        seed: z.string().optional().describe('Runtime simulation seed'),
        persist: z.boolean().optional().describe('Whether runtime simulation observations should be stored'),
        force_full: z.boolean().optional().describe('Force full rebuild for refresh layers'),
      } as any,
    } as any,
    async ({ path, layer, target, target_kind, instructions, scenario, event_count, seed, persist, force_full }: any) => withErrorHandling(async () => {
      if (layer === 'manual-element-description') {
        if (!target) throw new Error('manual-element-description requires target');
        return json(await descriptionEnrichment.generateElementDescription({
          projectPath: path,
          target,
          targetKind: target_kind,
          instructions,
        }));
      }

      if (layer === 'runtime-simulation') {
        const cas = await getAnalysis(path);
        return json(await runtimeSimulation.simulateRuntimeTelemetry(cas, path, {
          scenario,
          eventCount: event_count,
          seed,
          persist,
        }));
      }

      const focus: AnalysisFocus = layer === 'agent-fast-refresh'
        ? 'agent-fast'
        : layer === 'ui-overview-refresh'
          ? 'ui-overview'
          : 'deep-context';

      return json(await withAnalysisFocus(focus, async () => {
        if (force_full) {
          const result = await analyzeProject(path);
          return {
            status: 'success',
            layer,
            analysis_type: 'full',
            analysis_focus: focus,
            path,
            nodes: result.nodes?.length || 0,
            edges: result.edges?.length || 0,
            entry_points: result.entry_points?.length || 0,
            phases: result.analysis_phases || [],
          };
        }

        const result = await analyzeProjectIncremental(path);
        return {
          status: 'success',
          layer,
          analysis_type: result.wasFullRebuild ? 'full' : 'incremental',
          analysis_focus: focus,
          path,
          nodes: result.output.nodes?.length || 0,
          edges: result.output.edges?.length || 0,
          entry_points: result.output.entry_points?.length || 0,
          phases: result.output.analysis_phases || [],
          change_summary: result.wasFullRebuild ? undefined : {
            files_changed: result.changeReport.summary.filesAdded +
              result.changeReport.summary.filesModified +
              result.changeReport.summary.filesDeleted,
            nodes_added: result.changeReport.summary.nodesAdded,
            nodes_modified: result.changeReport.summary.nodesModified,
            nodes_deleted: result.changeReport.summary.nodesDeleted,
            risk_level: result.changeReport.impact.riskLevel,
          },
        };
      }));
    })
  );

  server.registerTool(
    'initialize_klauro_project',
    {
      title: 'Initialize Klauro Project',
      description: 'Write .klaurorc and .klauroignore so teams can control analyzer mode, upload policy, source include/exclude rules, and project identity.',
      inputSchema: {
        path: z.string().describe('Absolute path to the project directory'),
        mode: z.enum(['local', 'remote']).optional().describe('Analyzer mode to write into .klaurorc'),
        server_url: z.string().optional().describe('Remote analyzer URL to write into .klaurorc'),
        project_id: z.string().optional().describe('Stable hosted project id'),
        organization_id: z.string().optional().describe('Hosted organization id'),
        force: z.boolean().optional().describe('Overwrite existing .klaurorc and .klauroignore'),
      } as any,
    } as any,
    async ({ path, mode, server_url, project_id, organization_id, force }: any) => withErrorHandling(async () => {
      const result = await writeDefaultKlauroConfig(path, {
        mode,
        serverUrl: server_url,
        projectId: project_id,
        organizationId: organization_id,
        force,
      });
      return json({
        status: 'success',
        config_file: result.configPath,
        ignore_file: result.ignorePath,
        analyzer_mode: result.config.analyzer.mode,
        analyzer_url: result.config.analyzer.serverUrl,
        project_id: result.config.project.id,
        organization_id: result.config.project.organizationId,
      });
    })
  );

  server.registerTool(
    'get_klauro_project_config',
    {
      title: 'Get Klauro Project Config',
      description: 'Read effective .klaurorc, .klauroignore, analyzer mode, upload policy, and project identity for a repository.',
      inputSchema: {
        path: z.string().describe('Absolute path to the project directory'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const loaded = await loadKlauroConfig(path);
      return json({
        status: 'success',
        config_file: loaded.configPath,
        ignore_file: loaded.ignorePath,
        ignore_patterns: loaded.ignorePatterns,
        config: loaded.config,
      });
    })
  );

  server.registerTool(
    'get_upload_manifest',
    {
      title: 'Get Upload Manifest',
      description: 'Dry-run the remote analyzer upload policy and show exactly which files would be sent before full or dirty-tree sync.',
      inputSchema: {
        path: z.string().describe('Absolute path to the project directory'),
        dirty_tree: z.boolean().optional().describe('Show dirty-tree incremental upload instead of full snapshot upload'),
      } as any,
    } as any,
    async ({ path, dirty_tree }: any) => withErrorHandling(async () => {
      return json(await buildUploadManifest(path, dirty_tree ? 'dirty-tree' : 'full'));
    })
  );

  server.registerTool(
    'get_github_import_plan',
    {
      title: 'Get GitHub Import Plan',
      description: 'Describe the GitHub App permissions, webhooks, and local-agent handoff needed for hosted main-branch analysis.',
      inputSchema: {
        path: z.string().describe('Absolute path to the project directory'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const loaded = await loadKlauroConfig(path);
      return json(buildGithubImportPlan(path, loaded.config));
    })
  );

  server.registerTool(
    'analyze_codebase_remote',
    {
      title: 'Analyze Codebase Remotely',
      description: 'Upload a filtered local source snapshot to a remote Klauro analyzer service, then cache the returned CAS locally for fast MCP queries.',
      inputSchema: {
        path: z.string().describe('Absolute path to the project directory'),
        server_url: z.string().optional().describe('Remote analyzer URL. Defaults to KLAURO_ANALYZER_URL or http://127.0.0.1:8787'),
        analysis_id: z.string().optional().describe('Stable remote analysis id. Defaults to a hash of the local project path'),
      } as any,
    } as any,
    async ({ path, server_url, analysis_id }: any) => withErrorHandling(async () => {
      const result = await analyzeCodebaseRemotely({ projectPath: path, serverUrl: server_url, analysisId: analysis_id });
      return json({
        status: result.status,
        analysis_id: result.analysis_id,
        analysis_revision: result.analysis_revision,
        analysis_type: result.analysis_type,
        files_sent: result.manifest.file_count,
        bytes_sent: result.manifest.total_bytes,
        path,
        name: result.cas.system?.name || path.split('/').pop(),
        nodes: result.cas.nodes?.length || 0,
        edges: result.cas.edges?.length || 0,
        entry_points: result.cas.entry_points?.length || 0,
      });
    })
  );

  server.registerTool(
    'sync_codebase_remote',
    {
      title: 'Sync Codebase Remotely',
      description: 'Send dirty-tree file changes to a remote Klauro analyzer service and cache the updated CAS locally. Use after local agent edits when analyzers are hosted.',
      inputSchema: {
        path: z.string().describe('Absolute path to the project directory'),
        server_url: z.string().optional().describe('Remote analyzer URL. Defaults to KLAURO_ANALYZER_URL or http://127.0.0.1:8787'),
        analysis_id: z.string().optional().describe('Stable remote analysis id. Defaults to a hash of the local project path'),
      } as any,
    } as any,
    async ({ path, server_url, analysis_id }: any) => withErrorHandling(async () => {
      const result = await syncWorkingTreeRemotely({ projectPath: path, serverUrl: server_url, analysisId: analysis_id });
      const summary = result.change_report?.summary;
      return json({
        status: result.status,
        analysis_id: result.analysis_id,
        analysis_revision: result.analysis_revision,
        analysis_type: result.analysis_type,
        files_sent: result.manifest.file_count,
        bytes_sent: result.manifest.total_bytes,
        path,
        name: result.cas.system?.name || path.split('/').pop(),
        nodes: result.cas.nodes?.length || 0,
        edges: result.cas.edges?.length || 0,
        entry_points: result.cas.entry_points?.length || 0,
        change_summary: summary ? {
          files_changed: summary.filesAdded + summary.filesModified + summary.filesDeleted,
          nodes_added: summary.nodesAdded,
          nodes_modified: summary.nodesModified,
          nodes_deleted: summary.nodesDeleted,
          edges_added: summary.edgesAdded,
          edges_modified: summary.edgesModified,
          edges_deleted: summary.edgesDeleted,
        } : undefined,
      });
    })
  );

  server.registerTool(
    'list_analyses',
    {
      title: 'List Analyses',
      description: 'List all previously analyzed codebases with metadata.',
      inputSchema: {} as any,
    } as any,
    async () => {
      const analyses = await listAnalyses();
      return json(analyses);
    }
  );

  server.registerTool(
    'validate_cas_contract',
    {
      title: 'Validate CAS Contract',
      description: 'Run executable CAS completeness checks: graph integrity, entry/exit references, runtime links, facts, method calls, call chains, and optional runtime observation correlation.',
      inputSchema: {
        path: z.string().describe('Project path'),
        include_runtime_observations: z.boolean().optional().describe('Include stored runtime observations in correlation gates'),
      } as any,
    } as any,
    async ({ path, include_runtime_observations }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const observations = include_runtime_observations ? await loadRuntimeObservations(path) : [];
      return json(casContract.validateCASContract(cas, observations));
    })
  );

  server.registerTool(
    'get_storage_health',
    {
      title: 'Get Storage Health',
      description: 'Inspect MCP analysis storage: indexed analyses, snapshots, change history, file cache size, and runtime observation counts.',
      inputSchema: {
        path: z.string().optional().describe('Optional project path filter'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      return json(await getStorageHealth(path));
    })
  );

  server.registerTool(
    'get_storage_maintenance_report',
    {
      title: 'Get Storage Maintenance Report',
      description: 'Dry-run report for generated Klauro storage and allowlisted temp proof/preview/live-trial artifacts. Does not delete anything.',
      inputSchema: {
        root: z.string().optional().describe('Klauro home root. Defaults to ~/.klauro.'),
        repo_root: z.string().optional().describe('Repository root when include_local_artifacts is true.'),
        temp_root: z.string().optional().describe('Temp root when include_temp_artifacts is true. Defaults to os.tmpdir().'),
        older_than_days: z.number().optional().describe('Select generated artifacts older than this many days.'),
        max_bytes: z.number().optional().describe('Also select oldest/largest artifacts until generated storage is under this byte limit.'),
        include_local_artifacts: z.boolean().optional().describe('Include repo-local .klauro-* benchmark artifacts under repo_root.'),
        include_temp_artifacts: z.boolean().optional().describe('Include allowlisted Klauro-generated temp proof/preview/live-trial workspaces.'),
        include_analyses: z.boolean().optional().describe('Include analysis snapshot files. Off by default.'),
      } as any,
    } as any,
    async ({ root, repo_root, temp_root, older_than_days, max_bytes, include_local_artifacts, include_temp_artifacts, include_analyses }: any) => withErrorHandling(async () => {
      return json(await pruneKlauroStorage({
        root,
        repoRoot: repo_root,
        tempRoot: temp_root,
        olderThanDays: older_than_days,
        maxBytes: max_bytes,
        includeLocalArtifacts: include_local_artifacts,
        includeTempArtifacts: include_temp_artifacts,
        includeAnalyses: include_analyses,
        confirm: false,
      }));
    })
  );

  server.registerTool(
    'prune_storage_artifacts',
    {
      title: 'Prune Storage Artifacts',
      description: 'Delete selected generated Klauro artifacts. Requires confirm_delete=true and only deletes allowlisted generated artifacts selected by the provided filters.',
      inputSchema: {
        confirm_delete: z.boolean().describe('Must be true to delete selected generated artifacts.'),
        root: z.string().optional().describe('Klauro home root. Defaults to ~/.klauro.'),
        repo_root: z.string().optional().describe('Repository root when include_local_artifacts is true.'),
        temp_root: z.string().optional().describe('Temp root when include_temp_artifacts is true. Defaults to os.tmpdir().'),
        older_than_days: z.number().optional().describe('Select generated artifacts older than this many days.'),
        max_bytes: z.number().optional().describe('Also select oldest/largest artifacts until generated storage is under this byte limit.'),
        include_local_artifacts: z.boolean().optional().describe('Include repo-local .klauro-* benchmark artifacts under repo_root.'),
        include_temp_artifacts: z.boolean().optional().describe('Include allowlisted Klauro-generated temp proof/preview/live-trial workspaces.'),
        include_analyses: z.boolean().optional().describe('Include analysis snapshot files. Off by default.'),
      } as any,
    } as any,
    async ({ confirm_delete, root, repo_root, temp_root, older_than_days, max_bytes, include_local_artifacts, include_temp_artifacts, include_analyses }: any) => withErrorHandling(async () => {
      if (confirm_delete !== true) {
        return json({
          status: 'needs-confirmation',
          message: 'Set confirm_delete=true to delete selected generated artifacts. Call get_storage_maintenance_report first to inspect the candidate list.',
        });
      }
      return json(await pruneKlauroStorage({
        root,
        repoRoot: repo_root,
        tempRoot: temp_root,
        olderThanDays: older_than_days,
        maxBytes: max_bytes,
        includeLocalArtifacts: include_local_artifacts,
        includeTempArtifacts: include_temp_artifacts,
        includeAnalyses: include_analyses,
        confirm: true,
      }));
    })
  );

  server.registerTool(
    'preview_codebase_iteration',
    {
      title: 'Preview Codebase Iteration',
      description: 'Analyze a proposed plan plus diff/files as an ephemeral iteration of an existing codebase. CAS remains proposal-agnostic; the preview references baseline and proposed analyses.',
      inputSchema: {
        path: z.string().describe('Absolute path to the existing project directory'),
        plan_text: z.string().describe('Natural-language proposal or agent plan'),
        title: z.string().optional().describe('Human-readable preview title'),
        diff_text: z.string().optional().describe('Unified diff to apply in a temporary workspace'),
        proposed_files: z.array(z.object({
          path: z.string(),
          content: z.string().optional(),
          status: z.enum(['added', 'modified', 'deleted']).optional(),
        })).optional().describe('Explicit proposed file writes/deletions to apply in the temporary workspace'),
        organization_id: z.string().optional(),
        project_id: z.string().optional(),
        codebase_id: z.string().optional(),
        preview_base_url: z.string().optional().describe('Hosted Klauro app base URL for generated private preview links'),
      } as any,
    } as any,
    async ({ path, plan_text, title, diff_text, proposed_files, organization_id, project_id, codebase_id, preview_base_url }: any) => withErrorHandling(async () => {
      return json(await proposalPreview.previewCodebaseIteration({
        path,
        planText: plan_text,
        title,
        diffText: diff_text,
        proposedFiles: proposed_files,
        organizationId: organization_id,
        projectId: project_id,
        codebaseId: codebase_id,
        previewBaseUrl: preview_base_url,
      }));
    })
  );

  server.registerTool(
    'get_greenfield_architecture_guidance',
    {
      title: 'Get Greenfield Architecture Guidance',
      description: 'Use existing analyzed repositories as memory before creating a new codebase. Returns architecture options, duplicate-capability warnings, first-file guidance, tests, and next MCP preview steps.',
      inputSchema: {
        plan_text: z.string().describe('Natural-language new-project goal or agent plan'),
        proposed_files: z.array(z.object({
          path: z.string(),
          content: z.string().optional(),
          status: z.enum(['added', 'modified', 'deleted']).optional(),
        })).optional().describe('Optional proposed file bundle to review before preview_greenfield_codebase'),
        reference_paths: z.array(z.string()).optional().describe('Existing analyzed repositories to use as memory. Omit to use all stored analyses.'),
        limit: z.number().optional().describe('Maximum overlap matches to return'),
      } as any,
    } as any,
    async ({ plan_text, proposed_files, reference_paths, limit }: any) => withErrorHandling(async () => {
      const references = await loadRepositoryAnalyses(reference_paths);
      return json(greenfieldGuidance.buildGreenfieldArchitectureGuidance({
        planText: plan_text,
        proposedFiles: proposed_files,
        references: references.map(reference => ({
          path: reference.path,
          name: reference.name,
          cas: reference.cas,
        })),
        limit,
      }));
    })
  );

  server.registerTool(
    'get_greenfield_build_packet',
    {
      title: 'Get Greenfield Build Packet',
      description: 'Guide a zero-repo or growing greenfield build. For an empty folder it returns first-slice architecture guidance; after files exist it analyzes the folder and returns CAS-backed memory, duplicate-prevention rules, focused files to read, and next-slice validation steps.',
      inputSchema: {
        workspace_path: z.string().describe('Absolute path to the empty or growing project folder'),
        plan_text: z.string().describe('Current product requirement or next-slice plan'),
        proposed_files: z.array(z.object({
          path: z.string(),
          content: z.string().optional(),
          status: z.enum(['added', 'modified', 'deleted']).optional(),
        })).optional().describe('Optional proposed file bundle for the next slice'),
        reference_paths: z.array(z.string()).optional().describe('Existing analyzed repositories to use as external memory. Omit to use all stored analyses.'),
        limit: z.number().optional().describe('Maximum overlap matches to return'),
      } as any,
    } as any,
    async ({ workspace_path, plan_text, proposed_files, reference_paths, limit }: any) => withErrorHandling(async () => {
      const references = await loadRepositoryAnalyses(reference_paths);
      return json(await greenfieldBuildSession.buildGreenfieldBuildPacket({
        workspacePath: workspace_path,
        planText: plan_text,
        proposedFiles: proposed_files,
        references: references.map(reference => ({
          path: reference.path,
          name: reference.name,
          cas: reference.cas,
        })),
        limit,
      }));
    })
  );

  server.registerTool(
    'preview_greenfield_codebase',
    {
      title: 'Preview Greenfield Codebase',
      description: 'Analyze proposed files as a synthetic new codebase and return a normal CAS-backed preview with advisory readiness warnings.',
      inputSchema: {
        plan_text: z.string().describe('Natural-language proposal or agent plan'),
        title: z.string().optional().describe('Human-readable preview title'),
        proposed_files: z.array(z.object({
          path: z.string(),
          content: z.string().optional(),
          status: z.enum(['added', 'modified', 'deleted']).optional(),
        })).optional().describe('Proposed file bundle for the synthetic codebase'),
        organization_id: z.string().optional(),
        project_id: z.string().optional(),
        preview_base_url: z.string().optional().describe('Hosted Klauro app base URL for generated private preview links'),
      } as any,
    } as any,
    async ({ plan_text, title, proposed_files, organization_id, project_id, preview_base_url }: any) => withErrorHandling(async () => {
      return json(await proposalPreview.previewGreenfieldCodebase({
        planText: plan_text,
        title,
        proposedFiles: proposed_files,
        organizationId: organization_id,
        projectId: project_id,
        previewBaseUrl: preview_base_url,
      }));
    })
  );

  server.registerTool(
    'get_preview_analysis',
    {
      title: 'Get Preview Analysis',
      description: 'Fetch stored proposal preview metadata, baseline/proposed CAS artifacts, comparison payload, and visualization payload.',
      inputSchema: {
        preview_id: z.string().optional().describe('Preview id. Defaults to latest.'),
      } as any,
    } as any,
    async ({ preview_id }: any) => withErrorHandling(async () => {
      return json(await proposalPreview.getPreviewAnalysis(preview_id || 'latest'));
    })
  );

  server.registerTool(
    'compare_analysis_iterations',
    {
      title: 'Compare Analysis Iterations',
      description: 'Compare two normal CAS analyses or return the comparison payload for a proposal preview.',
      inputSchema: {
        preview_id: z.string().optional().describe('Existing preview id to compare'),
        baseline_path: z.string().optional().describe('Path for baseline stored analysis'),
        proposed_path: z.string().optional().describe('Path for proposed stored analysis'),
        diff_text: z.string().optional().describe('Optional diff used to focus impact checks'),
        files: z.array(z.string()).optional().describe('Optional changed files used to focus impact checks'),
      } as any,
    } as any,
    async ({ preview_id, baseline_path, proposed_path, diff_text, files }: any) => withErrorHandling(async () => {
      return json(await proposalPreview.compareAnalysisIterations({
        previewId: preview_id,
        baselinePath: baseline_path,
        proposedPath: proposed_path,
        diffText: diff_text,
        files,
      }));
    })
  );

  server.registerTool(
    'get_analysis_freshness',
    {
      title: 'Get Analysis Freshness',
      description: 'Check whether stored CAS is fresh relative to source file mtimes and incremental state.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      return json(await freshness.getAnalysisFreshness(path));
    })
  );

  server.registerTool(
    'get_test_discovery_evidence',
    {
      title: 'Get Test Discovery Evidence',
      description: 'Distinguish CAS-covered tests, missed source tests, and repos with no source test files by scanning test paths and names.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await testDiscovery.getTestDiscoveryEvidence(path, cas));
    })
  );

  server.registerTool(
    'save_cas_golden_snapshot',
    {
      title: 'Save CAS Golden Snapshot',
      description: 'Persist the current stable CAS shape snapshot for regression checks.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const snapshot = casContract.buildCASGoldenSnapshot(cas);
      const saved = await saveGoldenSnapshot(path, snapshot);
      return json({ saved, snapshot });
    })
  );

  server.registerTool(
    'compare_cas_golden_snapshot',
    {
      title: 'Compare CAS Golden Snapshot',
      description: 'Compare current CAS shape against the saved golden snapshot for this repository.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const saved = await loadGoldenSnapshot(path);
      if (!saved) return json({ status: 'warn', gates: [], detail: 'No saved CAS golden snapshot' });
      const gates = casContract.compareCASGoldenSnapshot(cas, saved.snapshot as any);
      return json({
        status: gates.some(gate => gate.status === 'fail') ? 'fail' : gates.some(gate => gate.status === 'warn') ? 'warn' : 'pass',
        saved_at: saved.saved_at,
        gates,
      });
    })
  );

  // -- System-Level Understanding --

  server.registerTool(
    'get_summary',
    {
      title: 'Get Summary',
      description: 'Get condensed intelligence summary of an analyzed codebase. Includes system purpose, flow graph highlights (top 15 capabilities by score), architecture summary, database entities, entry point breakdown, node/edge counts, and analyzer contributions. This is the first tool to call to orient on a codebase.',
      inputSchema: { path: z.string().describe('Project path (must be previously analyzed)') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.buildSummary(cas));
    })
  );

  server.registerTool(
    'get_system_overview',
    {
      title: 'Get System Overview',
      description: 'Full system metadata: system info, architecture summary, system purpose, capabilities, progressive levels, analyzer contributions, configuration, runtime, errors, validation.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getSystemOverview(cas));
    })
  );

  server.registerTool(
    'get_architecture_context',
    {
      title: 'Get Architecture Context',
      description: 'Compact architecture guidance for agents. Returns detected architecture patterns, MVC/MVVM/repository/mediator/unit-of-work/singleton inventory counts and examples, target-relevant owners, a pattern decision matrix, pattern-balance risks, and rules to preserve local architecture.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Optional node, file, or feature target to focus architecture owners'),
        files: z.array(z.string()).optional().describe('Optional changed or planned files to focus architecture owners'),
        limit: z.number().optional().describe('Maximum patterns to include'),
      } as any,
    } as any,
    async ({ path, target, files, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(agentAdoption.buildArchitectureContextForAgent(cas, { target, files, limit }));
    })
  );

  server.registerTool(
    'list_answer_packs',
    {
      title: 'List Answer Packs',
      description: 'List deterministic MCP answer packs. Answer packs are curated question sets that prove a codebase can be explained from CAS with evidence.',
      inputSchema: {} as any,
    } as any,
    async () => withErrorHandling(async () => {
      return json(product.getAnswerPackCatalog());
    })
  );

  server.registerTool(
    'run_answer_pack',
    {
      title: 'Run Answer Pack',
      description: 'Answer core product questions from CAS using MCP query surfaces. Returns structured answers with evidence references, confidence, follow-up tools, and gaps.',
      inputSchema: {
        path: z.string().describe('Project path'),
        pack: z.string().optional().describe('Answer pack id (default: mastery)'),
      } as any,
    } as any,
    async ({ path, pack }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(product.runAnswerPack(cas, path, pack));
    })
  );

  server.registerTool(
    'get_mcp_demo_flow',
    {
      title: 'Get MCP Demo Flow',
      description: 'Agent-facing customer demo flow: exact MCP tool sequence plus representative CAS-backed outputs for explaining a codebase without UI.',
      inputSchema: {
        path: z.string().describe('Project path'),
        related_paths: z.array(z.string()).optional().describe('Optional related repos to include in the cross-repo step'),
      } as any,
    } as any,
    async ({ path, related_paths }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(product.buildMcpDemoFlow(cas, path, related_paths || []));
    })
  );

  server.registerTool(
    'get_cross_repo_links',
    {
      title: 'Get Cross-Repo Links',
      description: 'Discover deterministic relationships across analyzed repositories: API calls, shared databases, message contracts, and shared internal libraries.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Project paths to link. Omit to use all analyzed repositories.'),
      } as any,
    } as any,
    async ({ paths }: any) => withErrorHandling(async () => {
      const repositories = await loadRepositoryAnalyses(paths);
      return json(product.buildCrossRepositoryLinks(repositories));
    })
  );

  server.registerTool(
    'save_workspace_graph',
    {
      title: 'Save Workspace Graph',
      description: 'Build and persist a multi-repository workspace graph with cross-repo links, repository contracts, confidence, conflicts, and review decisions.',
      inputSchema: {
        name: z.string().optional().describe('Workspace graph name. Defaults to analyzed-workspace.'),
        paths: z.array(z.string()).optional().describe('Project paths to include. Omit to use all analyzed repositories.'),
      } as any,
    } as any,
    async ({ name, paths }: any) => withErrorHandling(async () => {
      const repositories = await loadRepositoryAnalyses(paths);
      const graphName = name || 'analyzed-workspace';
      const existing = await loadWorkspaceGraph(graphName);
      const graph = workspaceGraph.buildWorkspaceGraph(graphName, repositories, existing);
      const saved = await saveWorkspaceGraph(graph);
      return json({ saved, summary: workspaceGraph.summarizeWorkspaceGraph(graph), graph });
    })
  );

  server.registerTool(
    'get_workspace_graph',
    {
      title: 'Get Workspace Graph',
      description: 'Load a persisted multi-repository workspace graph by id or name.',
      inputSchema: {
        workspace_id_or_name: z.string().describe('Workspace graph id or name'),
      } as any,
    } as any,
    async ({ workspace_id_or_name }: any) => withErrorHandling(async () => {
      const graph = await loadWorkspaceGraph(workspace_id_or_name);
      if (!graph) return json({ error: `Workspace graph not found: ${workspace_id_or_name}` });
      return json({ summary: workspaceGraph.summarizeWorkspaceGraph(graph), graph });
    })
  );

  server.registerTool(
    'list_workspace_graphs',
    {
      title: 'List Workspace Graphs',
      description: 'List persisted multi-repository workspace graphs.',
      inputSchema: {} as any,
    } as any,
    async () => withErrorHandling(async () => {
      return json(await listWorkspaceGraphs());
    })
  );

  server.registerTool(
    'verify_workspace_link',
    {
      title: 'Verify Workspace Link',
      description: 'Mark a persisted workspace graph link as verified, rejected, or unreviewed while preserving the detected graph evidence.',
      inputSchema: {
        workspace_id_or_name: z.string().describe('Workspace graph id or name'),
        link_id: z.string().describe('Cross-repository link id'),
        decision: z.enum(['unreviewed', 'verified', 'rejected']).describe('Review decision'),
        reason: z.string().optional().describe('Reason or evidence for the decision'),
        actor: z.string().optional().describe('Person or agent recording the decision'),
      } as any,
    } as any,
    async ({ workspace_id_or_name, link_id, decision, reason, actor }: any) => withErrorHandling(async () => {
      const graph = await loadWorkspaceGraph(workspace_id_or_name);
      if (!graph) return json({ error: `Workspace graph not found: ${workspace_id_or_name}` });
      const updated = workspaceGraph.applyWorkspaceGraphDecision(graph, link_id, decision, { reason, actor });
      const saved = await saveWorkspaceGraph(updated);
      return json({ saved, summary: workspaceGraph.summarizeWorkspaceGraph(updated), graph: updated });
    })
  );

  server.registerTool(
    'get_agent_bootstrap',
    {
      title: 'Get Agent Bootstrap',
      description: 'Single default agent-start payload. Returns readiness, start context, tool plan, work packet, and a ready-to-use prompt for Codex, Claude, Cursor, or any coding agent.',
      inputSchema: {
        path: z.string().describe('Project path'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
        }).optional().describe('Optional task context for tailoring the default bootstrap'),
      } as any,
    } as any,
    async ({ path, task }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await agentBootstrap.getAgentBootstrap(cas, path, task || {}));
    })
  );

  server.registerTool(
    'get_agent_project_map',
    {
      title: 'Get Agent Project Map',
      description: 'List analyzed parent/subproject candidates for a repository path so agents can choose the most specific default-use CAS analysis before broad file reads.',
      inputSchema: {
        path: z.string().optional().describe('Repository or subproject path to filter candidates. Omit to map all stored analyses.'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
        }).optional().describe('Optional task context used to score target matches.'),
        limit: z.number().optional().describe('Maximum candidates to return'),
      } as any,
    } as any,
    async ({ path, task, limit }: any) => withErrorHandling(async () => {
      return json(await agentProjectMap.getAgentProjectMap({ path, task: task || {}, limit }));
    })
  );

  server.registerTool(
    'resolve_agent_analysis',
    {
      title: 'Resolve Agent Analysis',
      description: 'Call this FIRST, before any Read/Grep/Glob exploration of a repository: one call tells you whether a pre-built code analysis (architecture graph, entry points, risks, tests) exists for this path and selects the best one, including routing monorepo roots to the right analyzed subproject. If an analysis exists, the follow-up tools replace dozens of exploratory file reads; if none exists, this reports that honestly so you can fall back to reading files. Costs one cheap call either way.',
      inputSchema: {
        path: z.string().describe('Repository or subproject path the agent was handed'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
        }).optional().describe('Optional task context used to score the selected analysis'),
      } as any,
    } as any,
    async ({ path, task }: any) => withErrorHandling(async () => {
      return json(await agentProjectMap.resolveAgentAnalysis({ path, task: task || {} }));
    })
  );

  server.registerTool(
    'get_agent_doctor',
    {
      title: 'Get Agent Doctor',
      description: 'Default-use readiness check for Codex, Claude, and other agents: CAS contract, freshness, tests, runtime SDK proof, and golden snapshot status.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await agentDoctor.getAgentDoctor(cas, path));
    })
  );

  server.registerTool(
    'get_agent_default_config',
    {
      title: 'Get Agent Default Config',
      description: 'Return install-ready default-use instructions for Codex, Claude, Cursor, or another coding agent without writing files.',
      inputSchema: {
        path: z.string().describe('Project path'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
        }).optional().describe('Optional task context for tailoring default-use instructions'),
      } as any,
    } as any,
    async ({ path, task }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await agentDefaults.getAgentDefaultConfig(cas, path, task || {}));
    })
  );

  server.registerTool(
    'install_agent_default_config',
    {
      title: 'Install Agent Default Config',
      description: 'Write .klauro/agent-defaults.json and .klauro/agent-defaults.md into a repository so agents have a default Klauro start path.',
      inputSchema: {
        path: z.string().describe('Project path'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
        }).optional().describe('Optional task context for tailoring default-use instructions'),
      } as any,
    } as any,
    async ({ path, task }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await agentDefaults.writeAgentDefaultConfig(cas, path, task || {}));
    })
  );

  server.registerTool(
    'get_agent_start_context',
    {
      title: 'Get Agent Start Context',
      description: 'Call this BEFORE reading or grepping files in an analyzed repository — it replaces the first 20-40 exploratory Read/Grep/Glob calls with one response: the architecture map, entry points, key risks, top graph anchors, analysis readiness, and the recommended next calls for your task. This is the fastest way to orient in a codebase you have not seen before. Use after resolve_agent_analysis confirms an analysis exists.',
      inputSchema: {
        path: z.string().describe('Project path'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
        }).optional().describe('Optional task context for tailoring the default MCP path'),
      } as any,
    } as any,
    async ({ path, task }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(agentAdoption.getAgentStartContext(cas, path, task || {}));
    })
  );

  server.registerTool(
    'get_agent_tool_plan',
    {
      title: 'Get Agent Tool Plan',
      description: 'Returns the exact sequence of analysis calls for your task type (orient, modify, debug, review, trace, cross-repo, runtime) so you do not have to guess which files to grep or which tools to chain. Call this instead of planning a manual file-exploration strategy; the pre-built code graph narrows the work area before you open a single file.',
      inputSchema: {
        path: z.string().describe('Project path'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
        }).optional().describe('Task context for selecting a plan'),
      } as any,
    } as any,
    async ({ path, task }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(agentAdoption.getAgentToolPlan(cas, { path, task: task || {} }));
    })
  );

  server.registerTool(
    'get_agent_work_packet',
    {
      title: 'Get Agent Work Packet',
      description: 'One call that does the work of an entire exploratory session: describe your task ("add an audit trail for driver status changes") and it resolves the target code, change risk, callers and callees, covering tests, behavioral invariants, and the exact source files to read first. Use this instead of grepping for symbols and tracing imports by hand — it turns a 40-call investigation into one call plus a handful of targeted reads. Requires an existing analysis (check with resolve_agent_analysis).',
      inputSchema: {
        path: z.string().describe('Project path'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
        }).optional().describe('Task context for building the work packet'),
      } as any,
    } as any,
    async ({ path, task }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await agentAdoption.getAgentWorkPacket(cas, path, task || {}));
    })
  );

  server.registerTool(
    'get_capability_memory',
    {
      title: 'Get Capability Memory',
      description: 'Find existing analyzed capabilities that overlap the requested work so agents avoid rebuilding behavior that already exists. Use before adding new services, routes, workers, models, packages, or greenfield-adjacent features in an existing codebase.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Capability, file, node, route, domain, or user-requested feature to compare against existing CAS capabilities'),
        instructions: z.string().optional().describe('Task or plan text to match against existing capabilities'),
        success_criteria: z.array(z.string()).optional().describe('Expected outcomes to include in overlap matching'),
        files: z.array(z.string()).optional().describe('Known files involved in the work'),
        limit: z.number().optional().describe('Maximum capabilities to return'),
      } as any,
    } as any,
    async ({ path, target, instructions, success_criteria, files, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(agentAdoption.buildCapabilityMemoryForAgent(cas, {
        target,
        instructions,
        success_criteria,
        files,
        limit,
      }));
    })
  );

  server.registerTool(
    'get_idiom_aware_work_packet',
    {
      title: 'Get Idiom-Aware Work Packet',
      description: 'One-call agent work packet with compact repo-local idiom context. Use for edits where matching local naming, placement, boundaries, testing, migrations, and framework style matters.',
      inputSchema: {
        path: z.string().describe('Project path'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
        }).optional().describe('Task context for building the work packet'),
      } as any,
    } as any,
    async ({ path, task }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const packet = await agentAdoption.getAgentWorkPacket(cas, path, task || {});
      return json({
        ...packet,
        idiom_context: (packet.work_context as any).idiom_context,
      });
    })
  );

  server.registerTool(
    'open_agent_workbench',
    {
      title: 'Open Agent Workbench',
      description: 'Product-level agent workspace for a task: orientation, target resolution, file-read plan, repo rules, evidence policy, validation plan, and next MCP calls. Use before broad source exploration.',
      inputSchema: {
        path: z.string().describe('Project path'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
          change_type: z.enum(['add', 'modify', 'delete', 'refactor', 'rename', 'schema', 'test']).optional(),
          files: z.array(z.string()).optional(),
          diff_text: z.string().optional(),
          plan_text: z.string().optional(),
        }).optional().describe('Task context for the agent workbench'),
      } as any,
    } as any,
    async ({ path, task }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await agentWorkflow.openAgentWorkbench(cas, path, task || {}));
    })
  );

  server.registerTool(
    'preflight_agent_change',
    {
      title: 'Preflight Agent Change',
      description: 'Before an agent edits or presents a plan, evaluate whether the proposed change fits the codebase model, idioms, invariants, tests, migrations, auth/tenant boundaries, and risk surface.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Node id, file path, or natural language target'),
        plan_text: z.string().optional().describe('Agent plan text to evaluate'),
        diff_text: z.string().optional().describe('Optional unified diff to evaluate'),
        files: z.array(z.string()).optional().describe('Optional changed/proposed files'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
          change_type: z.enum(['add', 'modify', 'delete', 'refactor', 'rename', 'schema', 'test']).optional(),
          files: z.array(z.string()).optional(),
          diff_text: z.string().optional(),
          plan_text: z.string().optional(),
        }).optional().describe('Optional task context'),
      } as any,
    } as any,
    async ({ path, target, plan_text, diff_text, files, task }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await agentWorkflow.preflightAgentChange(cas, path, {
        target,
        planText: plan_text,
        diffText: diff_text,
        files,
        task,
        includeWorkingTree: false,
      }));
    })
  );

  server.registerTool(
    'get_codebase_agent_rules',
    {
      title: 'Get Codebase Agent Rules',
      description: 'Generate a living, CAS-backed guide for how agents should work in this repository: architecture rules, idioms, invariant rules, testing rules, and evidence policy.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Optional node id, file path, or natural language target'),
        files: z.array(z.string()).optional().describe('Optional files to focus rules on'),
        limit: z.number().optional().describe('Max idioms/invariants to include'),
      } as any,
    } as any,
    async ({ path, target, files, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(agentWorkflow.buildCodebaseAgentRules(cas, path, { target, files, limit }));
    })
  );

  server.registerTool(
    'explain_change_shape',
    {
      title: 'Explain Change Shape',
      description: 'Explain what a proposed or actual diff means in graph terms: changed files, touched CAS nodes, impacted tests, idioms, invariants, boundaries, and missing checks.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Optional target node id, file path, or search text'),
        plan_text: z.string().optional().describe('Optional plan text'),
        diff_text: z.string().optional().describe('Optional unified diff'),
        files: z.array(z.string()).optional().describe('Optional changed/proposed files'),
      } as any,
    } as any,
    async ({ path, target, plan_text, diff_text, files }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(agentWorkflow.explainChangeShape(cas, path, {
        target,
        planText: plan_text,
        diffText: diff_text,
        files,
      }));
    })
  );

  server.registerTool(
    'validate_agent_change',
    {
      title: 'Validate Agent Change',
      description: 'Post-edit validation for agents. Validates the working tree, explicit files, or diff text against repo-local idioms, behavioral invariants, migrations, tests, and change shape before finalizing.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Optional node id, file path, or natural language target'),
        diff_text: z.string().optional().describe('Optional unified diff to validate'),
        files: z.array(z.string()).optional().describe('Optional changed files to validate instead of reading working tree'),
        include_working_tree: z.boolean().optional().describe('When true and no files/diff are supplied, validate git working tree. Default true.'),
        plan_text: z.string().optional().describe('Optional original plan text for context'),
      } as any,
    } as any,
    async ({ path, target, diff_text, files, include_working_tree, plan_text }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(agentWorkflow.validateAgentChange(cas, path, {
        target,
        diffText: diff_text,
        files,
        includeWorkingTree: include_working_tree,
        planText: plan_text,
      }));
    })
  );

  server.registerTool(
    'evaluate_analysis_truth',
    {
      title: 'Evaluate Analysis Truth',
      description: 'Compare CAS against explicit ground-truth expectations for frameworks, languages, routes, nodes, data entities, relationships, and runtime signals.',
      inputSchema: {
        path: z.string().describe('Project path'),
        expectation: z.object({
          name: z.string().optional(),
          frameworks: z.array(z.string()).optional(),
          languages: z.array(z.string()).optional(),
          routes: z.array(z.object({
            method: z.string().optional(),
            path: z.string(),
            handler: z.string().optional(),
            controller: z.string().optional(),
          })).optional(),
          nodes: z.array(z.object({
            name: z.string(),
            type: z.string().optional(),
            file: z.string().optional(),
          })).optional(),
          data_entities: z.array(z.string()).optional(),
          relationships: z.array(z.object({
            source: z.string(),
            target: z.string(),
            type: z.string().optional(),
          })).optional(),
          runtime_signals: z.array(z.string()).optional(),
        }).optional().describe('Ground-truth expectations. If omitted, MCP tries repo-local .klauro/analysis-expectations.json.'),
      } as any,
    } as any,
    async ({ path, expectation }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const loadedExpectation = expectation || await analysisMastery.loadTruthExpectation(path);
      if (!loadedExpectation) return json({ error: 'No expectation provided and no repo-local analysis expectation file found.' });
      return json(analysisMastery.evaluateAnalysisTruth(cas, loadedExpectation));
    })
  );

  server.registerTool(
    'get_semantic_map',
    {
      title: 'Get Semantic Map',
      description: 'Return a CAS-derived symbol and data map: files, imports, exports, entry/exit ownership, data entities, relationships, and method calls. Use when source-level semantics matter before reading files.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Optional target query to narrow the semantic map'),
        limit: z.number().optional().describe('Max matching nodes to include'),
      } as any,
    } as any,
    async ({ path, target, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(analysisMastery.getSemanticMap(cas, { target, limit }));
    })
  );

  server.registerTool(
    'get_framework_depth_report',
    {
      title: 'Get Framework Depth Report',
      description: 'Score detected frameworks by analyzer presence, framework-tagged nodes, entry points, evidence, runtime links, and expected framework-specific surfaces.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(analysisMastery.getFrameworkDepthReport(cas));
    })
  );

  server.registerTool(
    'get_integration_depth_report',
    {
      title: 'Get Integration Depth Report',
      description: 'Detect deeper library and platform integrations such as jobs, brokers, auth, payments, AI SDKs, infrastructure, observability, cache, and persistence; reports coverage and missing analyzer depth.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(integrationDepth.getIntegrationDepthReport(cas));
    })
  );

  server.registerTool(
    'get_cross_repo_contracts',
    {
      title: 'Get Cross Repo Contracts',
      description: 'Build contract-level views across repositories: provided HTTP/message/database contracts, consumed APIs/messages/databases, deterministic links, a contract table (route, consumer file, provider handler), cross-repo journeys (UI action file -> HTTP call -> backend route -> service -> terminal entity), route drift findings (repo-relative API calls with no matching backend route, classified missing-route vs near-miss with the nearest backend route; summary count plus top 10), and contract gaps.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Project paths to include. Omit to use all analyzed repositories.'),
        journey_limit: z.number().optional().describe('Max cross-repo journeys to compose (default 25).'),
      } as any,
    } as any,
    async ({ paths, journey_limit }: any) => withErrorHandling(async () => {
      const repositories = await loadRepositoryAnalyses(paths);
      return json(analysisMastery.getCrossRepoContracts(repositories, { journey_limit }));
    })
  );

  server.registerTool(
    'get_runtime_instrumentation_plan',
    {
      title: 'Get Runtime Instrumentation Plan',
      description: 'Turn CAS runtime_static_links into concrete runtime event contracts and instrumentation points for correlating production behavior back to CAS.',
      inputSchema: {
        path: z.string().describe('Project path'),
        limit: z.number().optional().describe('Max instrumentation points to return'),
      } as any,
    } as any,
    async ({ path, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(analysisMastery.getRuntimeInstrumentationPlan(cas, { limit }));
    })
  );

  server.registerTool(
    'get_runtime_event_contract',
    {
      title: 'Get Runtime Event Contract',
      description: 'Return the canonical runtime event schema and CAS-specific event payloads that SDKs should emit so production telemetry can correlate back to CAS.',
      inputSchema: {
        path: z.string().describe('Project path'),
        limit: z.number().optional().describe('Max CAS runtime link contracts to include'),
      } as any,
    } as any,
    async ({ path, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(runtimeContract.getRuntimeEventContract(cas, { limit }));
    })
  );

  server.registerTool(
    'get_runtime_sdk_package',
    {
      title: 'Get Runtime SDK Package',
      description: 'Generate a TypeScript runtime telemetry SDK package from the CAS runtime event contract, including client, middleware, fetch wrapper, and contract file.',
      inputSchema: {
        path: z.string().describe('Project path'),
        limit: z.number().optional().describe('Max CAS runtime link contracts to include in the generated contract file'),
      } as any,
    } as any,
    async ({ path, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(runtimeSdk.getRuntimeSdkPackage(cas, { limit }));
    })
  );

  server.registerTool(
    'evaluate_agent_task_proof',
    {
      title: 'Evaluate Agent Task Proof',
      description: 'Run agent work packets for representative tasks and score whether CAS gives agents enough target, risk, test, MCP, and file-read context to start work.',
      inputSchema: {
        path: z.string().describe('Project path'),
        tasks: z.array(z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
        })).optional().describe('Tasks to evaluate. Defaults to an orient task.'),
      } as any,
    } as any,
    async ({ path, tasks }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await analysisMastery.evaluateAgentTaskProof(cas, path, tasks || [{ task_type: 'orient' }]));
    })
  );

  server.registerTool(
    'evaluate_agent_readiness',
    {
      title: 'Evaluate Agent Readiness',
      description: 'Score whether CAS/MCP is strong enough for agents to use by default on this repository. Checks graph quality, answerability, evidence, tests, runtime links, and safety surfaces.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const evidence = await testDiscovery.getTestDiscoveryEvidence(path, cas);
      return json(agentAdoption.evaluateAgentReadiness(cas, path, { testEvidence: evidence }));
    })
  );

  server.registerTool(
    'run_agentic_benchmark',
    {
      title: 'Run Agentic Benchmark',
      description: 'Benchmark the same agent task with Klauro vs without Klauro using deterministic token/file/speed estimates and a two-agent live-run protocol.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Project paths to benchmark. Omit to use all analyzed repositories.'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
        }).optional().describe('Task to hand to both agents. Defaults to fixture-derived representative tasks.'),
        suite: z.boolean().optional().describe('Generate several CAS-derived task cards per repository.'),
        max_tasks_per_repo: z.number().optional().describe('Maximum generated suite tasks per repository'),
      } as any,
    } as any,
    async ({ paths, task, suite, max_tasks_per_repo }: any) => withErrorHandling(async () => {
      const selectedPaths = paths && paths.length > 0 ? paths : (await listAnalyses()).map(analysis => analysis.path);
      const report = await runAgenticBenchmark({
        repos: selectedPaths.map((repoPath: string) => ({ path: repoPath })),
        includeFixtures: false,
        task: task || undefined,
        suite: Boolean(suite),
        maxTasksPerRepo: max_tasks_per_repo,
        quiet: true,
      });
      const saved = await saveAgenticBenchmarkReport(report);
      return json({ saved, report, markdown: formatMarkdownReport(report) });
    })
  );

  server.registerTool(
    'get_agentic_benchmark_report',
    {
      title: 'Get Agentic Benchmark Report',
      description: 'Load persisted agentic benchmark reports. Use id=latest for the latest report.',
      inputSchema: {
        id: z.string().optional().describe('Benchmark report id. Defaults to latest.'),
        benchmark_type: z.string().optional().describe('When loading latest or listing, restrict to an exact benchmark_type such as agentic-suite-with-klauro-vs-without-klauro, deterministic-agent-quality-proxy, live-agent-quality-ab, or incremental-analysis-agent-value.'),
        list: z.boolean().optional().describe('When true, list reports instead of loading one.'),
      } as any,
    } as any,
    async ({ id, benchmark_type, list }: any) => withErrorHandling(async () => {
      if (list) return json(await listAgenticBenchmarkReports({ benchmarkType: benchmark_type }));
      const report = benchmark_type && (!id || id === 'latest')
        ? await loadLatestAgenticBenchmarkReportByType(benchmark_type)
        : await loadAgenticBenchmarkReport(id || 'latest');
      if (!report) return json({ error: `Agentic benchmark report not found: ${id || 'latest'}` });
      if (benchmark_type && report.benchmark_type !== benchmark_type) {
        return json({ error: `Agentic benchmark report ${id || 'latest'} has benchmark_type ${report.benchmark_type || 'unknown'}, not ${benchmark_type}` });
      }
      return json({ report, markdown: formatStoredBenchmarkReport(report) });
    })
  );

  server.registerTool(
    'get_agent_performance_proof',
    {
      title: 'Get Agent Performance Proof',
      description: 'Summarize persisted agent benchmarks into the current evidence that Klauro saves tokens, speeds agents up, preserves or improves quality, and keeps incremental analysis useful after edits.',
      inputSchema: {
        benchmark_types: z.array(z.string()).optional().describe('Exact benchmark_type values to include. Omit to include all persisted types.'),
        max_reports: z.number().optional().describe('Maximum persisted reports to inspect before grouping by latest benchmark type. Default 25.'),
        since_days: z.number().optional().describe('Only include reports generated within this many days. Defaults to 7. Use 0 to include all persisted reports.'),
      } as any,
    } as any,
    async ({ benchmark_types, max_reports, since_days }: any) => withErrorHandling(async () => {
      const benchmarkTypes = Array.isArray(benchmark_types) ? new Set(benchmark_types) : null;
      const sinceDays = since_days ?? 7;
      const summaries = (await listAgenticBenchmarkReports())
        .filter(summary => !benchmarkTypes || benchmarkTypes.has(summary.benchmark_type || ''))
        .filter(summary => reportSummaryWithinWindow(summary, sinceDays))
        .slice(0, max_reports || 25);
      const reports = [];
      for (const summary of summaries) {
        const report = await loadAgenticBenchmarkReport(summary.id);
        if (report) reports.push(report);
      }
      return json(buildAgentPerformanceProof(reports, { sinceDays }));
    })
  );

  server.registerTool(
    'run_agent_quality_benchmark',
    {
      title: 'Run Agent Quality Benchmark',
      description: 'Run the work-quality benchmark layer: success gates, context completeness, projected patch quality, token/time/file deltas, and optional live A/B agent command execution.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Project paths to benchmark. Omit to use all analyzed repositories.'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
        }).optional().describe('Single task to hand to both agents. Omit to generate a suite.'),
        max_tasks_per_repo: z.number().optional().describe('Maximum generated suite tasks per repository'),
        agent_with_command: z.string().optional().describe('Live with-Klauro agent command template. Supports {workspace}, {prompt_file}, {metrics_file}, {result_file}, {arm}, and {task_id}.'),
        agent_without_command: z.string().optional().describe('Live without-Klauro agent command template. Supports {workspace}, {prompt_file}, {metrics_file}, {result_file}, {arm}, and {task_id}.'),
        orchestrator_command: z.string().optional().describe('Optional evaluator command template. Supports {evaluation_input}, {evaluation_file}, {with_workspace}, {without_workspace}, {with_diff}, and {without_diff}.'),
        test_command: z.string().optional().describe('Optional command to run inside each copied repo after the agent attempt.'),
        work_root: z.string().optional().describe('Directory for live repo copies and benchmark artifacts.'),
        max_live_tasks: z.number().optional().describe('Maximum task pairs to run through live agents.'),
        live_task_types: z.array(z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime'])).optional().describe('Only run live pairs for these task types.'),
        live_task_categories: z.array(z.string()).optional().describe('Only run live pairs for these generated task categories, such as modify, debug, review, trace, data, external, runtime, or test.'),
        timeout_ms: z.number().optional().describe('Per-agent command timeout in milliseconds.'),
        test_timeout_ms: z.number().optional().describe('Per-test command timeout in milliseconds.'),
        orchestrator_timeout_ms: z.number().optional().describe('Evaluator command timeout in milliseconds.'),
      } as any,
    } as any,
    async ({ paths, task, max_tasks_per_repo, agent_with_command, agent_without_command, orchestrator_command, test_command, work_root, max_live_tasks, live_task_types, live_task_categories, timeout_ms, test_timeout_ms, orchestrator_timeout_ms }: any) => withErrorHandling(async () => {
      const selectedPaths = paths && paths.length > 0 ? paths : (await listAnalyses()).map(analysis => analysis.path);
      const report = await runAgentQualityBenchmark({
        repos: selectedPaths.map((repoPath: string) => ({ path: repoPath })),
        maxTasksPerRepo: max_tasks_per_repo,
        task: task || undefined,
        commands: {
          withKlauro: agent_with_command,
          withoutKlauro: agent_without_command,
          orchestrator: orchestrator_command,
          testCommand: test_command,
          workRoot: work_root,
          maxLiveTasks: max_live_tasks,
          liveTaskTypes: live_task_types,
          liveTaskCategories: live_task_categories,
          timeoutMs: timeout_ms,
          testTimeoutMs: test_timeout_ms,
          orchestratorTimeoutMs: orchestrator_timeout_ms,
        },
        live: Boolean(agent_with_command || agent_without_command),
        quiet: true,
      });
      const saved = await saveAgenticBenchmarkReport(report);
      return json({ saved, report, markdown: formatQualityMarkdownReport(report) });
    })
  );

  server.registerTool(
    'run_agent_idiom_benchmark',
    {
      title: 'Run Agent Idiom Benchmark',
      description: 'Run copied-repo A/B idiom quality tasks where both agents can pass correctness, but the with-Klauro arm receives CAS idiom context. Scores correctness, idiom conformance, minimality, test relevance, boundary preservation, and file targeting.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Project paths to benchmark. Omit to use all analyzed repositories.'),
        max_targets: z.number().optional().describe('Maximum repositories to benchmark'),
        max_tasks_per_repo: z.number().optional().describe('Maximum generated idiom tasks per repository'),
        agent_with_command: z.string().optional().describe('Live with-Klauro agent command template. Supports {workspace}, {prompt_file}, {metrics_file}, {result_file}, {arm}, and {task_id}.'),
        agent_without_command: z.string().optional().describe('Live without-Klauro agent command template. Supports {workspace}, {prompt_file}, {metrics_file}, {result_file}, {arm}, and {task_id}.'),
        orchestrator_command: z.string().optional().describe('Optional evaluator command template. Supports {evaluation_input}, {evaluation_file}, {with_workspace}, {without_workspace}, {with_diff}, and {without_diff}.'),
        test_command: z.string().optional().describe('Optional command to run inside each copied repo after the agent attempt.'),
        work_root: z.string().optional().describe('Directory for live repo copies and benchmark artifacts.'),
        max_live_tasks: z.number().optional().describe('Maximum task pairs to run through live agents.'),
        timeout_ms: z.number().optional().describe('Per-agent command timeout in milliseconds.'),
        test_timeout_ms: z.number().optional().describe('Per-test command timeout in milliseconds.'),
        orchestrator_timeout_ms: z.number().optional().describe('Evaluator command timeout in milliseconds.'),
      } as any,
    } as any,
    async ({ paths, max_targets, max_tasks_per_repo, agent_with_command, agent_without_command, orchestrator_command, test_command, work_root, max_live_tasks, timeout_ms, test_timeout_ms, orchestrator_timeout_ms }: any) => withErrorHandling(async () => {
      const selectedPaths = paths && paths.length > 0 ? paths : (await listAnalyses()).map(analysis => analysis.path);
      const report = await runAgentIdiomBenchmark({
        repos: selectedPaths.map((repoPath: string) => ({ path: repoPath })),
        maxTargets: max_targets,
        maxTasksPerRepo: max_tasks_per_repo,
        commands: {
          withKlauro: agent_with_command,
          withoutKlauro: agent_without_command,
          orchestrator: orchestrator_command,
          testCommand: test_command,
          workRoot: work_root,
          maxLiveTasks: max_live_tasks,
          timeoutMs: timeout_ms,
          testTimeoutMs: test_timeout_ms,
          orchestratorTimeoutMs: orchestrator_timeout_ms,
        },
        live: Boolean(agent_with_command || agent_without_command),
        quiet: true,
      });
      const saved = await saveAgenticBenchmarkReport(report);
      return json({ saved, report, markdown: formatIdiomBenchmarkMarkdown(report) });
    })
  );

  server.registerTool(
    'run_machine_agent_proof',
    {
      title: 'Run Machine Agent Proof',
      description: 'Discover every real Git repo under a dev root, account for unsupported/skipped repos, run analysis/readiness/idiom/incremental checks on eligible repos, and require live idiom A/B proof when agent commands are supplied.',
      inputSchema: {
        dev_root: z.string().optional().describe('Root to discover real Git repos under. Defaults to ~/dev.'),
        mode: z.enum(['fast', 'full']).optional().describe('fast samples eligible repos with resource budgets; full analyzes every eligible repo.'),
        max_targets: z.number().optional().describe('Limit eligible repos for expensive checks while still reporting all discovered repos.'),
        max_source_files: z.number().optional().describe('Skip eligible repos above this source-file count for expensive checks while still reporting them.'),
        work_root: z.string().optional().describe('Directory for copied repo workspaces and benchmark artifacts.'),
        no_live: z.boolean().optional().describe('Skip live idiom A/B execution. The live proof gate remains failed when skipped.'),
        agent_with_command: z.string().optional().describe('Live with-Klauro agent command template.'),
        agent_without_command: z.string().optional().describe('Live without-Klauro agent command template.'),
        orchestrator_command: z.string().optional().describe('Optional external evaluator command template.'),
        test_command: z.string().optional().describe('Optional command to run inside each copied repo after the agent attempt.'),
        max_live_tasks: z.number().optional().describe('Maximum live idiom task pairs.'),
        timeout_ms: z.number().optional().describe('Per-agent command timeout in milliseconds.'),
        test_timeout_ms: z.number().optional().describe('Per-test command timeout in milliseconds.'),
        analysis_budget_ms: z.number().optional().describe('Per-selected-repo analysis budget gate.'),
        incremental_budget_ms: z.number().optional().describe('Per-selected-repo incremental edit budget gate.'),
      } as any,
    } as any,
    async ({ dev_root, mode, max_targets, max_source_files, work_root, no_live, agent_with_command, agent_without_command, orchestrator_command, test_command, max_live_tasks, timeout_ms, test_timeout_ms, analysis_budget_ms, incremental_budget_ms }: any) => withErrorHandling(async () => {
      const report = await runMachineAgentProof({
        devRoot: dev_root || `${process.env.HOME || ''}/dev`,
        mode,
        maxTargets: max_targets,
        maxSourceFiles: max_source_files,
        outputPath: '',
        markdownPath: '',
        workRoot: work_root,
        runLive: !no_live,
        agentWithCommand: agent_with_command,
        agentWithoutCommand: agent_without_command,
        orchestratorCommand: orchestrator_command,
        testCommand: test_command,
        maxLiveTasks: max_live_tasks,
        timeoutMs: timeout_ms,
        testTimeoutMs: test_timeout_ms,
        discardWorkspaces: true,
        analysisBudgetMs: analysis_budget_ms,
        incrementalBudgetMs: incremental_budget_ms,
      });
      return json(report);
    })
  );

  server.registerTool(
    'run_incremental_value_benchmark',
    {
      title: 'Run Incremental Value Benchmark',
      description: 'Copy repositories, run an initial analysis, rerun with no changes, edit one source file, rerun incremental analysis, optionally verify against a fresh full analysis, and report speed, correctness, cache, and agent work-packet value.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Project paths to benchmark. Omit to use all analyzed repositories.'),
        max_targets: z.number().optional().describe('Maximum repositories to benchmark'),
        work_root: z.string().optional().describe('Directory for copied repo workspaces and isolated benchmark storage.'),
        verify_full: z.boolean().optional().describe('Run a fresh full analysis after the edit and compare CAS count parity.'),
        discard_workspaces: z.boolean().optional().describe('Remove copied repositories after collecting results.'),
      } as any,
    } as any,
    async ({ paths, max_targets, work_root, verify_full, discard_workspaces }: any) => withErrorHandling(async () => {
      const selectedPaths = paths && paths.length > 0 ? paths : (await listAnalyses()).map(analysis => analysis.path);
      const report = await runIncrementalValueBenchmark({
        repos: selectedPaths.map((repoPath: string) => ({ path: repoPath })),
        maxTargets: max_targets,
        workRoot: work_root,
        verifyFull: Boolean(verify_full),
        keepWorkspaces: discard_workspaces ? false : true,
        quiet: true,
      });
      const saved = await saveAgenticBenchmarkReport(report);
      return json({ saved, report, markdown: formatIncrementalValueMarkdownReport(report) });
    })
  );

  server.registerTool(
    'get_patterns',
    {
      title: 'Get Patterns',
      description: 'Design patterns and anti-patterns detected in the codebase. Returns pattern summaries with instance counts and variation breakdowns. Use get_pattern_instances to drill into specific pattern instances.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getPatterns(cas));
    })
  );

  server.registerTool(
    'get_codebase_idioms',
    {
      title: 'Get Codebase Idioms',
      description: 'Repo-local conventions inferred from CAS: naming, file organization, module boundaries, dependency injection, data access, errors, validation, auth/tenant scope, logging, testing, migrations, async style, and configuration.',
      inputSchema: {
        path: z.string().describe('Project path'),
        category: z.enum(['naming', 'file-organization', 'module-boundary', 'dependency-injection', 'data-access', 'error-handling', 'validation', 'auth-tenant-scope', 'logging', 'testing', 'migrations', 'async-style', 'configuration']).optional().describe('Filter by idiom category'),
        target: z.string().optional().describe('Node id, file path, or text target to filter idioms'),
        min_confidence: z.number().optional().describe('Minimum idiom confidence, 0-1'),
        limit: z.number().optional().describe('Max results (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, category, target, min_confidence, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(idiomQuery.getCodebaseIdioms(cas, { category, target, minConfidence: min_confidence, limit, offset }));
    })
  );

  server.registerTool(
    'get_idiom_examples',
    {
      title: 'Get Idiom Examples',
      description: 'Return positive local examples for codebase idioms so agents can copy the repo style before editing.',
      inputSchema: {
        path: z.string().describe('Project path'),
        idiom_id: z.string().optional().describe('Specific idiom id from get_codebase_idioms'),
        category: z.enum(['naming', 'file-organization', 'module-boundary', 'dependency-injection', 'data-access', 'error-handling', 'validation', 'auth-tenant-scope', 'logging', 'testing', 'migrations', 'async-style', 'configuration']).optional().describe('Filter by idiom category'),
        target: z.string().optional().describe('Node id, file path, or text target to filter examples'),
        limit: z.number().optional().describe('Max results (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, idiom_id, category, target, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(idiomQuery.getIdiomExamples(cas, { idiomId: idiom_id, category, target, limit, offset }));
    })
  );

  server.registerTool(
    'validate_codebase_idioms',
    {
      title: 'Validate Codebase Idioms',
      description: 'Validate a working diff, explicit file list, or provided diff text against repo-local idioms. Use after edits to catch non-idiomatic naming, placement, testing, migration, logging, error-handling, and auth/tenant-scope drift.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Optional node id, file path, or text target'),
        category: z.enum(['naming', 'file-organization', 'module-boundary', 'dependency-injection', 'data-access', 'error-handling', 'validation', 'auth-tenant-scope', 'logging', 'testing', 'migrations', 'async-style', 'configuration']).optional().describe('Filter by idiom category'),
        files: z.array(z.string()).optional().describe('Explicit changed files to validate instead of reading the working tree'),
        diff_text: z.string().optional().describe('Optional unified diff text to validate'),
        include_working_tree: z.boolean().optional().describe('When false, validate only files/diff_text. Default true reads git working-tree and staged changes.'),
        min_confidence: z.number().optional().describe('Minimum idiom confidence, 0-1'),
        limit: z.number().optional().describe('Maximum impacted idioms to report'),
      } as any,
    } as any,
    async ({ path, target, category, files, diff_text, include_working_tree, min_confidence, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(idiomQuery.validateCodebaseIdioms(cas, path, {
        target,
        category,
        files,
        diffText: diff_text,
        includeWorkingTree: include_working_tree,
        minConfidence: min_confidence,
        limit,
      }));
    })
  );

  server.registerTool(
    'get_pattern_instances',
    {
      title: 'Get Pattern Instances',
      description: 'Get the node IDs that are instances of a specific pattern. Optionally filter by variation. Paginated.',
      inputSchema: {
        path: z.string().describe('Project path'),
        pattern_id: z.string().describe('Pattern ID from get_patterns results'),
        variation_id: z.string().optional().describe('Filter to a specific variation'),
        limit: z.number().optional().describe('Max results (default 50)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, pattern_id, variation_id, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const result = query.getPatternInstances(cas, pattern_id, { variation_id, limit, offset });
      if (!result) return json({ error: `Pattern not found: ${pattern_id}` });
      return json(result);
    })
  );

  server.registerTool(
    'get_perspectives',
    {
      title: 'Get Perspectives',
      description: 'Multi-view analysis perspectives with connection rules and layout hints.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getPerspectives(cas));
    })
  );

  // -- Navigation & Search --

  server.registerTool(
    'search_nodes',
    {
      title: 'Search Nodes',
      description: 'Use this instead of Grep to find where a class, function, route, service, or concept lives: it searches the pre-built code graph and returns ranked nodes with file locations, types, and relationships rather than raw text matches, so "driver status" finds the handler even when the literal string never appears. Supports lexical, semantic, and hybrid retrieval modes.',
      inputSchema: {
        path: z.string().describe('Project path'),
        query: z.string().describe('Search query (matches name, qualified_name, description)'),
        type: z.string().optional().describe('Filter by node type (e.g. class, function, module, service, controller)'),
        category: z.string().optional().describe('Filter by category'),
        level: z.number().optional().describe('Filter by hierarchy level'),
        limit: z.number().optional().describe('Max results (default 25)'),
        mode: z.enum(['lexical', 'semantic', 'hybrid']).optional().describe('Retrieval mode. hybrid (default) and semantic blend embedding similarity with structural re-ranking; lexical matches names and descriptions only.'),
      } as any,
    } as any,
    async ({ path, query: q, type, category, level, limit, mode }: any) => withErrorHandling(async () => {
      const resolvedMode = mode || 'hybrid';
      if (resolvedMode === 'lexical') {
        const cas = await getAnalysis(path);
        return json(query.searchNodes(cas, q, { type, category, level, limit }));
      }
      return json(await semanticSearch(path, q, { type, category, level, limit }));
    })
  );

  server.registerTool(
    'semantic_search',
    {
      title: 'Semantic Search',
      description: 'Ask in plain English where code lives ("where are driver status updates handled?") and get ranked code nodes with file paths — use this instead of guessing grep keywords when you do not know the codebase vocabulary. Fuses embedding similarity with lexical match, then re-ranks on structural graph signals. Falls back to lexical search and reports degraded when no embedding index is available.',
      inputSchema: {
        path: z.string().describe('Project path'),
        query: z.string().describe('Natural-language description of the code to find'),
        type: z.string().optional().describe('Filter by node type'),
        category: z.string().optional().describe('Filter by category'),
        level: z.number().optional().describe('Filter by hierarchy level'),
        types: z.array(z.string()).optional().describe('Restrict results to these node types'),
        files: z.array(z.string()).optional().describe('Restrict results to nodes in these files'),
        limit: z.number().optional().describe('Max results (default 25)'),
      } as any,
    } as any,
    async ({ path, query: q, type, category, level, types, files, limit }: any) => withErrorHandling(async () => {
      return json(await semanticSearch(path, q, { type, category, level, types, files, limit }));
    })
  );

  server.registerTool(
    'get_embedding_status',
    {
      title: 'Get Embedding Status',
      description: 'Report the embedding index for an analysis: model, dimensions, store, coverage, generation time, and whether the index is degraded, stale, or absent.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const index = cas.embedding_index;
      if (!index) {
        return json({
          status: 'no_index',
          has_index: false,
          message: 'This analysis has no embedding index. Semantic search falls back to lexical retrieval.',
        });
      }
      return json({
        status: index.degraded ? 'degraded' : 'ready',
        has_index: true,
        model: index.model,
        provider: index.provider,
        dimensions: index.dimensions,
        document_version: index.document_version,
        store: index.store,
        generated_at: index.generated_at,
        node_count: index.node_count,
        coverage: index.coverage,
        degraded: Boolean(index.degraded),
        degraded_reason: index.degraded_reason,
      });
    })
  );

  server.registerTool(
    'get_node',
    {
      title: 'Get Node Details',
      description: 'Full details for a specific code element: signature, metadata, documentation, call graph, children, connected edges, entry/exit points, decorators, intent, change risk, stability.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID from search results or other tools'),
      } as any,
    } as any,
    async ({ path, node_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const result = query.getNode(cas, node_id);
      if (!result) return json({ error: `Node not found: ${node_id}` });
      return json(result);
    })
  );

  server.registerTool(
    'get_file_nodes',
    {
      title: 'Get File Nodes',
      description: 'All code elements defined in a specific file, with their internal relationships.',
      inputSchema: {
        path: z.string().describe('Project path'),
        file_path: z.string().describe('Relative file path within the project'),
      } as any,
    } as any,
    async ({ path, file_path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getFileNodes(cas, file_path));
    })
  );

  server.registerTool(
    'get_level',
    {
      title: 'Get Level',
      description: 'Progressive disclosure: get nodes at a specific hierarchy level with their edges and entry/exit points. Level 0 is system-wide, level 1 is subsystems, deeper levels reveal more detail. Optimized for token efficiency: nodes default to 50, edges to 200. Cross-level edges use node_refs for deduplication.',
      inputSchema: {
        path: z.string().describe('Project path'),
        level: z.number().describe('Hierarchy level (0 = system, 1 = subsystems, deeper = more detail)'),
        limit: z.number().optional().describe('Max nodes to return (default 50)'),
        offset: z.number().optional().describe('Skip first N nodes (default 0)'),
        edge_limit: z.number().optional().describe('Max edges to return (default 200)'),
        include_edges: z.boolean().optional().describe('Include edges in response (default true)'),
        include_entry_exit: z.boolean().optional().describe('Include entry/exit points (default true)'),
      } as any,
    } as any,
    async ({ path, level, limit, offset, edge_limit, include_edges, include_entry_exit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getLevel(cas, level, { limit, offset, edge_limit, include_edges, include_entry_exit }));
    })
  );

  // -- Entry/Exit Points & Routes --

  server.registerTool(
    'get_entry_points',
    {
      title: 'Get Entry Points',
      description: 'All system entry points (HTTP endpoints, CLI commands, WebSocket handlers, event listeners, scheduled tasks, etc.). Optionally filter by type. Paginated (default 50).',
      inputSchema: {
        path: z.string().describe('Project path'),
        type: z.string().optional().describe('Filter by type: http, websocket, cli, event, schedule, page, route, message, file, test'),
        limit: z.number().optional().describe('Max results (default 50)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, type, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getEntryPoints(cas, { type, limit, offset }));
    })
  );

  server.registerTool(
    'get_exit_points',
    {
      title: 'Get Exit Points',
      description: 'All external interactions (database calls, API calls, file operations, message publishing, cache operations, SDK calls, webhooks). Paginated (default 50).',
      inputSchema: {
        path: z.string().describe('Project path'),
        type: z.string().optional().describe('Filter by type: database, api, file, message, cache, sdk, webhook'),
        limit: z.number().optional().describe('Max results (default 50)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, type, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getExitPoints(cas, { type, limit, offset }));
    })
  );

  server.registerTool(
    'get_route_table',
    {
      title: 'Get Route Table',
      description: 'HTTP route table: method, path, controller, handler, auth requirements, guards, middleware. Paginated (default 50).',
      inputSchema: {
        path: z.string().describe('Project path'),
        method: z.string().optional().describe('Filter by HTTP method (GET, POST, PUT, DELETE, etc.)'),
        limit: z.number().optional().describe('Max results (default 50)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, method, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getRouteTable(cas, { method, limit, offset }));
    })
  );

  server.registerTool(
    'get_external_services',
    {
      title: 'Get External Services',
      description: 'All external service integrations with purpose, endpoint, usage pattern, monitoring, and cost info.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getExternalServices(cas));
    })
  );

  // -- Call Graph & Flow Tracing --

  server.registerTool(
    'get_callers',
    {
      title: 'Get Callers',
      description: 'Find code elements that call or reference a given node. Traverses edges and method calls. Limited to 50 results by default.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to find callers for'),
        depth: z.number().optional().describe('Max traversal depth (default 2)'),
        limit: z.number().optional().describe('Max results to return (default 50)'),
      } as any,
    } as any,
    async ({ path, node_id, depth, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getCallers(cas, node_id, depth, limit));
    })
  );

  server.registerTool(
    'get_callees',
    {
      title: 'Get Callees',
      description: 'Find code elements that a given node calls or references. Limited to 50 results by default.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to find callees for'),
        depth: z.number().optional().describe('Max traversal depth (default 2)'),
        limit: z.number().optional().describe('Max results to return (default 50)'),
      } as any,
    } as any,
    async ({ path, node_id, depth, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getCallees(cas, node_id, depth, limit));
    })
  );

  // -- Component Hierarchy (React/Frontend) --

  server.registerTool(
    'get_component_parents',
    {
      title: 'Get Component Parents',
      description: 'Find components that render a given component (via JSX). Shows which parent components use this component in their render output.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Component node ID to find parents for'),
        limit: z.number().optional().describe('Max results (default 50)'),
      } as any,
    } as any,
    async ({ path, node_id, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getComponentParents(cas, node_id, limit));
    })
  );

  server.registerTool(
    'get_component_children',
    {
      title: 'Get Component Children',
      description: 'Find components that a given component renders (via JSX). Shows which child components are used in this component\'s render output.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Component node ID to find children for'),
        limit: z.number().optional().describe('Max results (default 50)'),
      } as any,
    } as any,
    async ({ path, node_id, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getComponentChildren(cas, node_id, limit));
    })
  );

  server.registerTool(
    'get_component_metrics',
    {
      title: 'Get Component Metrics',
      description: 'Full metrics for a React component: usage count, usage locations, rendered components, props, state, hooks. Includes parent and child component lists.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Component node ID'),
      } as any,
    } as any,
    async ({ path, node_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const result = query.getComponentMetrics(cas, node_id);
      if (!result) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Node not found or not a component' }) }], isError: true };
      }
      return json(result);
    })
  );

  server.registerTool(
    'get_shared_components',
    {
      title: 'Get Shared Components',
      description: 'Find components that are used in multiple places. Useful for identifying high-impact components where changes need careful consideration.',
      inputSchema: {
        path: z.string().describe('Project path'),
        min_usage: z.number().optional().describe('Minimum usage count to include (default 2)'),
        limit: z.number().optional().describe('Max results (default 50)'),
      } as any,
    } as any,
    async ({ path, min_usage, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getSharedComponents(cas, { min_usage, limit }));
    })
  );

  server.registerTool(
    'get_call_chain',
    {
      title: 'Get Call Chain',
      description: 'Complete call chain from entry to exit. With chain_id: returns full chain detail. With entry_point_id: returns chains for that entry. Without filters: returns paginated chain summaries (id, type, entry/exit, risk level).',
      inputSchema: {
        path: z.string().describe('Project path'),
        chain_id: z.string().optional().describe('Specific call chain ID for full detail'),
        entry_point_id: z.string().optional().describe('Entry point ID to find chains for'),
        limit: z.number().optional().describe('Max results when listing all chains (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, chain_id, entry_point_id, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getCallChain(cas, { chainId: chain_id, entryPointId: entry_point_id, limit, offset }));
    })
  );

  server.registerTool(
    'get_method_calls',
    {
      title: 'Get Method Calls',
      description: 'All method calls made by or received by a node, with execution context (async, conditional, loop depth), arguments, external details, framework semantics, performance hints.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID'),
      } as any,
    } as any,
    async ({ path, node_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getMethodCalls(cas, node_id));
    })
  );

  // -- Agentic Coding Tools --

  server.registerTool(
    'get_coding_context',
    {
      title: 'Get Coding Context',
      description: 'THE essential tool for AI coding. Returns everything needed to start coding in a specific area: target node details, conventions, patterns, layer boundaries, modification checklist, and connected code. Call this before writing ANY code.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().describe('Node ID, file path, or search query to find the target'),
        task_type: z.enum(['add', 'modify', 'delete', 'refactor']).optional().describe('Type of change (default: modify)'),
        include: z.array(z.string()).optional().describe('Sections to include: conventions, patterns, constraints, tests (default: all)'),
      } as any,
    } as any,
    async ({ path, target, task_type, include }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getCodingContext(cas, target, { task_type, include }));
    })
  );

  server.registerTool(
    'get_conventions',
    {
      title: 'Get Conventions',
      description: 'Codebase coding standards extracted from actual code patterns: naming conventions, file organization, import style, error handling patterns, async patterns. Use to ensure new code matches existing style.',
      inputSchema: {
        path: z.string().describe('Project path'),
        scope: z.enum(['global', 'layer', 'module']).optional().describe('Scope of conventions (default: global)'),
        layer: z.string().optional().describe('Layer name if scope=layer'),
        module_id: z.string().optional().describe('Module node ID if scope=module'),
      } as any,
    } as any,
    async ({ path, scope, layer, module_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getConventions(cas, { scope, layer, module_id }));
    })
  );

  server.registerTool(
    'get_modification_guide',
    {
      title: 'Get Modification Guide',
      description: 'Complete safety checklist before modifying specific code: risk level, blast radius, files that must be updated, verification steps, existing tests, tests to add, rollback considerations.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to modify'),
        change_type: z.enum(['signature', 'behavior', 'delete', 'add_parameter', 'rename']).describe('Type of change'),
      } as any,
    } as any,
    async ({ path, node_id, change_type }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getModificationGuide(cas, node_id, change_type));
    })
  );

  server.registerTool(
    'get_pattern_examples',
    {
      title: 'Get Pattern Examples',
      description: 'Get actual working code examples for detected patterns. Use to learn how patterns are implemented in this codebase before writing similar code.',
      inputSchema: {
        path: z.string().describe('Project path'),
        pattern_id: z.string().describe('Pattern ID from get_patterns'),
        variation_id: z.string().optional().describe('Specific variation ID'),
        limit: z.number().optional().describe('Max examples (default 3)'),
      } as any,
    } as any,
    async ({ path, pattern_id, variation_id, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getPatternExamples(cas, pattern_id, { variation_id, limit }));
    })
  );

  server.registerTool(
    'find_similar_code',
    {
      title: 'Find Similar Code',
      description: 'Find code similar to a given node for consistency and potential reuse. Returns similarity scores, reasons, differences, and reuse recommendations.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().optional().describe('Node ID to find similar code for'),
        code_snippet: z.string().optional().describe('Code snippet to find similar code for'),
        similarity_type: z.enum(['structural', 'semantic', 'both']).optional().describe('Type of similarity (default: both)'),
        limit: z.number().optional().describe('Max results (default 10)'),
      } as any,
    } as any,
    async ({ path, node_id, code_snippet, similarity_type, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.findSimilarCode(cas, { node_id, code_snippet, similarity_type, limit }));
    })
  );

  // -- Agentic Coding Tools (Tier 2) --

  server.registerTool(
    'get_comments',
    {
      title: 'Get Comments',
      description: 'Surface TODO/FIXME/HACK/NOTE/WARNING comments affecting a code area. Filter by scope (node, file, module, all) and comment types.',
      inputSchema: {
        path: z.string().describe('Project path'),
        scope: z.enum(['node', 'file', 'module', 'all']).describe('Scope of comments to retrieve'),
        node_id: z.string().optional().describe('Node ID (required if scope=node or scope=module)'),
        file_path: z.string().optional().describe('File path (required if scope=file)'),
        types: z.array(z.enum(['todo', 'fixme', 'hack', 'note', 'warning'])).optional().describe('Comment types to include (default: all)'),
        limit: z.number().optional().describe('Max results (default 50)'),
      } as any,
    } as any,
    async ({ path, scope, node_id, file_path, types, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getComments(cas, { scope, node_id, file_path, types, limit }));
    })
  );

  server.registerTool(
    'get_error_contracts',
    {
      title: 'Get Error Contracts',
      description: 'What errors can a function throw/return and how callers handle them. Shows throws, caught_by callers, and uncaught paths to entry points.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to analyze'),
        direction: z.enum(['throws', 'catches', 'both']).optional().describe('Analysis direction (default: both)'),
      } as any,
    } as any,
    async ({ path, node_id, direction }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getErrorContracts(cas, node_id, direction));
    })
  );

  server.registerTool(
    'get_framework_guidance',
    {
      title: 'Get Framework Guidance',
      description: 'Framework-specific best practices for the detected stack. Shows detected patterns, recommendations, and anti-patterns found.',
      inputSchema: {
        path: z.string().describe('Project path'),
        framework: z.string().optional().describe('Framework name (auto-detect if not specified)'),
        topic: z.enum(['routing', 'state', 'data-fetching', 'testing', 'security']).optional().describe('Specific topic to focus on'),
      } as any,
    } as any,
    async ({ path, framework, topic }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getFrameworkGuidance(cas, { framework, topic }));
    })
  );

  server.registerTool(
    'get_usage_examples',
    {
      title: 'Get Usage Examples',
      description: 'How is this function/class/type actually used throughout the codebase? Shows usage count, patterns, and example locations.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to find usages for'),
        limit: z.number().optional().describe('Max results (default 10)'),
        include_tests: z.boolean().optional().describe('Include test file usages (default: false)'),
      } as any,
    } as any,
    async ({ path, node_id, limit, include_tests }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getUsageExamples(cas, node_id, { limit, include_tests }));
    })
  );

  server.registerTool(
    'get_configuration',
    {
      title: 'Get Configuration',
      description: 'Surface configuration that affects code behavior. Filter by scope (all, runtime, build, test) or find config affecting a specific node.',
      inputSchema: {
        path: z.string().describe('Project path'),
        scope: z.enum(['all', 'runtime', 'build', 'test']).optional().describe('Config scope (default: all)'),
        affecting_node_id: z.string().optional().describe('Find config affecting this specific node'),
      } as any,
    } as any,
    async ({ path, scope, affecting_node_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getConfiguration(cas, { scope, affecting_node_id }));
    })
  );

  // -- v1.7.0 Intelligence --

  server.registerTool(
    'get_intent',
    {
      title: 'Get Intent',
      description: 'WHY code exists: inferred purpose, constraints, architectural decisions with evidence, workaround indicators.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID'),
      } as any,
    } as any,
    async ({ path, node_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const result = query.getIntent(cas, node_id);
      if (!result) return json({ error: `No intent data for node: ${node_id}` });
      return json(result);
    })
  );

  server.registerTool(
    'get_data_entities',
    {
      title: 'Get Data Entities',
      description: 'Data entity lifecycle: entities with fields, CRUD lifecycle (created_by, read_by, updated_by, deleted_by), transformations, invariants, sensitive data, validation gaps. Paginated (default 25).',
      inputSchema: {
        path: z.string().describe('Project path'),
        entity_name: z.string().optional().describe('Filter by entity name'),
        limit: z.number().optional().describe('Max results (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, entity_name, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getDataEntities(cas, { entityName: entity_name, limit, offset }));
    })
  );

  server.registerTool(
    'get_security_overview',
    {
      title: 'Get Security Overview',
      description: 'Security posture: trust boundaries, enforcement points (enforced/assumed/missing), bypass risks, unprotected operations, per-node trust levels and protection gaps.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getSecurityOverview(cas));
    })
  );

  server.registerTool(
    'get_behavioral_invariants',
    {
      title: 'Get Behavioral Invariants',
      description: 'First-class behavior-level invariants inferred from CAS: tenant/org scope, auth and authorization boundaries, database constraints, migration contracts, and test coverage evidence.',
      inputSchema: {
        path: z.string().describe('Project path'),
        invariant_type: z.enum(['tenant-scope', 'auth-boundary', 'authorization', 'db-constraint', 'migration-contract', 'test-coverage', 'data-lifecycle', 'business-rule']).optional().describe('Filter by invariant type'),
        target: z.string().optional().describe('Node id, file path, entity, field, or text target to filter invariants'),
        limit: z.number().optional().describe('Max results (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, invariant_type, target, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getBehavioralInvariants(cas, { invariantType: invariant_type, target, limit, offset }));
    })
  );

  server.registerTool(
    'validate_behavioral_invariants',
    {
      title: 'Validate Behavioral Invariants',
      description: 'Validate a working diff, explicit file list, or provided diff text against CAS behavioral invariants. Use after edits and before final answers to catch tenant-scope, auth, DB constraint, migration, and test-coverage risks.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Optional node id, file path, entity, field, or text target'),
        invariant_type: z.enum(['tenant-scope', 'auth-boundary', 'authorization', 'db-constraint', 'migration-contract', 'test-coverage', 'data-lifecycle', 'business-rule']).optional().describe('Filter by invariant type'),
        files: z.array(z.string()).optional().describe('Explicit changed files to validate instead of reading the working tree'),
        diff_text: z.string().optional().describe('Optional unified diff text to validate'),
        include_working_tree: z.boolean().optional().describe('When false, validate only files/diff_text. Default true reads git working-tree and staged changes.'),
        limit: z.number().optional().describe('Maximum impacted invariants to return'),
      } as any,
    } as any,
    async ({ path, target, invariant_type, files, diff_text, include_working_tree, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(invariantValidation.validateBehavioralInvariants(cas, path, {
        target,
        invariantType: invariant_type,
        files,
        diffText: diff_text,
        includeWorkingTree: include_working_tree,
        limit,
      }));
    })
  );

  server.registerTool(
    'get_stability',
    {
      title: 'Get Stability',
      description: 'Code stability and churn analysis. With node_id: returns detailed stability for that node. Without: returns summary with class distribution counts (not individual node data).',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().optional().describe('Specific node ID (omit for full summary)'),
      } as any,
    } as any,
    async ({ path, node_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getStability(cas, node_id));
    })
  );

  server.registerTool(
    'assess_change_risk',
    {
      title: 'Assess Change Risk',
      description: 'Risk of modifying a code element: risk level, factors (many-callers, critical-path, no-tests, etc.), downstream impact (direct/transitive callers, affected chains and entry points), test protection, stability context, recommendations.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to assess'),
      } as any,
    } as any,
    async ({ path, node_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.assessChangeRisk(cas, node_id));
    })
  );

  server.registerTool(
    'get_flow_coverage',
    {
      title: 'Get Flow Coverage',
      description: 'Per-flow test coverage. With chain_id: returns full coverage detail and test gaps for that chain. Without: returns coverage status counts and test gap severity counts (not individual flow data).',
      inputSchema: {
        path: z.string().describe('Project path'),
        chain_id: z.string().optional().describe('Specific call chain ID (omit for all flows)'),
      } as any,
    } as any,
    async ({ path, chain_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getFlowCoverage(cas, chain_id));
    })
  );

  // -- Workflows & Capabilities --

  server.registerTool(
    'get_workflows',
    {
      title: 'Get Workflows',
      description: 'Business workflows. With workflow_id: returns full workflow detail. Without: returns workflow summaries (id, name, type, criticality, counts) and dependency graph.',
      inputSchema: {
        path: z.string().describe('Project path'),
        workflow_id: z.string().optional().describe('Specific workflow ID (omit for all)'),
      } as any,
    } as any,
    async ({ path, workflow_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getWorkflows(cas, workflow_id));
    })
  );

  server.registerTool(
    'get_user_journeys',
    {
      title: 'Get User Journeys',
      description: 'Deterministic end-to-end user journeys composed from entry points, call chains, and terminal effects. Each journey shows why a path exists via its terminal entities (e.g. "Create work order -> WorkOrder created"). With journey_id: returns full journey detail with steps, security boundaries, and covering tests. Without: returns paginated journey summaries.',
      inputSchema: {
        path: z.string().describe('Project path'),
        journey_id: z.string().optional().describe('Specific journey ID for full detail'),
        kind: z.enum(['user-facing', 'system', 'scheduled']).optional().describe('Filter by journey kind'),
        limit: z.number().optional().describe('Max results when listing (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, journey_id, kind, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getUserJourneys(cas, { journeyId: journey_id, kind, limit, offset }));
    })
  );

  server.registerTool(
    'get_paradigm_conformance',
    {
      title: 'Get Paradigm Conformance',
      description: 'Statistically detected codebase paradigms (service-mediated data access, entry-service-repository layering, guarded HTTP entry points, single-owner entity writes) with adoption rates, evidence files, and file-level deviations. Norms only emerge when at least 70 percent of comparable code follows the shape, so repos without a norm produce no noise. With paradigm: returns full detail including every deviation. Without: returns per-paradigm summaries with up to 3 sample deviations.',
      inputSchema: {
        path: z.string().describe('Project path'),
        paradigm: z.string().optional().describe('Specific paradigm name for full detail (e.g. guarded-http-entry-points)'),
      } as any,
    } as any,
    async ({ path, paradigm }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getParadigmConformance(cas, { paradigm }));
    })
  );

  server.registerTool(
    'get_data_lineage',
    {
      title: 'Get Data Lineage',
      description: 'Deterministic per-entity data lineage: which code writes and reads each data entity, which external services receive it, which security boundaries the data crosses and whether they are guarded, and which user journeys carry it. Entities are ranked by exposure (sensitive fields + unguarded paths + external transfer first). With entity_id: returns full lineage detail for one entity. Without: returns ranked summaries.',
      inputSchema: {
        path: z.string().describe('Project path'),
        entity_id: z.string().optional().describe('Specific data entity ID for full lineage detail'),
        sensitive_only: z.boolean().optional().describe('Only return entities with sensitive fields'),
        limit: z.number().optional().describe('Max results when listing (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, entity_id, sensitive_only, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getDataLineage(cas, { entityId: entity_id, sensitiveOnly: sensitive_only, limit, offset }));
    })
  );

  server.registerTool(
    'diff_behavior',
    {
      title: 'Diff Behavior',
      description: 'Behavior-level diff between the current analysis and a prior snapshot: journeys added/removed/changed (matched by entry signature plus terminal entities, not ids), security boundary changes and newly unguarded entries, capability additions and possible duplicates, data lineage exposure changes for sensitive entities, and paradigm deviations introduced or resolved. Risk flags appear first, e.g. a new journey that writes an entity without crossing the auth boundary.',
      inputSchema: {
        path: z.string().describe('Project path'),
        snapshot: z.string().optional().describe("Snapshot id to diff against, or 'previous' for the most recent prior snapshot (default)"),
      } as any,
    } as any,
    async ({ path, snapshot }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await query.diffBehaviorAgainstSnapshot(path, cas, snapshot));
    })
  );

  server.registerTool(
    'get_product_map',
    {
      title: 'Get Product Map',
      description: 'What this codebase actually does, in one call — read this instead of skimming READMEs and directory trees to orient: system identity, capabilities ordered by criticality and linked to the user journeys and entities they serve, sensitive data and exposure highlights, conventions with open deviations, and health (tests, implementation gaps, top risks), each with coverage caveats so you know what the analysis is sure about. Use section to fetch one part token-efficiently, or format markdown for a compact onboarding brief.',
      inputSchema: {
        path: z.string().describe('Project path'),
        section: z.enum(['identity', 'capabilities', 'journeys', 'data', 'conventions', 'health', 'coverage_caveats']).optional().describe('Return only one section of the map'),
        format: z.enum(['json', 'markdown']).optional().describe("Output format: 'json' (default) or 'markdown' for a compact product brief"),
      } as any,
    } as any,
    async ({ path, section, format }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getProductMap(cas, { section, format }));
    })
  );

  server.registerTool(
    'get_flow_graph',
    {
      title: 'Get Flow Graph',
      description: 'Capability-level architecture: capabilities with scores, dependencies, topology (root/leaf/critical path), primary flow (value chain), layers (entry/business/data/infrastructure), system insights.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getFlowGraph(cas));
    })
  );

  server.registerTool(
    'get_runtime_static_links',
    {
      title: 'Get Runtime Static Links',
      description: 'Runtime-to-static correlation: entry points, exit points, call chains, and external services mapped to runtime signals with telemetry coverage status and instrumentation points.',
      inputSchema: {
        path: z.string().describe('Project path'),
        telemetry_status: z.enum(['observed', 'instrumentable', 'not-instrumented']).optional().describe('Filter by telemetry status'),
        kind: z.enum(['entry-point', 'exit-point', 'call-chain', 'external-service', 'telemetry-hook']).optional().describe('Filter by link kind'),
        limit: z.number().optional().describe('Max results (default 50)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, telemetry_status, kind, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getRuntimeStaticLinks(cas, { telemetryStatus: telemetry_status, kind, limit, offset }));
    })
  );

  server.registerTool(
    'simulate_runtime_telemetry',
    {
      title: 'Simulate Runtime Telemetry',
      description: 'Generate deterministic simulated traffic, errors, latency, and traces mapped onto CAS objects, then feed them into runtime observations and operational priorities. Use this to preview how telemetry would affect active development before SDK data exists.',
      inputSchema: {
        path: z.string().describe('Project path'),
        scenario: z.enum(['balanced', 'bug-hunt', 'traffic-spike', 'slow-dependencies']).optional().describe('Simulation shape'),
        event_count: z.number().optional().describe('Number of synthetic observations to generate, max 500'),
        seed: z.string().optional().describe('Stable seed for repeatable simulations'),
        persist: z.boolean().optional().describe('Store generated observations. Defaults to true; set false for dry-run planning.'),
      } as any,
    } as any,
    async ({ path, scenario, event_count, seed, persist }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await runtimeSimulation.simulateRuntimeTelemetry(cas, path, {
        scenario,
        eventCount: event_count,
        seed,
        persist,
      }));
    })
  );

  server.registerTool(
    'correlate_runtime_event',
    {
      title: 'Correlate Runtime Event',
      description: 'Map a runtime event or error back to CAS nodes, entry points, exit points, call chains, and runtime_static_links without storing it.',
      inputSchema: {
        path: z.string().describe('Project path'),
        event: z.object({
          type: z.enum(['request', 'error', 'exit', 'log', 'custom']),
          timestamp: z.string().optional(),
          schema_version: z.string().optional(),
          service_name: z.string().optional(),
          environment: z.string().optional(),
          signal: z.string().optional(),
          static_id: z.string().optional(),
          node_id: z.string().optional(),
          entry_point_id: z.string().optional(),
          exit_point_id: z.string().optional(),
          call_chain_id: z.string().optional(),
          trace_id: z.string().optional(),
          span_id: z.string().optional(),
          parent_span_id: z.string().optional(),
          method: z.string().optional(),
          route: z.string().optional(),
          path: z.string().optional(),
          status_code: z.number().optional(),
          duration_ms: z.number().optional(),
          error_message: z.string().optional(),
          stack: z.string().optional(),
          attributes: z.record(z.unknown()).optional(),
        }).describe('Runtime event payload to correlate'),
      } as any,
    } as any,
    async ({ path, event }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(product.correlateRuntimeEvent(cas, event));
    })
  );

  server.registerTool(
    'record_runtime_event',
    {
      title: 'Record Runtime Event',
      description: 'Store a runtime event after correlating it to CAS. Use for requests, errors, exits, logs, or custom telemetry signals.',
      inputSchema: {
        path: z.string().describe('Project path'),
        event: z.object({
          type: z.enum(['request', 'error', 'exit', 'log', 'custom']),
          timestamp: z.string().optional(),
          schema_version: z.string().optional(),
          service_name: z.string().optional(),
          environment: z.string().optional(),
          signal: z.string().optional(),
          static_id: z.string().optional(),
          node_id: z.string().optional(),
          entry_point_id: z.string().optional(),
          exit_point_id: z.string().optional(),
          call_chain_id: z.string().optional(),
          trace_id: z.string().optional(),
          span_id: z.string().optional(),
          parent_span_id: z.string().optional(),
          method: z.string().optional(),
          route: z.string().optional(),
          path: z.string().optional(),
          status_code: z.number().optional(),
          duration_ms: z.number().optional(),
          error_message: z.string().optional(),
          stack: z.string().optional(),
          attributes: z.record(z.unknown()).optional(),
        }).describe('Runtime event payload to store'),
      } as any,
    } as any,
    async ({ path, event }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const eventWithTimestamp = {
        ...event,
        timestamp: event.timestamp || new Date().toISOString(),
      };
      const observation: product.RuntimeObservation = {
        id: runtimeObservationId(),
        project_path: path,
        recorded_at: new Date().toISOString(),
        source: 'ingested',
        event: eventWithTimestamp,
        correlation: product.correlateRuntimeEvent(cas, eventWithTimestamp),
      };
      await saveRuntimeObservation(path, observation);
      return json(observation);
    })
  );

  server.registerTool(
    'ingest_telemetry',
    {
      title: 'Ingest Telemetry',
      description: 'Ingest a batch of real runtime telemetry events in an OTEL-compatible shape, correlate each event onto CAS static structure via routes, file/function hints, and stack frames, and persist them with source "ingested". Returns matched/partial/unmatched counts and the top unmatched hints. Ingested telemetry drives get_runtime_observations and get_operational_priorities by default.',
      inputSchema: {
        path: z.string().describe('Project path'),
        events: z.array(z.object({
          kind: z.enum(['request', 'error', 'log', 'metric']).describe('Event kind'),
          timestamp: z.string().optional().describe('ISO timestamp of the runtime event'),
          name: z.string().optional().describe('Span, signal, or metric name, such as http:POST:/work_orders'),
          service_name: z.string().optional(),
          environment: z.string().optional().describe('Deployment environment, such as production or staging'),
          trace_id: z.string().optional(),
          span_id: z.string().optional(),
          parent_span_id: z.string().optional(),
          method: z.string().optional().describe('HTTP method'),
          route: z.string().optional().describe('Route pattern, such as /work_orders/:id'),
          path: z.string().optional().describe('Raw request path'),
          status: z.number().optional().describe('HTTP status code'),
          duration_ms: z.number().optional(),
          function_hint: z.string().optional().describe('Function or method name the event originated from'),
          file_hint: z.string().optional().describe('Source file the event originated from'),
          error: z.object({
            type: z.string().optional(),
            message: z.string().optional(),
            stack_top_frames: z.array(z.union([
              z.string(),
              z.object({ file: z.string(), line: z.number().optional(), function: z.string().optional() }),
            ])).optional().describe('Top stack frames, most specific first'),
          }).optional(),
          volume: z.number().optional().describe('Pre-aggregated event count this entry represents'),
          attributes: z.record(z.unknown()).optional(),
        })).describe('Batch of runtime events, max 1000 per call'),
        persist: z.boolean().optional().describe('Store ingested observations. Defaults to true; set false for dry-run correlation.'),
      } as any,
    } as any,
    async ({ path, events, persist }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await telemetryIngestion.ingestTelemetryBatch(cas, path, events, { persist }));
    })
  );

  server.registerTool(
    'get_runtime_observations',
    {
      title: 'Get Runtime Observations',
      description: 'Query stored runtime observations and their CAS correlations. Filter by type, timestamp, or static CAS id. Returns ingested telemetry by default; simulated observations are only included when source is set to "simulated" or "all" and are always labeled with their provenance.',
      inputSchema: {
        path: z.string().describe('Project path'),
        type: z.enum(['request', 'error', 'exit', 'log', 'custom']).optional().describe('Runtime event type'),
        since: z.string().optional().describe('ISO timestamp lower bound'),
        static_id: z.string().optional().describe('CAS node, entry point, exit point, call chain, or runtime link id'),
        trace_id: z.string().optional().describe('Runtime trace id'),
        span_id: z.string().optional().describe('Runtime span id or parent span id'),
        source: z.enum(['ingested', 'simulated', 'all']).optional().describe('Observation provenance to return (default ingested)'),
        limit: z.number().optional().describe('Max results (default storage order, newest first)'),
      } as any,
    } as any,
    async ({ path, type, since, static_id, trace_id, span_id, source, limit }: any) => withErrorHandling(async () => {
      return json(await telemetryIngestion.loadTelemetryObservations(path, {
        type,
        since,
        staticId: static_id,
        traceId: trace_id,
        spanId: span_id,
        source,
        limit,
      }));
    })
  );

  server.registerTool(
    'get_operational_priorities',
    {
      title: 'Get Operational Priorities',
      description: 'Rank bugs, bottlenecks, problematic areas, and telemetry-backed work by combining stored runtime observations with CAS system health, change risk, tests, idioms, and static/runtime correlations. Uses ingested telemetry only by default; pass include_simulated to mix in simulated observations, which are always labeled per priority.',
      inputSchema: {
        path: z.string().describe('Project path'),
        since: z.string().optional().describe('ISO timestamp lower bound for runtime observations'),
        include_simulated: z.boolean().optional().describe('Also include simulated observations (default false)'),
        limit: z.number().optional().describe('Max priorities to return'),
      } as any,
    } as any,
    async ({ path, since, include_simulated, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const set = await telemetryIngestion.loadTelemetryObservations(path, {
        since,
        source: include_simulated ? 'all' : 'ingested',
        limit: 5000,
      });
      const result = product.buildOperationalPriorities(cas, set.observations, { limit });
      const notes: string[] = [];
      if (set.ingested_count === 0 && set.simulated_count > 0 && !include_simulated) {
        notes.push(`No ingested telemetry found, but ${set.simulated_count} simulated observations exist. Pass include_simulated: true to rank with simulated data; simulated priorities never represent production truth.`);
      }
      return json({
        source: include_simulated ? 'all' : 'ingested',
        ...result,
        ...(notes.length > 0 ? { notes } : {}),
      });
    })
  );

  server.registerTool(
    'get_runtime_trace',
    {
      title: 'Get Runtime Trace',
      description: 'Replay stored runtime observations for a trace id with matched CAS static ids. Reads ingested telemetry by default; set source to "simulated" or "all" to include simulated observations.',
      inputSchema: {
        path: z.string().describe('Project path'),
        trace_id: z.string().describe('Runtime trace id'),
        source: z.enum(['ingested', 'simulated', 'all']).optional().describe('Observation provenance to read (default ingested)'),
      } as any,
    } as any,
    async ({ path, trace_id, source }: any) => withErrorHandling(async () => {
      return json(await telemetryIngestion.loadTelemetryTrace(path, trace_id, { source }));
    })
  );

  server.registerTool(
    'get_analysis_facts',
    {
      title: 'Get Analysis Facts',
      description: 'Evidence-backed CAS facts. Filter by subject type, subject ID, or fact type to see the claim, producer, confidence, and source evidence behind CAS data.',
      inputSchema: {
        path: z.string().describe('Project path'),
        subject_type: z.string().optional().describe('Filter by subject type, such as node, edge, entry_point, workflow, capability, runtime_link, repository_link'),
        subject_id: z.string().optional().describe('Filter by concrete CAS object ID'),
        fact_type: z.string().optional().describe('Filter by fact type, such as definition, relationship, workflow, runtime-correlation, cross-repository'),
        limit: z.number().optional().describe('Max results (default 50)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, subject_type, subject_id, fact_type, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getAnalysisFacts(cas, { subjectType: subject_type, subjectId: subject_id, factType: fact_type, limit, offset }));
    })
  );

  server.registerTool(
    'get_domain_concepts',
    {
      title: 'Get Domain Concepts',
      description: 'Core domain terminology: concepts with frequency, where they appear (entry points, entities, nodes), classification (core/supporting/infrastructure). Sorted by frequency. Paginated (default 25).',
      inputSchema: {
        path: z.string().describe('Project path'),
        classification: z.string().optional().describe('Filter by classification: core, supporting, infrastructure'),
        limit: z.number().optional().describe('Max results (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, classification, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getDomainConcepts(cas, { classification, limit, offset }));
    })
  );

  // -- Behaviors & Lifecycle --

  server.registerTool(
    'get_behaviors',
    {
      title: 'Get Behaviors',
      description: 'System behaviors - what the system does. Returns behavior names, participating nodes, and execution flows. Use behavior_id for full detail.',
      inputSchema: {
        path: z.string().describe('Project path'),
        behavior_id: z.string().optional().describe('Specific behavior ID for full detail'),
        limit: z.number().optional().describe('Max results (default 50)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, behavior_id, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      if (behavior_id) {
        const result = query.getBehaviorDetail(cas, behavior_id);
        if (!result) return json({ error: `Behavior not found: ${behavior_id}` });
        return json(result);
      }
      return json(query.getBehaviors(cas, { limit, offset }));
    })
  );

  server.registerTool(
    'get_lifecycle_hooks',
    {
      title: 'Get Lifecycle Hooks',
      description: 'Find lifecycle hooks - initialization, mounting, updates, destruction. Detects Angular ngOnInit, React useEffect, Vue mounted, NestJS OnModuleInit, etc.',
      inputSchema: {
        path: z.string().describe('Project path'),
        phase: z.string().optional().describe('Filter by phase: init, mount, update, destroy'),
        framework: z.string().optional().describe('Filter by framework'),
        limit: z.number().optional().describe('Max results (default 50)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, phase, framework, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getLifecycleHooks(cas, { phase, framework, limit, offset }));
    })
  );

  // -- Testing --

  server.registerTool(
    'find_tests',
    {
      title: 'Find Tests',
      description: 'Find test suites and test cases covering a specific node or file. Includes assertions, mocks, fixtures, and coverage info. Without node_id or file_path, returns paginated list of all test suites (default 25).',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().optional().describe('Node ID to find tests for'),
        file_path: z.string().optional().describe('File path to find tests for'),
        limit: z.number().optional().describe('Max results when listing all (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, node_id, file_path, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.findTests(cas, { nodeId: node_id, filePath: file_path, limit, offset }));
    })
  );

  server.registerTool(
    'get_test_summary',
    {
      title: 'Get Test Summary',
      description: 'Full test overview: counts by type/status, coverage, mocks, fixtures. Plus test gaps (untested flows, branches, mock-only coverage, no-assertion tests).',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getTestSummary(cas));
    })
  );

  // -- Data & Schema --

  server.registerTool(
    'get_database_schema',
    {
      title: 'Get Database Schema',
      description: 'Database schema from ORM analysis: entities, fields (types, constraints), relationships (1:1, 1:N, M:N).',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getDatabaseSchema(cas));
    })
  );

  // -- Code Health --

  server.registerTool(
    'get_implementation_health',
    {
      title: 'Get Implementation Health',
      description: 'Implementation completeness: complete/partial/stub/deprecated/experimental counts, health score, risk areas, deprecation timeline.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getImplementationHealth(cas));
    })
  );

  server.registerTool(
    'get_system_health',
    {
      title: 'Get System Health',
      description: 'CAS-backed coherence and risk analysis: complexity, duplication, paradigm drift, naming/DI/module convention drift, implementation gaps, test gaps, and runtime coverage gaps. Use before broad refactors and after analysis to decide what to fix or align.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getSystemHealth(cas));
    })
  );

  server.registerTool(
    'get_documentation_coverage',
    {
      title: 'Get Documentation Coverage',
      description: 'Documentation quality: coverage by type (functions, classes, interfaces, modules), quality metrics, missing documentation ranked by importance.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getDocumentationCoverage(cas));
    })
  );

  server.registerTool(
    'get_todos',
    {
      title: 'Get TODOs',
      description: 'TODO/FIXME tracking: counts by type/priority/category, tech debt items, blocking items, hotspot files.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getTodos(cas));
    })
  );

  // -- Dependencies & Libraries --

  server.registerTool(
    'get_dependencies',
    {
      title: 'Get Dependencies',
      description: 'Package dependencies: packages with versions, licenses, vulnerabilities.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getDependencies(cas));
    })
  );

  server.registerTool(
    'get_libraries',
    {
      title: 'Get Libraries',
      description: 'Library analysis: usage patterns, bundle size, security info, usage stats, optimization opportunities, replacement feasibility, alternatives. Paginated (default 25).',
      inputSchema: {
        path: z.string().describe('Project path'),
        query: z.string().optional().describe('Filter by library name or category'),
        limit: z.number().optional().describe('Max results (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, query: q, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getLibraries(cas, { query: q, limit, offset }));
    })
  );

  // -- Change History & Incremental Analysis --

  server.registerTool(
    'get_changes_since',
    {
      title: 'Get Changes Since',
      description: 'Query changes after a specific timestamp. Returns change history entries with files, nodes, edges affected, impact analysis, and semantic summaries.',
      inputSchema: {
        path: z.string().describe('Project path'),
        since: z.string().describe('ISO timestamp to query changes from'),
        limit: z.number().optional().describe('Max results (default 50)'),
      } as any,
    } as any,
    async ({ path, since, limit }: any) => withErrorHandling(async () => {
      return json(await query.getChangesSince(path, since, { limit }));
    })
  );

  server.registerTool(
    'get_changes_between',
    {
      title: 'Get Changes Between',
      description: 'Query changes between two timestamps. Returns change history entries within the time range.',
      inputSchema: {
        path: z.string().describe('Project path'),
        from: z.string().describe('Start ISO timestamp'),
        to: z.string().describe('End ISO timestamp'),
        limit: z.number().optional().describe('Max results (default 50)'),
      } as any,
    } as any,
    async ({ path, from, to, limit }: any) => withErrorHandling(async () => {
      return json(await query.getChangesBetween(path, from, to, { limit }));
    })
  );

  server.registerTool(
    'get_changes_for_node',
    {
      title: 'Get Changes for Node',
      description: 'Query changes affecting a specific node. Optionally include changes to callers/callees to see ripple effects.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to find changes for'),
        since: z.string().optional().describe('ISO timestamp to query changes from'),
        include_callers: z.boolean().optional().describe('Include changes to callers'),
        include_callees: z.boolean().optional().describe('Include changes to callees'),
        depth: z.number().optional().describe('How far to traverse caller/callee graph (default 1)'),
        limit: z.number().optional().describe('Max results (default 25)'),
      } as any,
    } as any,
    async ({ path, node_id, since, include_callers, include_callees, depth, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await query.getChangesForNode(cas, path, node_id, {
        since,
        includeCallers: include_callers,
        includeCallees: include_callees,
        depth,
        limit,
      }));
    })
  );

  server.registerTool(
    'get_changes_for_file',
    {
      title: 'Get Changes for File',
      description: 'Query changes to a specific file. Optionally include changes to files that import/are imported by this file.',
      inputSchema: {
        path: z.string().describe('Project path'),
        file_path: z.string().describe('Relative file path to find changes for'),
        since: z.string().optional().describe('ISO timestamp to query changes from'),
        include_importers: z.boolean().optional().describe('Include changes to files that import this file'),
        include_imported: z.boolean().optional().describe('Include changes to files this file imports'),
        limit: z.number().optional().describe('Max results (default 25)'),
      } as any,
    } as any,
    async ({ path, file_path, since, include_importers, include_imported, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await query.getChangesForFile(cas, path, file_path, {
        since,
        includeImporters: include_importers,
        includeImported: include_imported,
        limit,
      }));
    })
  );

  server.registerTool(
    'get_changes_for_entry_point',
    {
      title: 'Get Changes for Entry Point',
      description: 'Query changes affecting an entry point (HTTP endpoint, CLI command, etc.). Optionally include the full call chain.',
      inputSchema: {
        path: z.string().describe('Project path'),
        entry_point_id: z.string().describe('Entry point ID to find changes for'),
        since: z.string().optional().describe('ISO timestamp to query changes from'),
        include_full_chain: z.boolean().optional().describe('Include changes to all nodes in the call chain'),
        limit: z.number().optional().describe('Max results (default 25)'),
      } as any,
    } as any,
    async ({ path, entry_point_id, since, include_full_chain, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await query.getChangesForEntryPoint(cas, path, entry_point_id, {
        since,
        includeFullChain: include_full_chain,
        limit,
      }));
    })
  );

  server.registerTool(
    'get_change_summary',
    {
      title: 'Get Change Summary',
      description: 'Aggregated change statistics grouped by file, module, author, intent, day, or week. Shows change velocity, risk distribution, and trends.',
      inputSchema: {
        path: z.string().describe('Project path'),
        group_by: z.enum(['file', 'module', 'author', 'intent', 'day', 'week']).describe('How to group changes'),
        since: z.string().optional().describe('ISO timestamp to query changes from'),
        until: z.string().optional().describe('ISO timestamp to query changes until'),
      } as any,
    } as any,
    async ({ path, group_by, since, until }: any) => withErrorHandling(async () => {
      return json(await query.getChangeSummary(path, {
        groupBy: group_by,
        since,
        until,
      }));
    })
  );

  server.registerTool(
    'get_hot_spots',
    {
      title: 'Get Hot Spots',
      description: 'Find the most frequently changed or bug-prone areas of the codebase. Returns heat map data with normalized intensity values.',
      inputSchema: {
        path: z.string().describe('Project path'),
        metric: z.enum(['change-count', 'churn-lines', 'bug-fix-rate']).describe('Metric to rank files by'),
        since: z.string().optional().describe('ISO timestamp to query changes from'),
        limit: z.number().optional().describe('Max results (default 20)'),
      } as any,
    } as any,
    async ({ path, metric, since, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await query.getHotSpots(cas, path, { metric, since, limit }));
    })
  );

  server.registerTool(
    'get_analysis_at',
    {
      title: 'Get Analysis At',
      description: 'Time travel: retrieve the analysis state at a specific point in time. Returns the full CASOutput as it existed at that timestamp.',
      inputSchema: {
        path: z.string().describe('Project path'),
        timestamp: z.string().describe('ISO timestamp to retrieve analysis for'),
      } as any,
    } as any,
    async ({ path, timestamp }: any) => withErrorHandling(async () => {
      const result = await query.getAnalysisAt(path, timestamp);
      if (!result) return json({ error: `No analysis snapshot found at or before: ${timestamp}` });
      return json(result);
    })
  );

  server.registerTool(
    'get_analysis_snapshots',
    {
      title: 'Get Analysis Snapshots',
      description: 'List all available analysis snapshots for time travel. Returns snapshot IDs and timestamps.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      return json(await query.getAnalysisSnapshots(path));
    })
  );

  // -- Watch Mode (Real-Time Analysis) --

  server.registerTool(
    'start_watch',
    {
      title: 'Start Watch',
      description: 'Begin watching a project for file changes. Automatically runs incremental analysis when files change. Returns a watch_id for tracking the session.',
      inputSchema: {
        path: z.string().describe('Project path to watch'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      return json(watcher.startWatch(path));
    })
  );

  server.registerTool(
    'stop_watch',
    {
      title: 'Stop Watch',
      description: 'Stop watching a project for file changes.',
      inputSchema: {
        watch_id: z.string().describe('Watch session ID from start_watch'),
      } as any,
    } as any,
    async ({ watch_id }: any) => withErrorHandling(async () => {
      return json(watcher.stopWatch(watch_id));
    })
  );

  server.registerTool(
    'get_watch_status',
    {
      title: 'Get Watch Status',
      description: 'Get the current status of a watch session including pending changes, recent analyses, and statistics.',
      inputSchema: {
        watch_id: z.string().describe('Watch session ID from start_watch'),
      } as any,
    } as any,
    async ({ watch_id }: any) => withErrorHandling(async () => {
      const status = watcher.getWatchStatus(watch_id);
      if (!status) return json({ error: `Watch session not found: ${watch_id}` });
      return json(status);
    })
  );

  server.registerTool(
    'list_watches',
    {
      title: 'List Watches',
      description: 'List all active and recent watch sessions.',
      inputSchema: {} as any,
    } as any,
    async () => withErrorHandling(async () => {
      return json(watcher.listWatches());
    })
  );

  server.registerTool(
    'poll_watch_changes',
    {
      title: 'Poll Watch Changes',
      description: 'Poll for recent changes from a watch session. Use this to check if new analyses have completed since the last poll.',
      inputSchema: {
        watch_id: z.string().describe('Watch session ID from start_watch'),
        since: z.string().optional().describe('ISO timestamp to filter changes newer than this'),
      } as any,
    } as any,
    async ({ watch_id, since }: any) => withErrorHandling(async () => {
      const changes = watcher.pollWatchChanges(watch_id, since);
      if (!changes) return json({ error: `Watch session not found: ${watch_id}` });
      return json(changes);
    })
  );
}

function reportSummaryWithinWindow(summary: { generated_at?: string; saved_at?: string }, sinceDays?: number | null): boolean {
  if (!sinceDays || sinceDays <= 0) return true;
  const parsed = Date.parse(String(summary.generated_at || summary.saved_at || ''));
  if (!Number.isFinite(parsed)) return false;
  return parsed >= Date.now() - sinceDays * 24 * 60 * 60 * 1000;
}

function registerResources(server: McpServer) {
  server.registerResource(
    'analyses-list',
    'klauro://analyses',
    { title: 'All Analyses', description: 'List of all analyzed codebases with metadata.', mimeType: 'application/json' } as any,
    async () => {
      const analyses = await listAnalyses();
      return { contents: [{ uri: 'klauro://analyses', text: JSON.stringify(analyses) }] };
    }
  );

  server.registerResource(
    'workspace-graphs-list',
    'klauro://workspaces',
    { title: 'Workspace Graphs', description: 'Persisted multi-repository workspace graphs.', mimeType: 'application/json' } as any,
    async () => {
      const graphs = await listWorkspaceGraphs();
      return { contents: [{ uri: 'klauro://workspaces', text: JSON.stringify(graphs) }] };
    }
  );

  server.registerResource(
    'workspace-graph',
    new ResourceTemplate('klauro://workspace/{workspace_id_or_name}/graph', { list: undefined }),
    { title: 'Workspace Graph', description: 'Persisted cross-repository graph with links, conflicts, confidence, and review decisions.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const graph = await loadWorkspaceGraph(String(params.workspace_id_or_name));
      if (!graph) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Workspace graph not found' }) }] };
      return { contents: [{ uri: uri.href, text: JSON.stringify({ summary: workspaceGraph.summarizeWorkspaceGraph(graph), graph }) }] };
    }
  );

  server.registerResource(
    'agentic-benchmark-reports',
    'klauro://agentic-benchmarks',
    { title: 'Agentic Benchmark Reports', description: 'Persisted with-Klauro vs without-Klauro agent benchmark reports.', mimeType: 'application/json' } as any,
    async () => {
      const reports = await listAgenticBenchmarkReports();
      return { contents: [{ uri: 'klauro://agentic-benchmarks', text: JSON.stringify(reports) }] };
    }
  );

  server.registerResource(
    'agent-performance-proof',
    'klauro://agent-performance-proof',
    { title: 'Agent Performance Proof', description: 'Recent proof that Klauro improves agent token use, speed, quality, and incremental edit-loop performance.', mimeType: 'application/json' } as any,
    async () => {
      const summaries = (await listAgenticBenchmarkReports())
        .filter(summary => reportSummaryWithinWindow(summary, 7))
        .slice(0, 25);
      const reports = [];
      for (const summary of summaries) {
        const report = await loadAgenticBenchmarkReport(summary.id);
        if (report) reports.push(report);
      }
      const proof = buildAgentPerformanceProof(reports, { sinceDays: 7 });
      return { contents: [{ uri: 'klauro://agent-performance-proof', text: JSON.stringify(proof) }] };
    }
  );

  server.registerResource(
    'agentic-benchmark-report',
    new ResourceTemplate('klauro://agentic-benchmark/{report_id}', { list: undefined }),
    { title: 'Agentic Benchmark Report', description: 'A persisted agent benchmark, live quality, or incremental value report.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const report = await loadAgenticBenchmarkReport(String(params.report_id));
      if (!report) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Agentic benchmark report not found' }) }] };
      return { contents: [{ uri: uri.href, text: JSON.stringify({ report, markdown: formatStoredBenchmarkReport(report) }) }] };
    }
  );

  server.registerResource(
    'project-overview',
    new ResourceTemplate('klauro://{project_name}/overview', { list: undefined }),
    { title: 'Project Overview', description: 'System overview: architecture summary, tech stack, capabilities, purpose.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(query.getSystemOverview(cas)) }] };
    }
  );

  server.registerResource(
    'project-agent-bootstrap',
    new ResourceTemplate('klauro://{project_name}/agent-bootstrap', { list: undefined }),
    { title: 'Agent Bootstrap', description: 'One payload with agent readiness, start context, MCP plan, work packet, and prompt text.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(await agentBootstrap.getAgentBootstrap(cas, entry.path)) }] };
    }
  );

  server.registerResource(
    'project-agent-start',
    new ResourceTemplate('klauro://{project_name}/agent-start', { list: undefined }),
    { title: 'Agent Start Context', description: 'Default CAS-backed start context for coding agents before broad file reads.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(agentAdoption.getAgentStartContext(cas, entry.path)) }] };
    }
  );

  server.registerResource(
    'project-runtime-event-contract',
    new ResourceTemplate('klauro://{project_name}/runtime-event-contract', { list: undefined }),
    { title: 'Runtime Event Contract', description: 'Canonical runtime event schema and CAS-specific payloads for SDK telemetry correlation.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(runtimeContract.getRuntimeEventContract(cas)) }] };
    }
  );

  server.registerResource(
    'project-cas-contract',
    new ResourceTemplate('klauro://{project_name}/cas-contract', { list: undefined }),
    { title: 'CAS Contract Validation', description: 'Executable graph completeness and evidence checks for the stored CAS output.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      const observations = await loadRuntimeObservations(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(casContract.validateCASContract(cas, observations)) }] };
    }
  );

  server.registerResource(
    'project-agent-readiness',
    new ResourceTemplate('klauro://{project_name}/agent-readiness', { list: undefined }),
    { title: 'Agent Readiness', description: 'Default-use readiness score and gaps for agent adoption.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      const evidence = await testDiscovery.getTestDiscoveryEvidence(entry.path, cas);
      return { contents: [{ uri: uri.href, text: JSON.stringify(agentAdoption.evaluateAgentReadiness(cas, entry.path, { testEvidence: evidence })) }] };
    }
  );

  server.registerResource(
    'project-agent-doctor',
    new ResourceTemplate('klauro://{project_name}/agent-doctor', { list: undefined }),
    { title: 'Agent Doctor', description: 'Default-use readiness, freshness, tests, runtime SDK proof, and golden snapshot status.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(await agentDoctor.getAgentDoctor(cas, entry.path)) }] };
    }
  );

  server.registerResource(
    'project-agent-defaults',
    new ResourceTemplate('klauro://{project_name}/agent-defaults', { list: undefined }),
    { title: 'Agent Defaults', description: 'Install-ready default-use instructions for coding agents.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(await agentDefaults.getAgentDefaultConfig(cas, entry.path)) }] };
    }
  );

  server.registerResource(
    'project-analysis-freshness',
    new ResourceTemplate('klauro://{project_name}/freshness', { list: undefined }),
    { title: 'Analysis Freshness', description: 'Stored CAS freshness against source file mtimes and incremental state.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      return { contents: [{ uri: uri.href, text: JSON.stringify(await freshness.getAnalysisFreshness(entry.path)) }] };
    }
  );

  server.registerResource(
    'project-test-discovery',
    new ResourceTemplate('klauro://{project_name}/test-discovery', { list: undefined }),
    { title: 'Test Discovery Evidence', description: 'Repo scan proving whether missing CAS tests are true absence or analyzer coverage gaps.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(await testDiscovery.getTestDiscoveryEvidence(entry.path, cas)) }] };
    }
  );

  server.registerResource(
    'project-runtime-sdk',
    new ResourceTemplate('klauro://{project_name}/runtime-sdk', { list: undefined }),
    { title: 'Runtime SDK Package', description: 'Generated TypeScript SDK package for emitting CAS-correlated runtime telemetry.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(runtimeSdk.getRuntimeSdkPackage(cas)) }] };
    }
  );

  server.registerResource(
    'project-integration-depth',
    new ResourceTemplate('klauro://{project_name}/integration-depth', { list: undefined }),
    { title: 'Integration Depth', description: 'Library and platform integration coverage with missing analyzer depth.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(integrationDepth.getIntegrationDepthReport(cas)) }] };
    }
  );

  server.registerResource(
    'project-endpoints',
    new ResourceTemplate('klauro://{project_name}/endpoints', { list: undefined }),
    { title: 'Project Endpoints', description: 'All entry points and route table.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify({ entry_points: query.getEntryPoints(cas), route_table: query.getRouteTable(cas) }) }] };
    }
  );

  server.registerResource(
    'project-schema',
    new ResourceTemplate('klauro://{project_name}/schema', { list: undefined }),
    { title: 'Project Schema', description: 'Database schema and data entities.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify({ database_schema: query.getDatabaseSchema(cas), data_entities: query.getDataEntities(cas) }) }] };
    }
  );

  server.registerResource(
    'project-security',
    new ResourceTemplate('klauro://{project_name}/security', { list: undefined }),
    { title: 'Project Security', description: 'Security boundaries, trust transitions, protection gaps.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(query.getSecurityOverview(cas)) }] };
    }
  );

  server.registerResource(
    'project-health',
    new ResourceTemplate('klauro://{project_name}/health', { list: undefined }),
    { title: 'Project Health', description: 'Implementation health, documentation coverage, TODO summary, analysis errors.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            implementation_health: query.getImplementationHealth(cas),
            system_health: query.getSystemHealth(cas),
            documentation_coverage: query.getDocumentationCoverage(cas),
            todos: query.getTodos(cas),
            analysis_errors: cas.analysis_errors,
          }),
        }],
      };
    }
  );

  server.registerResource(
    'project-flows',
    new ResourceTemplate('klauro://{project_name}/flows', { list: undefined }),
    { title: 'Project Flows', description: 'Flow summary, workflow graph, flow coverage overview.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            flow_summary: cas.flow_summary,
            workflows: query.getWorkflows(cas),
            flow_coverage: query.getFlowCoverage(cas),
          }),
        }],
      };
    }
  );

  server.registerResource(
    'project-risks',
    new ResourceTemplate('klauro://{project_name}/risks', { list: undefined }),
    { title: 'Project Risks', description: 'Change risk summary, stability summary, test gaps.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            change_risk_summary: cas.change_risk_summary,
            stability_summary: cas.stability_summary,
            test_gaps: cas.test_gaps,
          }),
        }],
      };
    }
  );
}

function registerPrompts(server: McpServer) {
  server.registerPrompt(
    'agent_coding_session',
    {
      title: 'Agent Coding Session',
      description: 'Default prompt for Codex, Claude, Cursor, and other agents. Resolves the best analysis, then loads CAS readiness, start context, and task-specific MCP tool plan before source-file exploration.',
      argsSchema: {
        path: z.string().describe('Project path'),
        task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional().describe('Task type'),
        target: z.string().optional().describe('Task target, such as a feature, node, file, route, error, or subsystem'),
        instructions: z.string().optional().describe('Exact user instructions to preserve in the work packet'),
        success_criteria: z.array(z.string()).optional().describe('Success criteria for the task'),
      } as any,
    } as any,
    async ({ path, task_type, target, instructions, success_criteria }: any) => {
      const task = { task_type: task_type || 'orient', target, instructions, success_criteria };
      const resolution = await agentProjectMap.resolveAgentAnalysis({ path, task });
      const selectedPath = resolution.selected_path || path;
      const cas = await getAnalysis(selectedPath);
      const bootstrap = await agentBootstrap.getAgentBootstrap(cas, selectedPath, task);
      const prefix = resolution.selected_path && resolution.selected_path !== path
        ? `# Analysis Resolution\nRequested path: ${path}\nSelected path: ${resolution.selected_path}\nRecommendation: ${resolution.recommendation}\n\n`
        : '';

      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: `${prefix}${bootstrap.prompt}` } as any,
        }],
      };
    }
  );

  server.registerPrompt(
    'architectural_context',
    {
      title: 'Architectural Context',
      description: 'Generates comprehensive architectural context for a codebase. Inject at the start of a coding session for full awareness.',
      argsSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => {
      const cas = await getAnalysis(path);
      const summary = query.buildSummary(cas);
      const overview = query.getSystemOverview(cas);
      const routes = query.getRouteTable(cas);
      const schema = query.getDatabaseSchema(cas);
      const security = query.getSecurityOverview(cas);
      const patterns = query.getPatterns(cas);
      const idioms = idiomQuery.getCodebaseIdioms(cas, { limit: 10 });

      const sections: string[] = [];

      sections.push(`# Architectural Context: ${cas.system.name}`);
      sections.push(`System type: ${overview.system_purpose?.primary_type || cas.system.type}`);
      if (overview.enhanced_system_purpose) {
        sections.push(`Domain: ${overview.enhanced_system_purpose.primary_domain}`);
        sections.push(`Description: ${overview.enhanced_system_purpose.inferred_description}`);
        sections.push(`Core concepts: ${overview.enhanced_system_purpose.core_concepts?.join(', ') || ''}`);
      }

      sections.push(`\n## Tech Stack`);
      const techs = cas.system.technologies;
      if (techs?.languages) sections.push(`Languages: ${techs.languages.map(l => l.name).join(', ')}`);
      if (techs?.frameworks) sections.push(`Frameworks: ${techs.frameworks.map(f => f.name).join(', ')}`);
      if (techs?.databases) sections.push(`Databases: ${techs.databases.join(', ')}`);

      if (overview.architecture_summary) {
        sections.push(`\n## Architecture Layers`);
        const layers = overview.architecture_summary.layers;
        if (layers?.presentation) sections.push(`Presentation: ${JSON.stringify(layers.presentation)}`);
        if (layers?.business) sections.push(`Business: ${JSON.stringify(layers.business)}`);
        if (layers?.data) sections.push(`Data: ${JSON.stringify(layers.data)}`);
        if (layers?.infrastructure) sections.push(`Infrastructure: ${JSON.stringify(layers.infrastructure)}`);
      }

      if (overview.system_health) {
        sections.push(`\n## System Health`);
        sections.push(`Status: ${overview.system_health.status}, score: ${overview.system_health.score}`);
        sections.push(`Coherence: ${overview.system_health.coherence?.status || 'unknown'}`);
        for (const area of (overview.system_health.risk_areas || []).slice(0, 5)) {
          sections.push(`  ${area.severity}: ${area.title} - ${area.recommendation}`);
        }
      }

      sections.push(`\n## Scale`);
      sections.push(`Nodes: ${summary.nodes} (${Object.entries(summary.nodes_by_type).map(([k, v]) => `${k}:${v}`).join(', ')})`);
      sections.push(`Edges: ${summary.edges}`);
      sections.push(`Entry points: ${summary.entry_points} (${Object.entries(summary.entry_points_by_type).map(([k, v]) => `${k}:${v}`).join(', ')})`);

      if (routes.total > 0) {
        sections.push(`\n## API Routes (${routes.total} total)`);
        for (const r of routes.routes.slice(0, 30)) {
          sections.push(`  ${r.method.padEnd(7)} ${r.path} -> ${r.controller}.${r.handler}${r.auth ? ' [AUTH]' : ''}`);
        }
        if (routes.total > 30) sections.push(`  ... and ${routes.total - 30} more`);
      }

      if (schema) {
        sections.push(`\n## Database (${schema.orm || 'unknown ORM'})`);
        sections.push(`Entities: ${schema.entities.map(e => e.name).join(', ')}`);
      }

      if (summary.capabilities > 0) {
        const flowGraph = query.getFlowGraph(cas);
        sections.push(`\n## Capabilities (${summary.capabilities} total)`);
        if (flowGraph?.system_insights) {
          sections.push(`Patterns: ${flowGraph.system_insights.detected_patterns?.join(', ') || 'none'}`);
          sections.push(`Primary entry: ${flowGraph.system_insights.primary_entry_type || 'unknown'}`);
          sections.push(`Data flow: ${flowGraph.system_insights.data_flow_type || 'unknown'}`);
        }
        if (summary.top_capabilities.length > 0) {
          sections.push(`\nTop capabilities: ${summary.top_capabilities.join(', ')}`);
        }
      }

      if (security.security_boundaries.length > 0) {
        sections.push(`\n## Security`);
        sections.push(`Boundaries: ${security.security_boundaries.length}`);
        if (security.security_summary) {
          sections.push(`Enforced: ${security.security_summary.assumed_vs_enforced.enforced}, Assumed: ${security.security_summary.assumed_vs_enforced.assumed}, Missing: ${security.security_summary.assumed_vs_enforced.missing}`);
        }
      }

      if (patterns.patterns.length > 0) {
        sections.push(`\n## Patterns`);
        for (const p of patterns.patterns) {
          sections.push(`  ${p.name} (${p.type || 'pattern'}, confidence: ${p.confidence}, instances: ${p.instance_count})`);
        }
      }

      if (idioms.total > 0) {
        sections.push(`\n## Codebase Idioms`);
        for (const idiom of idioms.idioms.slice(0, 10)) {
          sections.push(`  ${idiom.name} (${idiom.category}, confidence: ${idiom.confidence})`);
        }
      }

      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: sections.join('\n') } as any,
        }],
      };
    }
  );

  server.registerPrompt(
    'safe_modification_guide',
    {
      title: 'Safe Modification Guide',
      description: 'Generates guidance for safely modifying a specific code element, including callers, test coverage, risk assessment, and related components.',
      argsSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to modify'),
      } as any,
    } as any,
    async ({ path, node_id }: any) => {
      const cas = await getAnalysis(path);
      const node = query.getNode(cas, node_id);
      if (!node) {
        return { messages: [{ role: 'user', content: { type: 'text', text: `Node not found: ${node_id}` } }] };
      }

      const callers = query.getCallers(cas, node_id, 3);
      const risk = query.assessChangeRisk(cas, node_id);
      const tests = query.findTests(cas, { nodeId: node_id });
      const stability = query.getStability(cas, node_id);
      const invariants = query.getBehavioralInvariants(cas, { target: node_id, limit: 8 });
      const idiomContext = idiomQuery.buildIdiomContextForAgent(cas, {
        target: node_id,
        files: node.source?.file ? [node.source.file] : [],
        limit: 8,
      });
      const invariantImpact = invariantValidation.assessBehavioralInvariantImpact(cas, {
        target: node_id,
        files: node.source?.file ? [node.source.file] : [],
        limit: 8,
      });

      const sections: string[] = [];
      sections.push(`# Safe Modification Guide: ${node.name}`);
      sections.push(`Type: ${node.type}, File: ${node.source?.file}:${node.source?.line}`);

      if (risk.risk) {
        sections.push(`\n## Risk Assessment: ${risk.risk.risk_level.toUpperCase()}`);
        sections.push(`Factors: ${risk.risk.risk_factors.map(f => f.factor).join(', ')}`);
        sections.push(`Direct callers: ${risk.risk.downstream_impact.direct_callers.length}`);
        sections.push(`Transitive callers: ${risk.risk.downstream_impact.transitive_callers.length}`);
        sections.push(`Affected entry points: ${risk.risk.downstream_impact.affected_entry_points.length}`);
        if (risk.risk.recommendations) {
          sections.push(`\nRecommendations:`);
          for (const r of risk.risk.recommendations) sections.push(`  - ${r}`);
        }
      }

      sections.push(`\n## Callers (${callers.total} found${callers.truncated ? ', truncated' : ''})`);
      for (const c of callers.callers.slice(0, 20)) {
        sections.push(`  ${'  '.repeat(c.depth - 1)}${c.name} (${c.type}) via ${c.via}`);
      }

      sections.push(`\n## Test Coverage`);
      sections.push(`Test suites covering this node: ${tests.suites.length}`);
      if (tests.suites.length > 0) {
        for (const s of tests.suites) {
          sections.push(`  ${s.name} (${s.test_type}, ${s.tests.length} tests)`);
        }
      } else {
        sections.push(`  WARNING: No tests directly cover this node.`);
      }

      sections.push(`\n## Behavioral Invariants`);
      sections.push(`Relevant invariants: ${invariants.total}`);
      for (const invariant of invariants.invariants.slice(0, 8)) {
        const gaps = invariant.gaps?.length ? `, gaps=${invariant.gaps.length}` : '';
        sections.push(`  [${invariant.confidence}] ${invariant.name} (${invariant.invariant_type}${gaps})`);
      }
      sections.push(`Invariant impact status: ${invariantImpact.status}, impacted=${invariantImpact.impacted_count}`);
      sections.push(`After edits, call validate_behavioral_invariants with path=${JSON.stringify(path)} and target=${JSON.stringify(node_id)} before finalizing.`);

      sections.push(`\n## Codebase Idioms`);
      sections.push(`Relevant idioms: ${idiomContext.selected_idioms.length}`);
      for (const idiom of idiomContext.selected_idioms.slice(0, 8)) {
        sections.push(`  [${idiom.confidence}] ${idiom.name} (${idiom.category})`);
        if (idiom.do?.[0]) sections.push(`    Do: ${idiom.do[0]}`);
        if (idiom.avoid?.[0]) sections.push(`    Avoid: ${idiom.avoid[0]}`);
      }
      sections.push(`After edits, call validate_codebase_idioms with path=${JSON.stringify(path)} and target=${JSON.stringify(node_id)} before finalizing.`);

      if (stability && 'stability_score' in stability) {
        sections.push(`\n## Stability`);
        sections.push(`Score: ${stability.stability_score}, Class: ${stability.stability_class}`);
        sections.push(`Commits (30d): ${stability.churn_metrics.commits_30d}, Authors: ${stability.churn_metrics.unique_authors_30d}`);
      }

      sections.push(`\n## Connected Components`);
      sections.push(`Incoming edges: ${node.incoming_edges.length}`);
      sections.push(`Outgoing edges: ${node.outgoing_edges.length}`);
      sections.push(`Entry points: ${node.entry_points.length}`);
      sections.push(`Exit points: ${node.exit_points.length}`);

      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: sections.join('\n') } as any,
        }],
      };
    }
  );

  server.registerPrompt(
    'test_coverage_analysis',
    {
      title: 'Test Coverage Analysis',
      description: 'Generates a test coverage report highlighting gaps, untested critical paths, and recommendations.',
      argsSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => {
      const cas = await getAnalysis(path);
      const testSummary = query.getTestSummary(cas);
      const flowCoverage = query.getFlowCoverage(cas);
      const health = query.getImplementationHealth(cas);

      const sections: string[] = [];
      sections.push(`# Test Coverage Analysis: ${cas.system.name}`);

      if (testSummary.test_summary) {
        const ts = testSummary.test_summary;
        sections.push(`\n## Overview`);
        sections.push(`Total tests: ${ts.total_tests}`);
        sections.push(`By type: unit=${ts.by_type.unit}, integration=${ts.by_type.integration}, e2e=${ts.by_type.e2e}, acceptance=${ts.by_type.acceptance}`);
        sections.push(`Coverage: ${ts.coverage.overall_percentage ? ts.coverage.overall_percentage + '%' : 'unknown'}`);
        sections.push(`Mocks: ${ts.mocks.total}, Fixtures: ${ts.fixtures.total}`);
      }

      if (testSummary.test_gaps.length > 0) {
        sections.push(`\n## Test Gaps (${testSummary.test_gaps.length})`);
        const bySeverity: Record<string, number> = {};
        for (const g of testSummary.test_gaps) {
          bySeverity[g.severity] = (bySeverity[g.severity] || 0) + 1;
        }
        sections.push(`By severity: ${Object.entries(bySeverity).map(([k, v]) => `${k}:${v}`).join(', ')}`);

        const critical = testSummary.test_gaps.filter(g => g.severity === 'critical' || g.severity === 'high');
        for (const g of critical.slice(0, 20)) {
          sections.push(`  [${g.severity}] ${g.gap_type}: ${g.recommendation}`);
        }
      }

      const fc = flowCoverage as { total_flows?: number; by_coverage_status?: Record<string, number>; total_test_gaps?: number; test_gaps_by_severity?: Record<string, number> };
      if (fc.total_flows && fc.total_flows > 0) {
        sections.push(`\n## Flow Coverage (${fc.total_flows} flows)`);
        for (const [status, count] of Object.entries(fc.by_coverage_status || {})) {
          sections.push(`  ${status}: ${count}`);
        }
        if (fc.total_test_gaps && fc.total_test_gaps > 0) {
          sections.push(`Test gaps: ${fc.total_test_gaps}`);
          for (const [sev, count] of Object.entries(fc.test_gaps_by_severity || {})) {
            sections.push(`  ${sev}: ${count}`);
          }
        }
      }

      if (health) {
        sections.push(`\n## Implementation Health`);
        sections.push(`Health score: ${health.health_score}`);
        sections.push(`Complete: ${health.complete_implementations}, Partial: ${health.partial_implementations}, Stubs: ${health.stubs}`);
        if (health.risk_areas.length > 0) {
          sections.push(`Risk areas:`);
          for (const r of health.risk_areas.slice(0, 10)) {
            sections.push(`  [${r.risk_level}] ${r.node_name}: ${r.recommendation}`);
          }
        }
      }

      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: sections.join('\n') } as any,
        }],
      };
    }
  );
}

function slugify(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 80);
}
