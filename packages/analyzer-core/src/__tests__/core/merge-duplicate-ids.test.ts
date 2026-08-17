import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { buildGraphValidation } from '../../analyzer/core/graph-validation';
import { CASAnalysisError, CASEntryPoint } from '../../types/cas.types';

function emptyTarget() {
  return { allNodes: [] as any[], allEdges: [] as any[], allEntryPoints: [] as any[], allExitPoints: [] as any[] };
}

function contribution(overrides: Record<string, unknown> = {}) {
  return {
    nodes: [],
    edges: [],
    entry_points: [],
    exit_points: [],
    analyzer_metadata: {
      analyzer_id: 'rust',
      analyzer_name: 'Rust Analyzer',
      version: '1.0.0',
      contribution_type: 'language',
      nodes_contributed: 0,
      edges_contributed: 0
    },
    ...overrides
  } as any;
}

function cliEntry(overrides: Partial<CASEntryPoint> = {}): CASEntryPoint {
  return {
    id: 'entry:main:bin/agent/build.rs',
    source_node: 'function:bin/agent/build.rs:main',
    source_analyzer: 'rust',
    type: 'cli',
    name: 'main',
    description: 'Program entry point',
    ...overrides
  };
}

describe('contribution merge duplicate-id semantics', () => {
  let orchestrator: any;
  let analysisErrors: CASAnalysisError[];

  beforeEach(() => {
    orchestrator = new AnalyzerOrchestrator() as any;
    analysisErrors = [];
  });

  it('drops an identical-content duplicate entry point silently within one contribution', async () => {
    const target = emptyTarget();
    await orchestrator.mergeAnalysisResult(
      target,
      contribution({ entry_points: [cliEntry(), cliEntry()] }),
      { analyzerId: 'rust', analysisErrors }
    );

    expect(target.allEntryPoints).toHaveLength(1);
    expect(analysisErrors).toHaveLength(0);
  });

  it('drops an identical-content duplicate entry point silently across contributions', async () => {
    const target = emptyTarget();
    await orchestrator.mergeAnalysisResult(target, contribution({ entry_points: [cliEntry()] }), { analyzerId: 'rust', analysisErrors });
    await orchestrator.mergeAnalysisResult(target, contribution({ entry_points: [cliEntry()] }), { analyzerId: 'rust', analysisErrors });

    expect(target.allEntryPoints).toHaveLength(1);
    expect(analysisErrors).toHaveLength(0);
  });

  it('UNION-MERGES an exact-id entry-point collision instead of dropping the loser (d2e6acf7)', async () => {
    const target = emptyTarget();
    const first = cliEntry({
      id: 'entry_http_server',
      type: 'http',
      name: 'HTTP Server: port 3000',
      source_analyzer: 'nestjs',
      metadata: { file: 'apps/api/src/main.ts', port: 3000 }
    });
    const second = cliEntry({
      id: 'entry_http_server',
      type: 'http',
      name: 'HTTP Server: port 3030',
      source_analyzer: 'nestjs',
      metadata: { file: 'apps/api-internal/src/main.ts', port: 3030 }
    });

    await orchestrator.mergeAnalysisResult(
      target,
      contribution({ entry_points: [first, second] }),
      { analyzerId: 'nestjs', analysisErrors }
    );

    // Two DIFFERING records under one id used to keep the first and warn,
    // silently discarding real extracted evidence. They now merge: one record
    // survives, the richer one supplies conflicting scalars, and neither
    // side's metadata is lost — so this is no longer a PARTIAL_ANALYSIS.
    expect(target.allEntryPoints).toHaveLength(1);
    expect(target.allEntryPoints[0].name).toBe('HTTP Server: port 3000');
    expect(target.allEntryPoints[0].metadata.port).toBe(3000);
    expect(analysisErrors).toHaveLength(0);
  });

  it('applies the same semantics to exit points', async () => {
    const target = emptyTarget();
    const exit = {
      id: 'exit:db:src/store.rs',
      source_node: 'function:src/store.rs:save',
      source_analyzer: 'rust',
      type: 'database',
      name: 'save'
    };

    await orchestrator.mergeAnalysisResult(
      target,
      contribution({ exit_points: [exit, { ...exit }, { ...exit, name: 'save_other' }] }),
      { analyzerId: 'rust', analysisErrors }
    );

    expect(target.allExitPoints).toHaveLength(1);
    expect(target.allExitPoints[0].name).toBe('save');
    expect(analysisErrors).toHaveLength(1);
    expect(analysisErrors[0].message).toContain('exit:db:src/store.rs');
  });

  it('keeps the first edge and warns when a duplicate edge id carries different content', async () => {
    const target = emptyTarget();
    const edge = { id: 'edge:1', source: 'a', target: 'b', type: 'calls' };

    await orchestrator.mergeAnalysisResult(target, contribution({ edges: [edge] }), { analyzerId: 'rust', analysisErrors });
    await orchestrator.mergeAnalysisResult(
      target,
      contribution({ edges: [{ ...edge }, { ...edge, type: 'imports' }] }),
      { analyzerId: 'react', analysisErrors }
    );

    expect(target.allEdges).toHaveLength(1);
    expect(target.allEdges[0].type).toBe('calls');
    expect(analysisErrors).toHaveLength(1);
    expect(analysisErrors[0].message).toContain('edge:1');
  });

  // -------------------------------------------------------------------------
  // Cross-analyzer canonical-identity dedup (entry-point double-registration
  // class): mcp-tool-registration-analyzer.ts and ai-stack-analyzer.ts each
  // independently detect `.registerTool`/`.tool(` call sites and both emit a
  // 'message'-type entry point for the SAME real MCP tool registration, but
  // under DIFFERENT id schemes (`entry_mcp_tool_<name>_<file>_<line>` vs
  // `entry_mcp_tool_<name>_<file>`, no line suffix) — so the id-keyed dedup
  // above never caught them, doubling every real message-kind entry point
  // (435 entries / 221 unique names on a fresh self-CAS). These tests pin the
  // (type, name, handler-node) canonical-key dedup that fixes it.
  it('dedupes the SAME MCP tool registration reported under two different ids by two analyzer passes, keeping the richer record', async () => {
    const target = emptyTarget();
    // The leaner ai-stack-analyzer.ts-shaped record: no method_name distinct
    // from name, no trigger.method, sparse metadata.
    const coarse = {
      id: 'entry_mcp_tool_get_summary_apps-mcp-server-src-server-ts',
      source_node: 'node:mcp_tool_get_summary_apps-mcp-server-src-server-ts',
      source_analyzer: 'ai-stack',
      type: 'message',
      name: 'get_summary',
      description: "MCP tool 'get_summary' exposed by an MCP server",
      handler: { node_id: 'node:mcp_tool_get_summary_apps-mcp-server-src-server-ts', method_name: 'get_summary', file: 'apps/mcp-server/src/server.ts' },
      metadata: { ai: true, mcp: true, capability: 'mcp-tool' }
    };
    // The richer mcp-tool-registration-analyzer.ts-shaped record for the
    // SAME real call site: line-accurate id, a distinct handler method_name,
    // a trigger.method, and denser metadata.
    const rich = {
      id: 'entry_mcp_tool_get_summary_apps-mcp-server-src-server-ts_141',
      source_node: 'node:mcp_tool_get_summary_apps-mcp-server-src-server-ts',
      source_analyzer: 'mcp-tool-registration',
      type: 'message',
      name: 'get_summary',
      description: "MCP tool registration: get_summary (via server.registerTool())",
      trigger: { method: 'registerTool', path: 'get_summary' },
      handler: { node_id: 'node:mcp_tool_get_summary_apps-mcp-server-src-server-ts', method_name: 'handleGetSummary', file: 'apps/mcp-server/src/server.ts', line: 141 },
      metadata: { registrationKind: 'registerTool', receiver: 'server', file: 'apps/mcp-server/src/server.ts', line: 141 }
    };

    await orchestrator.mergeAnalysisResult(target, contribution({ entry_points: [coarse] }), { analyzerId: 'ai-stack', analysisErrors });
    await orchestrator.mergeAnalysisResult(target, contribution({ entry_points: [rich] }), { analyzerId: 'mcp-tool-registration', analysisErrors });

    expect(target.allEntryPoints).toHaveLength(1);
    expect(target.allEntryPoints[0].id).toBe(rich.id);
    expect(target.allEntryPoints[0].handler.method_name).toBe('handleGetSummary');
    expect(analysisErrors).toHaveLength(0);
  });

  it('keeps the richer record regardless of which analyzer contribution merges first', async () => {
    const target = emptyTarget();
    const coarse = {
      id: 'entry_mcp_tool_do_thing_lib-ts',
      source_node: 'node:mcp_tool_do_thing_lib-ts',
      type: 'message',
      name: 'do_thing',
      handler: { node_id: 'node:mcp_tool_do_thing_lib-ts', method_name: 'do_thing', file: 'lib.ts' }
    };
    const rich = {
      id: 'entry_mcp_tool_do_thing_lib-ts_12',
      source_node: 'node:mcp_tool_do_thing_lib-ts',
      type: 'message',
      name: 'do_thing',
      trigger: { method: 'tool', path: 'do_thing' },
      handler: { node_id: 'node:mcp_tool_do_thing_lib-ts', method_name: 'runDoThing', file: 'lib.ts', line: 12 },
      metadata: { registrationKind: 'tool', receiver: 'server' }
    };

    // Richer contribution merges FIRST this time.
    await orchestrator.mergeAnalysisResult(target, contribution({ entry_points: [rich] }), { analyzerId: 'mcp-tool-registration', analysisErrors });
    await orchestrator.mergeAnalysisResult(target, contribution({ entry_points: [coarse] }), { analyzerId: 'ai-stack', analysisErrors });

    expect(target.allEntryPoints).toHaveLength(1);
    expect(target.allEntryPoints[0].id).toBe(rich.id);
    expect(analysisErrors).toHaveLength(0);
  });

  it('does NOT merge two entry points that merely share a name but resolve to different handler nodes', async () => {
    const target = emptyTarget();
    const first = {
      id: 'entry_a',
      source_node: 'node:a',
      type: 'message',
      name: 'do_thing',
      handler: { node_id: 'node:a', method_name: 'do_thing', file: 'a.ts' }
    };
    const second = {
      id: 'entry_b',
      source_node: 'node:b',
      type: 'message',
      name: 'do_thing',
      handler: { node_id: 'node:b', method_name: 'do_thing', file: 'b.ts' }
    };

    await orchestrator.mergeAnalysisResult(target, contribution({ entry_points: [first] }), { analyzerId: 'x', analysisErrors });
    await orchestrator.mergeAnalysisResult(target, contribution({ entry_points: [second] }), { analyzerId: 'y', analysisErrors });

    expect(target.allEntryPoints).toHaveLength(2);
    expect(analysisErrors).toHaveLength(0);
  });

  it('treats key order as identical content', async () => {
    const target = emptyTarget();
    const reordered = {
      description: 'Program entry point',
      name: 'main',
      type: 'cli',
      source_analyzer: 'rust',
      source_node: 'function:bin/agent/build.rs:main',
      id: 'entry:main:bin/agent/build.rs'
    };

    await orchestrator.mergeAnalysisResult(
      target,
      contribution({ entry_points: [cliEntry(), reordered] }),
      { analyzerId: 'rust', analysisErrors }
    );

    expect(target.allEntryPoints).toHaveLength(1);
    expect(analysisErrors).toHaveLength(0);
  });
});

