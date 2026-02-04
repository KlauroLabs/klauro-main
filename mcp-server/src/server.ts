import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { analyzeProject, getAnalysis } from './analyzer';
import { listAnalyses, saveAnalysis } from './storage';
import * as query from './query';

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
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function registerTools(server: McpServer) {

  // -- Analysis Management --

  server.registerTool(
    'analyze_codebase',
    {
      title: 'Analyze Codebase',
      description: 'Run full CAS analysis on a local directory path. Detects languages, frameworks, and libraries. Stores results for querying.',
      inputSchema: { path: z.string().describe('Absolute path to the project directory') },
    },
    async ({ path }) => {
      const result = await analyzeProject(path);
      const summary = query.buildSummary(result);
      return json(summary);
    }
  );

  server.registerTool(
    'list_analyses',
    {
      title: 'List Analyses',
      description: 'List all previously analyzed codebases with metadata.',
      inputSchema: {},
    },
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
      inputSchema: { path: z.string().describe('Project path (must be previously analyzed)') },
    },
    async ({ path }) => {
      const cas = await getAnalysis(path);
      return json(query.buildSummary(cas));
    }
  );

  server.registerTool(
    'get_system_overview',
    {
      title: 'Get System Overview',
      description: 'Full system metadata: system info, architecture summary, system purpose, capabilities, progressive levels, analyzer contributions, configuration, runtime, errors, validation.',
      inputSchema: { path: z.string().describe('Project path') },
    },
    async ({ path }) => {
      const cas = await getAnalysis(path);
      return json(query.getSystemOverview(cas));
    }
  );

  server.registerTool(
    'get_patterns',
    {
      title: 'Get Patterns',
      description: 'Design patterns and anti-patterns detected in the codebase, with variations and deviations.',
      inputSchema: { path: z.string().describe('Project path') },
    },
    async ({ path }) => {
      const cas = await getAnalysis(path);
      return json(query.getPatterns(cas));
    }
  );

  server.registerTool(
    'get_perspectives',
    {
      title: 'Get Perspectives',
      description: 'Multi-view analysis perspectives with connection rules and layout hints.',
      inputSchema: { path: z.string().describe('Project path') },
    },
    async ({ path }) => {
      const cas = await getAnalysis(path);
      return json(query.getPerspectives(cas));
    }
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
      },
    },
    async ({ path, query: q, type, category, level, limit }) => {
      const cas = await getAnalysis(path);
      return json(query.searchNodes(cas, q, { type, category, level, limit }));
    }
  );

  server.registerTool(
    'get_node',
    {
      title: 'Get Node Details',
      description: 'Full details for a specific code element: signature, metadata, documentation, call graph, children, connected edges, entry/exit points, decorators, intent, change risk, stability.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID from search results or other tools'),
      },
    },
    async ({ path, node_id }) => {
      const cas = await getAnalysis(path);
      const result = query.getNode(cas, node_id);
      if (!result) return json({ error: `Node not found: ${node_id}` });
      return json(result);
    }
  );

  server.registerTool(
    'get_file_nodes',
    {
      title: 'Get File Nodes',
      description: 'All code elements defined in a specific file, with their internal relationships.',
      inputSchema: {
        path: z.string().describe('Project path'),
        file_path: z.string().describe('Relative file path within the project'),
      },
    },
    async ({ path, file_path }) => {
      const cas = await getAnalysis(path);
      return json(query.getFileNodes(cas, file_path));
    }
  );

  server.registerTool(
    'get_level',
    {
      title: 'Get Level',
      description: 'Progressive disclosure: get all nodes, edges, entry points, and exit points at a specific hierarchy level. Level 0 is the system-wide view, level 1 is major subsystems, deeper levels reveal more detail. Returns the level definition, all available levels, nodes at the requested level, internal edges between those nodes, cross-level edges to nodes at other levels, and entry/exit points.',
      inputSchema: {
        path: z.string().describe('Project path'),
        level: z.number().describe('Hierarchy level (0 = system, 1 = subsystems, deeper = more detail)'),
      },
    },
    async ({ path, level }) => {
      const cas = await getAnalysis(path);
      return json(query.getLevel(cas, level));
    }
  );

  // -- Entry/Exit Points & Routes --

  server.registerTool(
    'get_entry_points',
    {
      title: 'Get Entry Points',
      description: 'All system entry points (HTTP endpoints, CLI commands, WebSocket handlers, event listeners, scheduled tasks, etc.). Optionally filter by type.',
      inputSchema: {
        path: z.string().describe('Project path'),
        type: z.string().optional().describe('Filter by type: http, websocket, cli, event, schedule, page, route, message, file, test'),
      },
    },
    async ({ path, type }) => {
      const cas = await getAnalysis(path);
      return json(query.getEntryPoints(cas, type));
    }
  );

  server.registerTool(
    'get_exit_points',
    {
      title: 'Get Exit Points',
      description: 'All external interactions (database calls, API calls, file operations, message publishing, cache operations, SDK calls, webhooks).',
      inputSchema: {
        path: z.string().describe('Project path'),
        type: z.string().optional().describe('Filter by type: database, api, file, message, cache, sdk, webhook'),
      },
    },
    async ({ path, type }) => {
      const cas = await getAnalysis(path);
      return json(query.getExitPoints(cas, type));
    }
  );

  server.registerTool(
    'get_route_table',
    {
      title: 'Get Route Table',
      description: 'HTTP route table: method, path, controller, handler, auth requirements, guards, middleware.',
      inputSchema: { path: z.string().describe('Project path') },
    },
    async ({ path }) => {
      const cas = await getAnalysis(path);
      return json(query.getRouteTable(cas));
    }
  );

  server.registerTool(
    'get_external_services',
    {
      title: 'Get External Services',
      description: 'All external service integrations with purpose, endpoint, usage pattern, monitoring, and cost info.',
      inputSchema: { path: z.string().describe('Project path') },
    },
    async ({ path }) => {
      const cas = await getAnalysis(path);
      return json(query.getExternalServices(cas));
    }
  );

  // -- Call Graph & Flow Tracing --

  server.registerTool(
    'get_callers',
    {
      title: 'Get Callers',
      description: 'Find all code elements that call or reference a given node. Traverses edges, method calls, and call chains.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to find callers for'),
        depth: z.number().optional().describe('Max traversal depth (default 2)'),
      },
    },
    async ({ path, node_id, depth }) => {
      const cas = await getAnalysis(path);
      return json(query.getCallers(cas, node_id, depth));
    }
  );

  server.registerTool(
    'get_callees',
    {
      title: 'Get Callees',
      description: 'Find all code elements that a given node calls or references.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to find callees for'),
        depth: z.number().optional().describe('Max traversal depth (default 2)'),
      },
    },
    async ({ path, node_id, depth }) => {
      const cas = await getAnalysis(path);
      return json(query.getCallees(cas, node_id, depth));
    }
  );

  server.registerTool(
    'get_call_chain',
    {
      title: 'Get Call Chain',
      description: 'Complete call chain from entry to exit: all steps, characteristics, risk analysis, business context, criticality, runtime stats, test coverage.',
      inputSchema: {
        path: z.string().describe('Project path'),
        chain_id: z.string().optional().describe('Specific call chain ID'),
        entry_point_id: z.string().optional().describe('Entry point ID to find chains for'),
      },
    },
    async ({ path, chain_id, entry_point_id }) => {
      const cas = await getAnalysis(path);
      return json(query.getCallChain(cas, { chainId: chain_id, entryPointId: entry_point_id }));
    }
  );

  server.registerTool(
    'get_method_calls',
    {
      title: 'Get Method Calls',
      description: 'All method calls made by or received by a node, with execution context (async, conditional, loop depth), arguments, external details, framework semantics, performance hints.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID'),
      },
    },
    async ({ path, node_id }) => {
      const cas = await getAnalysis(path);
      return json(query.getMethodCalls(cas, node_id));
    }
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
      },
    },
    async ({ path, node_id }) => {
      const cas = await getAnalysis(path);
      const result = query.getIntent(cas, node_id);
      if (!result) return json({ error: `No intent data for node: ${node_id}` });
      return json(result);
    }
  );

  server.registerTool(
    'get_data_entities',
    {
      title: 'Get Data Entities',
      description: 'Data entity lifecycle: entities with fields, CRUD lifecycle (created_by, read_by, updated_by, deleted_by), transformations, invariants, sensitive data, validation gaps.',
      inputSchema: {
        path: z.string().describe('Project path'),
        entity_name: z.string().optional().describe('Filter by entity name'),
      },
    },
    async ({ path, entity_name }) => {
      const cas = await getAnalysis(path);
      return json(query.getDataEntities(cas, entity_name));
    }
  );

  server.registerTool(
    'get_security_overview',
    {
      title: 'Get Security Overview',
      description: 'Security posture: trust boundaries, enforcement points (enforced/assumed/missing), bypass risks, unprotected operations, per-node trust levels and protection gaps.',
      inputSchema: { path: z.string().describe('Project path') },
    },
    async ({ path }) => {
      const cas = await getAnalysis(path);
      return json(query.getSecurityOverview(cas));
    }
  );

  server.registerTool(
    'get_stability',
    {
      title: 'Get Stability',
      description: 'Code stability and churn analysis. Per-node: stability score/class, commit metrics, bug fix rate, refactor frequency. Summary: hotspots, legacy areas, by-class breakdown.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().optional().describe('Specific node ID (omit for full summary)'),
      },
    },
    async ({ path, node_id }) => {
      const cas = await getAnalysis(path);
      return json(query.getStability(cas, node_id));
    }
  );

  server.registerTool(
    'assess_change_risk',
    {
      title: 'Assess Change Risk',
      description: 'Risk of modifying a code element: risk level, factors (many-callers, critical-path, no-tests, etc.), downstream impact (direct/transitive callers, affected chains and entry points), test protection, stability context, recommendations.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to assess'),
      },
    },
    async ({ path, node_id }) => {
      const cas = await getAnalysis(path);
      return json(query.assessChangeRisk(cas, node_id));
    }
  );

  server.registerTool(
    'get_flow_coverage',
    {
      title: 'Get Flow Coverage',
      description: 'Per-flow test coverage: coverage status (fully/partially/not covered), tested/untested segments with importance, test quality. Plus test gaps with severity and recommendations.',
      inputSchema: {
        path: z.string().describe('Project path'),
        chain_id: z.string().optional().describe('Specific call chain ID (omit for all flows)'),
      },
    },
    async ({ path, chain_id }) => {
      const cas = await getAnalysis(path);
      return json(query.getFlowCoverage(cas, chain_id));
    }
  );

  // -- Workflows & Capabilities --

  server.registerTool(
    'get_workflows',
    {
      title: 'Get Workflows',
      description: 'Business workflows (CRUD/process/query/command/composite): entry points, call chains, entities touched, services used, classification, criticality, dependencies. Includes workflow dependency graph.',
      inputSchema: {
        path: z.string().describe('Project path'),
        workflow_id: z.string().optional().describe('Specific workflow ID (omit for all)'),
      },
    },
    async ({ path, workflow_id }) => {
      const cas = await getAnalysis(path);
      return json(query.getWorkflows(cas, workflow_id));
    }
  );

  server.registerTool(
    'get_flow_graph',
    {
      title: 'Get Flow Graph',
      description: 'Capability-level architecture: capabilities with scores, dependencies, topology (root/leaf/critical path), primary flow (value chain), layers (entry/business/data/infrastructure), system insights.',
      inputSchema: { path: z.string().describe('Project path') },
    },
    async ({ path }) => {
      const cas = await getAnalysis(path);
      return json(query.getFlowGraph(cas));
    }
  );

  server.registerTool(
    'get_domain_concepts',
    {
      title: 'Get Domain Concepts',
      description: 'Core domain terminology: concepts with frequency, where they appear (entry points, entities, nodes), classification (core/supporting/infrastructure).',
      inputSchema: { path: z.string().describe('Project path') },
    },
    async ({ path }) => {
      const cas = await getAnalysis(path);
      return json(query.getDomainConcepts(cas));
    }
  );

  // -- Testing --

  server.registerTool(
    'find_tests',
    {
      title: 'Find Tests',
      description: 'Find test suites and test cases covering a specific node or file. Includes assertions, mocks, fixtures, and coverage info.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().optional().describe('Node ID to find tests for'),
        file_path: z.string().optional().describe('File path to find tests for'),
      },
    },
    async ({ path, node_id, file_path }) => {
      const cas = await getAnalysis(path);
      return json(query.findTests(cas, { nodeId: node_id, filePath: file_path }));
    }
  );

  server.registerTool(
    'get_test_summary',
    {
      title: 'Get Test Summary',
      description: 'Full test overview: counts by type/status, coverage, mocks, fixtures. Plus test gaps (untested flows, branches, mock-only coverage, no-assertion tests).',
      inputSchema: { path: z.string().describe('Project path') },
    },
    async ({ path }) => {
      const cas = await getAnalysis(path);
      return json(query.getTestSummary(cas));
    }
  );

  // -- Data & Schema --

  server.registerTool(
    'get_database_schema',
    {
      title: 'Get Database Schema',
      description: 'Database schema from ORM analysis: entities, fields (types, constraints), relationships (1:1, 1:N, M:N).',
      inputSchema: { path: z.string().describe('Project path') },
    },
    async ({ path }) => {
      const cas = await getAnalysis(path);
      return json(query.getDatabaseSchema(cas));
    }
  );

  // -- Code Health --

  server.registerTool(
    'get_implementation_health',
    {
      title: 'Get Implementation Health',
      description: 'Implementation completeness: complete/partial/stub/deprecated/experimental counts, health score, risk areas, deprecation timeline.',
      inputSchema: { path: z.string().describe('Project path') },
    },
    async ({ path }) => {
      const cas = await getAnalysis(path);
      return json(query.getImplementationHealth(cas));
    }
  );

  server.registerTool(
    'get_documentation_coverage',
    {
      title: 'Get Documentation Coverage',
      description: 'Documentation quality: coverage by type (functions, classes, interfaces, modules), quality metrics, missing documentation ranked by importance.',
      inputSchema: { path: z.string().describe('Project path') },
    },
    async ({ path }) => {
      const cas = await getAnalysis(path);
      return json(query.getDocumentationCoverage(cas));
    }
  );

  server.registerTool(
    'get_todos',
    {
      title: 'Get TODOs',
      description: 'TODO/FIXME tracking: counts by type/priority/category, tech debt items, blocking items, hotspot files.',
      inputSchema: { path: z.string().describe('Project path') },
    },
    async ({ path }) => {
      const cas = await getAnalysis(path);
      return json(query.getTodos(cas));
    }
  );

  // -- Dependencies & Libraries --

  server.registerTool(
    'get_dependencies',
    {
      title: 'Get Dependencies',
      description: 'Package dependencies: packages with versions, licenses, vulnerabilities.',
      inputSchema: { path: z.string().describe('Project path') },
    },
    async ({ path }) => {
      const cas = await getAnalysis(path);
      return json(query.getDependencies(cas));
    }
  );

  server.registerTool(
    'get_libraries',
    {
      title: 'Get Libraries',
      description: 'Library analysis: usage patterns, bundle size, security info, usage stats, optimization opportunities, replacement feasibility, alternatives.',
      inputSchema: { path: z.string().describe('Project path') },
    },
    async ({ path }) => {
      const cas = await getAnalysis(path);
      return json(query.getLibraries(cas));
    }
  );
}

