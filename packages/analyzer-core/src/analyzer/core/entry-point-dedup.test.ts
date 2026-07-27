/**
 * ENTRY-POINT CROSS-ANALYZER DEDUPLICATION.
 *
 * Two analyzers routinely extract the SAME registration: ai-stack-analyzer's
 * regex sweep and mcp-tool-registration-analyzer's dedicated extraction both
 * see every `server.registerTool(...)` call. They mint different node ids
 * (`ai_mcp-tool_<name>_<file>_<line>` vs `mcp_tool_<name>_<file>_<line>`), so
 * the first dedup attempt — which keyed on (type, name, handler NODE id) —
 * produced two different keys for one real tool and never fired: the live CAS
 * shipped 424 message entry points for 215 unique names, 209 of them doubled.
 *
 * The identity that actually holds across analyzers is the CODE LOCATION, so
 * that is the primary canonical key. And a losing record is never dropped:
 * differing duplicates merge their union, because discarding extracted
 * evidence is data loss (two live analyzer warnings were exactly that).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyzerOrchestrator } from './orchestrator';
import { CASAnalysisError, CASContribution } from '../../types/cas.types';

function target() {
  return { allNodes: [] as any[], allEdges: [] as any[], allEntryPoints: [] as any[], allExitPoints: [] as any[] };
}

/** ai-stack's record: coarse, no line field — the line lives only in the node
 *  id suffix it mints. */
function aiStackContribution(): CASContribution {
  return {
    nodes: [],
    edges: [],
    entry_points: [{
      id: 'entry_mcp_tool_analyze_codebase_apps_mcp_server_src_server_ts_1158',
      source_node: 'ai_mcp-tool_analyze_codebase_apps_mcp_server_src_server_ts_1158',
      source_analyzer: 'ai-stack',
      type: 'message',
      name: 'analyze_codebase',
      description: "MCP tool 'analyze_codebase' exposed by an MCP server",
      trigger: { event: 'mcp.tool.call', pattern: 'analyze_codebase' },
      metadata: { ai: true, mcp: true, capability: 'mcp-tool' },
      handler: {
        node_id: 'ai_mcp-tool_analyze_codebase_apps_mcp_server_src_server_ts_1158',
        method_name: 'analyze_codebase',
        file: 'apps/mcp-server/src/server.ts',
      },
      capabilities: [{ capability_id: 'cap_mcp_server', capability_name: 'Manage MCP Server', role: 'primary' }],
    } as any],
    exit_points: [],
    analyzer_metadata: { analyzer_id: 'ai-stack', analyzer_name: 'ai-stack', contribution_type: 'library' },
  };
}

/** mcp-tool-registration's record: same call site, its OWN node id, richer. */
function registrationContribution(): CASContribution {
  return {
    nodes: [],
    edges: [],
    entry_points: [{
      id: 'entry_mcp_tool_analyze_codebase_apps_mcp_server_src_server_ts_1158',
      source_node: 'mcp_tool_analyze_codebase_apps_mcp_server_src_server_ts_1158',
      source_analyzer: 'mcp-tool-registration',
      type: 'message',
      name: 'analyze_codebase',
      trigger: { method: 'registerTool', path: 'analyze_codebase' },
      metadata: { registrationKind: 'registerTool', receiver: 'server', file: 'apps/mcp-server/src/server.ts', line: 1158 },
      handler: {
        node_id: 'mcp_tool_analyze_codebase_apps_mcp_server_src_server_ts_1158',
        method_name: 'analyze_codebase',
        file: 'apps/mcp-server/src/server.ts',
      },
      capabilities: [{ capability_id: 'cap_fab_mcp_tool_surface', capability_name: 'Fab Mcp Tool Surface', role: 'supporting' }],
    } as any],
    exit_points: [],
    analyzer_metadata: { analyzer_id: 'mcp-tool-registration', analyzer_name: 'mcp-tool-registration', contribution_type: 'library' },
  };
}

async function mergeAll(contributions: CASContribution[]) {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const merged = target();
  const analysisErrors: CASAnalysisError[] = [];
  for (const contribution of contributions) {
    await orchestrator.mergeAnalysisResult(merged, contribution, {
      analyzerId: contribution.analyzer_metadata?.analyzer_id,
      analysisErrors,
    });
  }
  return { merged, analysisErrors };
}

