import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { analyzeProject, getAnalysis, analyzeProjectIncremental } from './analyzer';
import { getStorageHealth, listAgenticBenchmarkReports, listAnalyses, listWorkspaceGraphs, loadAgenticBenchmarkReport, loadGoldenSnapshot, loadRuntimeObservations, loadRuntimeTrace, loadWorkspaceGraph, saveAgenticBenchmarkReport, saveGoldenSnapshot, saveRuntimeObservation, saveWorkspaceGraph } from './storage';
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
import { formatMarkdownReport, runAgenticBenchmark } from './agent-benchmark';
import { formatQualityMarkdownReport, runAgentQualityBenchmark } from './agent-quality-benchmark';

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'unravl', version: '1.0.0' },
    {
      capabilities: {
        resources: {},
        tools: {},
        prompts: {},
      },
    }
  );

  registerTools(server);
  registerResources(server);
  registerPrompts(server);

  return server;
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
      } as any,
    } as any,
    async ({ path, force_full }: any) => withErrorHandling(async () => {
      if (force_full) {
        const result = await analyzeProject(path);
        return json({
          status: 'success',
          analysis_type: 'full',
          path,
          name: result.system?.name || path.split('/').pop(),
          nodes: result.nodes?.length || 0,
          edges: result.edges?.length || 0,
          entry_points: result.entry_points?.length || 0,
          analyzers_run: result.analyzer_contributions?.length || 0,
          errors: result.analysis_errors?.length || 0,
        });
      }

      const result = await analyzeProjectIncremental(path);
      return json({
        status: 'success',
        analysis_type: result.wasFullRebuild ? 'full' : 'incremental',
        path,
        name: result.output.system?.name || path.split('/').pop(),
        nodes: result.output.nodes?.length || 0,
        edges: result.output.edges?.length || 0,
        entry_points: result.output.entry_points?.length || 0,
        analyzers_run: result.output.analyzer_contributions?.length || 0,
        errors: result.output.analysis_errors?.length || 0,
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
        }).optional().describe('Optional task context for tailoring the default bootstrap'),
      } as any,
    } as any,
    async ({ path, task }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(agentBootstrap.getAgentBootstrap(cas, path, task || {}));
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
      description: 'Write .unravl/agent-defaults.json and .unravl/agent-defaults.md into a repository so agents have a default Unravl start path.',
      inputSchema: {
        path: z.string().describe('Project path'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
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
      description: 'Default first-call context for Codex, Claude, and other coding agents. Returns CAS-backed orientation, readiness, top graph anchors, answer-pack status, and recommended first MCP calls before broad file reads.',
      inputSchema: {
        path: z.string().describe('Project path'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
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
      description: 'Task-specific MCP call plan for agents. Use before deciding whether to read files so the CAS graph narrows the work area first.',
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
      description: 'One-call task packet for agents. Resolves the target, returns coding context, risk, callers, callees, tests, entry context, MCP follow-ups, and the first source files to inspect.',
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
      return json(agentAdoption.getAgentWorkPacket(cas, path, task || {}));
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
        }).optional().describe('Ground-truth expectations. If omitted, MCP tries repo-local .unravl/analysis-expectations.json.'),
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
      description: 'Build contract-level views across repositories: provided HTTP/message/database contracts, consumed APIs/messages/databases, deterministic links, and contract gaps.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Project paths to include. Omit to use all analyzed repositories.'),
      } as any,
    } as any,
    async ({ paths }: any) => withErrorHandling(async () => {
      const repositories = await loadRepositoryAnalyses(paths);
      return json(analysisMastery.getCrossRepoContracts(repositories));
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
      return json(analysisMastery.evaluateAgentTaskProof(cas, path, tasks || [{ task_type: 'orient' }]));
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
      description: 'Benchmark the same agent task with Unravl vs without Unravl using deterministic token/file/speed estimates and a two-agent live-run protocol.',
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
        list: z.boolean().optional().describe('When true, list reports instead of loading one.'),
      } as any,
    } as any,
    async ({ id, list }: any) => withErrorHandling(async () => {
      if (list) return json(await listAgenticBenchmarkReports());
      const report = await loadAgenticBenchmarkReport(id || 'latest');
      if (!report) return json({ error: `Agentic benchmark report not found: ${id || 'latest'}` });
      return json({ report, markdown: formatMarkdownReport(report) });
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
        agent_with_command: z.string().optional().describe('Live with-Unravl agent command template. Supports {workspace}, {prompt_file}, {metrics_file}, {result_file}, {arm}, and {task_id}.'),
        agent_without_command: z.string().optional().describe('Live without-Unravl agent command template. Supports {workspace}, {prompt_file}, {metrics_file}, {result_file}, {arm}, and {task_id}.'),
        orchestrator_command: z.string().optional().describe('Optional evaluator command template. Supports {evaluation_input}, {evaluation_file}, {with_workspace}, {without_workspace}, {with_diff}, and {without_diff}.'),
        test_command: z.string().optional().describe('Optional command to run inside each copied repo after the agent attempt.'),
        work_root: z.string().optional().describe('Directory for live repo copies and benchmark artifacts.'),
        max_live_tasks: z.number().optional().describe('Maximum task pairs to run through live agents.'),
        timeout_ms: z.number().optional().describe('Per-agent command timeout in milliseconds.'),
        test_timeout_ms: z.number().optional().describe('Per-test command timeout in milliseconds.'),
        orchestrator_timeout_ms: z.number().optional().describe('Evaluator command timeout in milliseconds.'),
      } as any,
    } as any,
    async ({ paths, task, max_tasks_per_repo, agent_with_command, agent_without_command, orchestrator_command, test_command, work_root, max_live_tasks, timeout_ms, test_timeout_ms, orchestrator_timeout_ms }: any) => withErrorHandling(async () => {
      const selectedPaths = paths && paths.length > 0 ? paths : (await listAnalyses()).map(analysis => analysis.path);
      const report = await runAgentQualityBenchmark({
        repos: selectedPaths.map((repoPath: string) => ({ path: repoPath })),
        maxTasksPerRepo: max_tasks_per_repo,
        task: task || undefined,
        commands: {
          withUnravl: agent_with_command,
          withoutUnravl: agent_without_command,
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
      return json({ saved, report, markdown: formatQualityMarkdownReport(report) });
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
      description: 'Find code elements (classes, functions, modules, etc.) by name, type, category, or level.',
      inputSchema: {
        path: z.string().describe('Project path'),
        query: z.string().describe('Search query (matches name, qualified_name, description)'),
        type: z.string().optional().describe('Filter by node type (e.g. class, function, module, service, controller)'),
        category: z.string().optional().describe('Filter by category'),
        level: z.number().optional().describe('Filter by hierarchy level'),
        limit: z.number().optional().describe('Max results (default 25)'),
      } as any,
    } as any,
    async ({ path, query: q, type, category, level, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.searchNodes(cas, q, { type, category, level, limit }));
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
        event: eventWithTimestamp,
        correlation: product.correlateRuntimeEvent(cas, eventWithTimestamp),
      };
      await saveRuntimeObservation(path, observation);
      return json(observation);
    })
  );

  server.registerTool(
    'get_runtime_observations',
    {
      title: 'Get Runtime Observations',
      description: 'Query stored runtime observations and their CAS correlations. Filter by type, timestamp, or static CAS id.',
      inputSchema: {
        path: z.string().describe('Project path'),
        type: z.enum(['request', 'error', 'exit', 'log', 'custom']).optional().describe('Runtime event type'),
        since: z.string().optional().describe('ISO timestamp lower bound'),
        static_id: z.string().optional().describe('CAS node, entry point, exit point, call chain, or runtime link id'),
        trace_id: z.string().optional().describe('Runtime trace id'),
        span_id: z.string().optional().describe('Runtime span id or parent span id'),
        limit: z.number().optional().describe('Max results (default storage order, newest first)'),
      } as any,
    } as any,
    async ({ path, type, since, static_id, trace_id, span_id, limit }: any) => withErrorHandling(async () => {
      return json(await loadRuntimeObservations(path, {
        type,
        since,
        staticId: static_id,
        traceId: trace_id,
        spanId: span_id,
        limit,
      }));
    })
  );

  server.registerTool(
    'get_runtime_trace',
    {
      title: 'Get Runtime Trace',
      description: 'Replay stored runtime observations for a trace id with matched CAS static ids.',
      inputSchema: {
        path: z.string().describe('Project path'),
        trace_id: z.string().describe('Runtime trace id'),
      } as any,
    } as any,
    async ({ path, trace_id }: any) => withErrorHandling(async () => {
      return json(await loadRuntimeTrace(path, trace_id));
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

function registerResources(server: McpServer) {
  server.registerResource(
    'analyses-list',
    'unravl://analyses',
    { title: 'All Analyses', description: 'List of all analyzed codebases with metadata.', mimeType: 'application/json' } as any,
    async () => {
      const analyses = await listAnalyses();
      return { contents: [{ uri: 'unravl://analyses', text: JSON.stringify(analyses) }] };
    }
  );

  server.registerResource(
    'workspace-graphs-list',
    'unravl://workspaces',
    { title: 'Workspace Graphs', description: 'Persisted multi-repository workspace graphs.', mimeType: 'application/json' } as any,
    async () => {
      const graphs = await listWorkspaceGraphs();
      return { contents: [{ uri: 'unravl://workspaces', text: JSON.stringify(graphs) }] };
    }
  );

  server.registerResource(
    'workspace-graph',
    new ResourceTemplate('unravl://workspace/{workspace_id_or_name}/graph', { list: undefined }),
    { title: 'Workspace Graph', description: 'Persisted cross-repository graph with links, conflicts, confidence, and review decisions.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const graph = await loadWorkspaceGraph(String(params.workspace_id_or_name));
      if (!graph) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Workspace graph not found' }) }] };
      return { contents: [{ uri: uri.href, text: JSON.stringify({ summary: workspaceGraph.summarizeWorkspaceGraph(graph), graph }) }] };
    }
  );

  server.registerResource(
    'agentic-benchmark-reports',
    'unravl://agentic-benchmarks',
    { title: 'Agentic Benchmark Reports', description: 'Persisted with-Unravl vs without-Unravl agent benchmark reports.', mimeType: 'application/json' } as any,
    async () => {
      const reports = await listAgenticBenchmarkReports();
      return { contents: [{ uri: 'unravl://agentic-benchmarks', text: JSON.stringify(reports) }] };
    }
  );

  server.registerResource(
    'agentic-benchmark-report',
    new ResourceTemplate('unravl://agentic-benchmark/{report_id}', { list: undefined }),
    { title: 'Agentic Benchmark Report', description: 'A persisted agent benchmark report with deterministic estimates and a two-agent run sheet.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const report = await loadAgenticBenchmarkReport(String(params.report_id));
      if (!report) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Agentic benchmark report not found' }) }] };
      return { contents: [{ uri: uri.href, text: JSON.stringify({ report, markdown: formatMarkdownReport(report) }) }] };
    }
  );

  server.registerResource(
    'project-overview',
    new ResourceTemplate('unravl://{project_name}/overview', { list: undefined }),
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
    new ResourceTemplate('unravl://{project_name}/agent-bootstrap', { list: undefined }),
    { title: 'Agent Bootstrap', description: 'One payload with agent readiness, start context, MCP plan, work packet, and prompt text.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(agentBootstrap.getAgentBootstrap(cas, entry.path)) }] };
    }
  );

  server.registerResource(
    'project-agent-start',
    new ResourceTemplate('unravl://{project_name}/agent-start', { list: undefined }),
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
    new ResourceTemplate('unravl://{project_name}/runtime-event-contract', { list: undefined }),
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
    new ResourceTemplate('unravl://{project_name}/cas-contract', { list: undefined }),
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
    new ResourceTemplate('unravl://{project_name}/agent-readiness', { list: undefined }),
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
    new ResourceTemplate('unravl://{project_name}/agent-doctor', { list: undefined }),
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
    new ResourceTemplate('unravl://{project_name}/agent-defaults', { list: undefined }),
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
    new ResourceTemplate('unravl://{project_name}/freshness', { list: undefined }),
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
    new ResourceTemplate('unravl://{project_name}/test-discovery', { list: undefined }),
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
    new ResourceTemplate('unravl://{project_name}/runtime-sdk', { list: undefined }),
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
    new ResourceTemplate('unravl://{project_name}/integration-depth', { list: undefined }),
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
    new ResourceTemplate('unravl://{project_name}/endpoints', { list: undefined }),
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
    new ResourceTemplate('unravl://{project_name}/schema', { list: undefined }),
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
    new ResourceTemplate('unravl://{project_name}/security', { list: undefined }),
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
    new ResourceTemplate('unravl://{project_name}/health', { list: undefined }),
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
    new ResourceTemplate('unravl://{project_name}/flows', { list: undefined }),
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
    new ResourceTemplate('unravl://{project_name}/risks', { list: undefined }),
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
      description: 'Default prompt for Codex, Claude, Cursor, and other agents. Loads CAS readiness, start context, and task-specific MCP tool plan before source-file exploration.',
      argsSchema: {
        path: z.string().describe('Project path'),
        task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional().describe('Task type'),
        target: z.string().optional().describe('Task target, such as a feature, node, file, route, error, or subsystem'),
      } as any,
    } as any,
    async ({ path, task_type, target }: any) => {
      const cas = await getAnalysis(path);
      const task = { task_type: task_type || 'orient', target };
      const bootstrap = agentBootstrap.getAgentBootstrap(cas, path, task);

      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: bootstrap.prompt } as any,
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