describe('graph integrity duplicate-id validation', () => {
  it('counts duplicate ids per section and records validation warnings', () => {
    const node = (id: string) => ({ id, name: id, type: 'function', source: { file: 'a.ts', line: 1 } });
    const validation = buildGraphValidation(
      [node('n1'), node('n1'), node('n2')],
      [{ id: 'e1', source: 'n1', target: 'n2', type: 'calls' }, { id: 'e1', source: 'n1', target: 'n2', type: 'calls' }],
      [cliEntry(), cliEntry()],
      []
    );

    expect(validation.graph_integrity!.duplicate_ids).toEqual({
      nodes: 1,
      edges: 1,
      entry_points: 1,
      exit_points: 0
    });
    const messages = (validation.validation_warnings || []).map((w: any) => w.message).join('\n');
    expect(messages).toContain('Duplicate nodes id "n1"');
    expect(messages).toContain('Duplicate edges id "e1"');
    expect(messages).toContain('Duplicate entry_points id "entry:main:bin/agent/build.rs"');
  });

  it('reports zero duplicates for a clean graph', () => {
    const validation = buildGraphValidation(
      [{ id: 'n1', name: 'n1', type: 'function', source: { file: 'a.ts', line: 1 } }],
      [],
      [],
      []
    );
    expect(validation.graph_integrity!.duplicate_ids).toEqual({
      nodes: 0,
      edges: 0,
      entry_points: 0,
      exit_points: 0
    });
  });
});