test('the same MCP tool extracted by two analyzers collapses to ONE entry point', async () => {
  for (const order of [
    [aiStackContribution(), registrationContribution()],
    [registrationContribution(), aiStackContribution()],
  ]) {
    const { merged } = await mergeAll(order);
    assert.equal(merged.allEntryPoints.length, 1, 'dedup must be order independent');
    assert.equal(merged.allEntryPoints[0].name, 'analyze_codebase');
  }
});

test('the surviving record is the UNION — no analyzer’s evidence is dropped', async () => {
  const { merged, analysisErrors } = await mergeAll([aiStackContribution(), registrationContribution()]);
  const [entryPoint] = merged.allEntryPoints;

  // Richer record's fields win...
  assert.equal(entryPoint.metadata.registrationKind, 'registerTool');
  assert.equal(entryPoint.metadata.line, 1158);
  // ...and the leaner record's unique evidence survives.
  assert.equal(entryPoint.metadata.mcp, true);
  assert.equal(entryPoint.metadata.capability, 'mcp-tool');
  assert.equal(entryPoint.description, "MCP tool 'analyze_codebase' exposed by an MCP server");
  assert.equal(entryPoint.trigger.method, 'registerTool');
  assert.equal(entryPoint.trigger.event, 'mcp.tool.call');

  // Capability links from BOTH records are kept.
  assert.deepEqual(
    entryPoint.capabilities.map((capability: any) => capability.capability_id).sort(),
    ['cap_fab_mcp_tool_surface', 'cap_mcp_server']
  );
  assert.deepEqual(entryPoint.metadata.merged_from_analyzers.sort(), ['ai-stack', 'mcp-tool-registration']);

  // A merge is not a partial analysis — no "dropped differing duplicate" warning.
  assert.deepEqual(analysisErrors.filter(error => /Duplicate entry point/.test(error.message)), []);
});

test('the location key matches across differing node-id schemes but never merges different call sites', async () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const keysFor = (ep: any): string[] => orchestrator.entryPointCanonicalKeys(ep);

  const ai = aiStackContribution().entry_points![0] as any;
  const registration = registrationContribution().entry_points![0] as any;
  const aiKeys = keysFor(ai);
  const registrationKeys = keysFor(registration);

  assert.ok(aiKeys.some(key => registrationKeys.includes(key)), 'same call site shares a canonical key');
  // The node-id keys are still DIFFERENT — the location key is what matches.
  assert.equal(
    aiKeys.filter(key => key.includes('ai_mcp-tool_')).some(key => registrationKeys.includes(key)),
    false
  );

  // Same tool name, different line = a genuinely distinct registration.
  const otherLine = {
    ...registration,
    id: 'entry_mcp_tool_analyze_codebase_apps_mcp_server_src_server_ts_2400',
    source_node: 'mcp_tool_analyze_codebase_apps_mcp_server_src_server_ts_2400',
    handler: { ...registration.handler, node_id: 'mcp_tool_analyze_codebase_apps_mcp_server_src_server_ts_2400' },
    metadata: { ...registration.metadata, line: 2400 },
  };
  assert.equal(keysFor(otherLine).some(key => aiKeys.includes(key)), false);

  // Same name, different FILE = distinct too.
  const otherFile = {
    ...registration,
    handler: { ...registration.handler, file: 'apps/api/src/server.ts' },
    metadata: { ...registration.metadata, file: 'apps/api/src/server.ts' },
  };
  assert.equal(keysFor(otherFile).some(key => aiKeys.includes(key)), false);
});

test('an entry point with no resolvable location still keys on its handler node (no over-merge on name alone)', async () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const bare = { id: 'e1', type: 'message', name: 'run', source_node: 'node-a' };
  const other = { id: 'e2', type: 'message', name: 'run', source_node: 'node-b' };

  assert.deepEqual(orchestrator.entryPointCanonicalKeys(bare), ['message::run::node-a']);
  assert.deepEqual(orchestrator.entryPointCanonicalKeys(other), ['message::run::node-b']);
  assert.deepEqual(orchestrator.entryPointCanonicalKeys({ id: 'e3', type: 'message' }), []);
});