function registerResources(server: McpServer) {
  server.registerResource(
    'analyses-list',
    'unravl://analyses',
    { title: 'All Analyses', description: 'List of all analyzed codebases with metadata.', mimeType: 'application/json' },
    async () => {
      const analyses = await listAnalyses();
      return { contents: [{ uri: 'unravl://analyses', text: JSON.stringify(analyses, null, 2) }] };
    }
  );

  server.registerResource(
    'project-overview',
    new ResourceTemplate('unravl://{project_name}/overview', { list: undefined }),
    { title: 'Project Overview', description: 'System overview: architecture summary, tech stack, capabilities, purpose.', mimeType: 'application/json' },
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(query.getSystemOverview(cas), null, 2) }] };
    }
  );

  server.registerResource(
    'project-endpoints',
    new ResourceTemplate('unravl://{project_name}/endpoints', { list: undefined }),
    { title: 'Project Endpoints', description: 'All entry points and route table.', mimeType: 'application/json' },
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify({ entry_points: query.getEntryPoints(cas), route_table: query.getRouteTable(cas) }, null, 2) }] };
    }
  );

  server.registerResource(
    'project-schema',
    new ResourceTemplate('unravl://{project_name}/schema', { list: undefined }),
    { title: 'Project Schema', description: 'Database schema and data entities.', mimeType: 'application/json' },
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify({ database_schema: query.getDatabaseSchema(cas), data_entities: query.getDataEntities(cas) }, null, 2) }] };
    }
  );

  server.registerResource(
    'project-security',
    new ResourceTemplate('unravl://{project_name}/security', { list: undefined }),
    { title: 'Project Security', description: 'Security boundaries, trust transitions, protection gaps.', mimeType: 'application/json' },
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(query.getSecurityOverview(cas), null, 2) }] };
    }
  );

  server.registerResource(
    'project-health',
    new ResourceTemplate('unravl://{project_name}/health', { list: undefined }),
    { title: 'Project Health', description: 'Implementation health, documentation coverage, TODO summary, analysis errors.', mimeType: 'application/json' },
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
          }, null, 2),
        }],
      };
    }
  );

  server.registerResource(
    'project-flows',
    new ResourceTemplate('unravl://{project_name}/flows', { list: undefined }),
    { title: 'Project Flows', description: 'Flow summary, workflow graph, flow coverage overview.', mimeType: 'application/json' },
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
          }, null, 2),
        }],
      };
    }
  );

  server.registerResource(
    'project-risks',
    new ResourceTemplate('unravl://{project_name}/risks', { list: undefined }),
    { title: 'Project Risks', description: 'Change risk summary, stability summary, test gaps.', mimeType: 'application/json' },
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
          }, null, 2),
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
      argsSchema: { path: z.string().describe('Project path') },
    },
    async ({ path }) => {
      const cas = await getAnalysis(path);
      const summary = query.buildSummary(cas);
      const overview = query.getSystemOverview(cas);
      const routes = query.getRouteTable(cas);
      const schema = query.getDatabaseSchema(cas);
      const security = query.getSecurityOverview(cas);
      const patterns = query.getPatterns(cas);

      const sections: string[] = [];

      sections.push(`# Architectural Context: ${cas.system.name}`);
      sections.push(`System type: ${summary.system_purpose?.primary_type || cas.system.type}`);
      if (summary.enhanced_system_purpose) {
        sections.push(`Domain: ${summary.enhanced_system_purpose.primary_domain}`);
        sections.push(`Description: ${summary.enhanced_system_purpose.inferred_description}`);
        sections.push(`Core concepts: ${summary.enhanced_system_purpose.core_concepts.join(', ')}`);
      }

      sections.push(`\n## Tech Stack`);
      const techs = cas.system.technologies;
      if (techs?.languages) sections.push(`Languages: ${techs.languages.map(l => l.name).join(', ')}`);
      if (techs?.frameworks) sections.push(`Frameworks: ${techs.frameworks.map(f => f.name).join(', ')}`);
      if (techs?.databases) sections.push(`Databases: ${techs.databases.join(', ')}`);

      if (summary.architecture_summary) {
        sections.push(`\n## Architecture Layers`);
        const layers = summary.architecture_summary.layers;
        if (layers.presentation) sections.push(`Presentation: ${JSON.stringify(layers.presentation)}`);
        if (layers.business) sections.push(`Business: ${JSON.stringify(layers.business)}`);
        if (layers.data) sections.push(`Data: ${JSON.stringify(layers.data)}`);
        if (layers.infrastructure) sections.push(`Infrastructure: ${JSON.stringify(layers.infrastructure)}`);
      }

      sections.push(`\n## Scale`);
      sections.push(`Nodes: ${summary.node_counts.total} (${Object.entries(summary.node_counts.by_type).map(([k, v]) => `${k}:${v}`).join(', ')})`);
      sections.push(`Edges: ${summary.edge_counts.total}`);
      sections.push(`Entry points: ${summary.entry_point_count} (${Object.entries(summary.entry_points_by_type).map(([k, v]) => `${k}:${v}`).join(', ')})`);

      if (routes.length > 0) {
        sections.push(`\n## API Routes (${routes.length} total)`);
        for (const r of routes.slice(0, 30)) {
          sections.push(`  ${r.method.padEnd(7)} ${r.path} -> ${r.controller}.${r.handler}${r.auth ? ' [AUTH]' : ''}`);
        }
        if (routes.length > 30) sections.push(`  ... and ${routes.length - 30} more`);
      }

      if (schema) {
        sections.push(`\n## Database (${schema.orm || 'unknown ORM'})`);
        sections.push(`Entities: ${schema.entities.map(e => e.name).join(', ')}`);
      }

      if (summary.flow_graph) {
        sections.push(`\n## Capabilities (${summary.flow_graph.capabilities_count} total)`);
        sections.push(`Patterns: ${summary.flow_graph.system_insights.detected_patterns.join(', ')}`);
        sections.push(`Primary entry: ${summary.flow_graph.system_insights.primary_entry_type}`);
        sections.push(`Data flow: ${summary.flow_graph.system_insights.data_flow_type}`);
        sections.push(`\nTop capabilities:`);
        for (const cap of summary.flow_graph.top_capabilities.slice(0, 10)) {
          sections.push(`  ${cap.name} [${cap.classification}] score=${cap.score}`);
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
          sections.push(`  ${p.name} (${p.type || 'pattern'}, confidence: ${p.confidence}, instances: ${p.instances.length})`);
        }
      }

      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: sections.join('\n') },
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
      },
    },
    async ({ path, node_id }) => {
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

      sections.push(`\n## Callers (${callers.length} found)`);
      for (const c of callers.slice(0, 20)) {
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
          content: { type: 'text', text: sections.join('\n') },
        }],
      };
    }
  );

  server.registerPrompt(
    'test_coverage_analysis',
    {
      title: 'Test Coverage Analysis',
      description: 'Generates a test coverage report highlighting gaps, untested critical paths, and recommendations.',
      argsSchema: { path: z.string().describe('Project path') },
    },
    async ({ path }) => {
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

      if ('coverage' in flowCoverage && Array.isArray(flowCoverage.coverage)) {
        const covered = flowCoverage.coverage.filter(fc => fc.coverage_status === 'fully-covered').length;
        const partial = flowCoverage.coverage.filter(fc => fc.coverage_status === 'partially-covered').length;
        const uncovered = flowCoverage.coverage.filter(fc => fc.coverage_status === 'not-covered').length;
        sections.push(`\n## Flow Coverage`);
        sections.push(`Fully covered: ${covered}, Partially: ${partial}, Not covered: ${uncovered}`);
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
          content: { type: 'text', text: sections.join('\n') },
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
