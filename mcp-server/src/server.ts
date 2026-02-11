import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { analyzeProject, getAnalysis, analyzeProjectIncremental } from './analyzer';
import { listAnalyses, saveAnalysis } from './storage';
import * as query from './query';
import * as watcher from './watcher';

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
    async ({ path, force_full }: any) => {
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
    }
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
      return json(query.buildSummary(result));
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