/**
 * Declared web routes extracted TWICE — once by a framework analyzer and once
 * by the routing-library analyzer for the same router file. Measured in
 * production: one router file's 20 declared paths shipped as 40 `route` entry
 * points, because the two records share no canonical key (names differ, the
 * library record carries no handler at all, and a route trigger has no
 * (system, channel) pair). The route identity is (verb, path, component).
 */
describe('cross-analyzer route dedup', () => {
  let orchestrator: any;

  beforeEach(() => {
    orchestrator = new AnalyzerOrchestrator() as any;
  });

  // Shapes copied from a real analysis of a React + react-router app.
  const frameworkRoute = (path: string, component: string) => ({
    id: `entry_route_apps_app_src_router_tsx_${path.replace(/\W/g, '_')}_0_abc`,
    source_node: `route_apps_app_src_router_tsx_${path.replace(/\W/g, '_')}_0_abc`,
    source_analyzer: 'react',
    type: 'route',
    name: `Route ${path}`,
    description: `React route mapping to component ${component}`,
    trigger: { path, method: 'GET' },
    metadata: { component },
    handler: {
      node_id: `route_apps_app_src_router_tsx_${path.replace(/\W/g, '_')}_0_abc`,
      method_name: path,
      file: 'apps/app/src/router.tsx',
      line: 1,
    },
  });

  const libraryRoute = (path: string, component: string) => ({
    id: `entry_route_src_router_tsx_${path.replace(/\W/g, '_')}`,
    source_node: 'file_apps_app_src_router_tsx',
    source_analyzer: 'react-router',
    type: 'route',
    name: `GET ${path}`,
    trigger: { path, method: 'GET' },
    // NOTE: no handler at all, and the file is resolved against the sub-app
    // root rather than the repo root — both reasons the older keys missed this.
    metadata: { framework: 'react-router', component, lazy: true, sourceFile: 'src/router.tsx' },
  });

  function mergeAll(groups: Array<{ analyzerId: string; entries: any[] }>) {
    const target = { allNodes: [], allEdges: [], allEntryPoints: [] as any[], allExitPoints: [] };
    for (const { analyzerId, entries } of groups) {
      orchestrator.mergeAnalysisResult(target, {
        entry_points: entries,
        analyzer_metadata: {
          analyzer_id: analyzerId, analyzer_name: analyzerId, contribution_type: 'framework',
        },
      }, { analyzerId });
    }
    return target.allEntryPoints;
  }

  it('N declared paths seen by two analyzers yield N route entries, not 2N', () => {
    const declared: Array<[string, string]> = [
      ['/', 'AuthenticatedLayout'],
      ['/auth', 'AuthPage'],
      ['overview', 'CodebaseOverview'],
      ['flows/:flowId', 'FlowDetailPage'],
      ['functions/file/*', 'FileNodesPage'],
    ];

    const merged = mergeAll([
      { analyzerId: 'react', entries: declared.map(([p, c]) => frameworkRoute(p, c)) },
      { analyzerId: 'react-router', entries: declared.map(([p, c]) => libraryRoute(p, c)) },
    ]);

    expect(merged.length).toBe(declared.length);
    expect(merged.map(e => e.trigger.path).sort()).toEqual(declared.map(([p]) => p).sort());
  });

  it('merges without losing either analyzer\'s evidence', () => {
    const merged = mergeAll([
      { analyzerId: 'react', entries: [frameworkRoute('/auth', 'AuthPage')] },
      { analyzerId: 'react-router', entries: [libraryRoute('/auth', 'AuthPage')] },
    ]);

    expect(merged.length).toBe(1);
    const ep = merged[0];
    // The framework record's location evidence survives...
    expect(ep.handler?.file).toBe('apps/app/src/router.tsx');
    expect(ep.description).toContain('AuthPage');
    // ...and so does the library record's, which nothing else carries.
    expect(ep.metadata.lazy).toBe(true);
    expect(ep.metadata.framework).toBe('react-router');
    expect(ep.metadata.merged_from_analyzers.sort()).toEqual(['react', 'react-router']);
  });

  it('does NOT merge two surfaces that share a path and verb but render different components', () => {
    // A backend endpoint and a frontend page at the same URL are two entry
    // points, not one — the component is what keeps them apart.
    const merged = mergeAll([
      { analyzerId: 'react', entries: [frameworkRoute('/health', 'HealthPage')] },
      { analyzerId: 'express', entries: [libraryRoute('/health', 'healthController')] },
    ]);
    expect(merged.length).toBe(2);
  });

  it('the route key does NOT fire for two records from the SAME analyzer', () => {
    // One analyzer emitting two records for one path is describing two real
    // things (react emits several event entries at one file:line), so the
    // cross-analyzer keys must never collapse a single analyzer's own output.
    // These two share the route identity but NOT any canonical key — different
    // display names and different location evidence — so a merge here could
    // only come from the route key, and must not happen.
    const merged = mergeAll([{
      analyzerId: 'react',
      entries: [frameworkRoute('/auth', 'AuthPage'), libraryRoute('/auth', 'AuthPage')]
        .map(e => ({ ...e, source_analyzer: 'react' })),
    }]);
    expect(merged.length).toBe(2);
  });

  it('does NOT key on an unresolved "Unknown" component placeholder', () => {
    const merged = mergeAll([
      { analyzerId: 'react', entries: [frameworkRoute('/a', 'Unknown')] },
      { analyzerId: 'react-router', entries: [libraryRoute('/b', 'Unknown')] },
    ]);
    // Different paths anyway, but the point is neither emitted a route key at
    // all — a placeholder must never become an identity.
    expect(orchestrator.entryPointRouteIdentity(frameworkRoute('/a', 'Unknown'))).toBeUndefined();
    expect(merged.length).toBe(2);
  });
});
