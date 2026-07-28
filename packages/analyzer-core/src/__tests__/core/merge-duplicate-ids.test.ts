import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { CASAnalysisError } from '../../types/cas.types';

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

function cliEntry(overrides: Record<string, unknown> = {}) {
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
    const orchestrator = new AnalyzerOrchestrator() as any;
    const node = (id: string) => ({ id, name: id, type: 'function', source: { file: 'a.ts', line: 1 } });
    const validation = orchestrator.buildValidation(
      [node('n1'), node('n1'), node('n2')],
      [{ id: 'e1', source: 'n1', target: 'n2' }, { id: 'e1', source: 'n1', target: 'n2' }],
      [cliEntry(), cliEntry()],
      []
    );

    expect(validation.graph_integrity.duplicate_ids).toEqual({
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
    const orchestrator = new AnalyzerOrchestrator() as any;
    const validation = orchestrator.buildValidation(
      [{ id: 'n1', name: 'n1', type: 'function', source: { file: 'a.ts', line: 1 } }],
      [],
      [],
      []
    );
    expect(validation.graph_integrity.duplicate_ids).toEqual({
      nodes: 0,
      edges: 0,
      entry_points: 0,
      exit_points: 0
    });
  });
});
