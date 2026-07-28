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

/* ---------------------------------------------------------------------------
 * CROSS-KIND / CROSS-ANALYZER DUPLICATES.
 *
 * The canonical key above puts `type` and `name` in the identity, so it is
 * structurally blind to one real trigger described by two or three analyzers
 * under DIFFERENT kinds and DIFFERENT display names. Measured in production:
 *   - hercules (Django): 46 Celery tasks each emitted THREE times — django as
 *     `message` "task X", workflow as `event` "X", async-messaging as
 *     `message` "X". 237 entry points -> 146 once collapsed.
 *   - Hoggan (C#/WPF): every .NET `Main` emitted twice — csharp as `cli`
 *     ".NET Main entry point" (file+line) and wpf as `lifecycle` "Main.Main"
 *     (file, no line).
 * Neither pair shares a canonical key. The identity that DOES hold is
 * (file, handler method) or (messaging system, channel) — but only ACROSS
 * analyzers: react legitimately emits three `event` entry points for the three
 * DOM handlers of one component, same file, same line, same handler method.
 * ------------------------------------------------------------------------ */

function contribution(analyzerId: string, entryPoints: any[]): CASContribution {
  return {
    nodes: [], edges: [], entry_points: entryPoints, exit_points: [],
    analyzer_metadata: { analyzer_id: analyzerId, analyzer_name: analyzerId, contribution_type: 'framework' },
  } as any;
}

/** The three real records for one Celery task, verbatim in shape from the
 *  hercules CAS. */
const celeryDjango = {
  id: 'entry_celery_task_apply_credit', source_node: 'celery_task_app_companies_apply_credit',
  source_analyzer: 'django', type: 'message', name: 'task apply_credit',
  trigger: { event: 'celery.task.apply_credit' },
  metadata: { task_operation: 'apply_credit', task_type: 'celery', app: 'companies' },
  handler: { node_id: 'function_file_modules_companies_tasks_py_apply_credit_48', method_name: 'apply_credit', file: 'modules/companies/tasks.py' },
};
const celeryWorkflow = {
  id: 'ep_flow_celery_task_apply_credit', source_node: 'flow_celery_task_apply_credit',
  source_analyzer: 'workflow', type: 'event', name: 'apply_credit',
  trigger: { event: 'celery:task:apply_credit' }, metadata: { system: 'celery', kind: 'task' },
};
const celeryMessaging = {
  id: 'ep_messaging_celery_consumer_apply_credit_modules_companies_tasks_py_47',
  source_node: 'messaging_celery_consumer_apply_credit_modules_companies_tasks_py_47',
  source_analyzer: 'async-messaging', type: 'message', name: 'apply_credit',
  trigger: { event: 'celery:queue:apply_credit' },
  metadata: { system: 'celery', channel: 'apply_credit', channelKind: 'queue', handlerName: 'apply_credit' },
};

test('one Celery task described by three analyzers under two kinds collapses to ONE entry point', async () => {
  const { merged, analysisErrors } = await mergeAll([
    contribution('django', [celeryDjango]),
    contribution('workflow', [celeryWorkflow]),
    contribution('async-messaging', [celeryMessaging]),
  ]);
  assert.equal(merged.allEntryPoints.length, 1);
  // Union, not a drop: every analyzer's evidence survives.
  assert.deepEqual(
    merged.allEntryPoints[0].metadata.merged_from_analyzers.slice().sort(),
    ['async-messaging', 'django', 'workflow']
  );
  assert.equal(merged.allEntryPoints[0].handler.file, 'modules/companies/tasks.py');
  assert.deepEqual(analysisErrors.filter(e => /Duplicate entry point/.test(e.message)), []);
});

test('two DIFFERENT Celery tasks are never merged', async () => {
  const other = { ...celeryWorkflow, id: 'ep_flow_celery_task_sync_customers', source_node: 'flow_celery_task_sync_customers', name: 'sync_customers', trigger: { event: 'celery:task:sync_customers' } };
  const { merged } = await mergeAll([contribution('django', [celeryDjango]), contribution('workflow', [celeryWorkflow, other])]);
  assert.equal(merged.allEntryPoints.length, 2);
});

test('a .NET Main emitted as cli by csharp and as lifecycle by wpf collapses to ONE entry point', async () => {
  const csharp = {
    id: 'entry_dotnet_program_HogganScientific_Main_cs_7', source_node: 'dotnet_program_HogganScientific_Main_cs_7',
    source_analyzer: 'csharp', type: 'cli', name: '.NET Main entry point: HogganScientific',
    trigger: { event: 'process-start' },
    handler: { node_id: 'method_class_HogganScientific_MainClass_Main_7', method_name: 'Main', file: 'HogganScientific/Main.cs', line: 7 },
    metadata: { language: 'csharp', framework: 'dotnet', file: 'HogganScientific/Main.cs' },
  };
  const wpf = {
    id: 'entry_hogganscientific_main_cs_app_startup_Main_a809a2a9', source_node: 'app_startup_hogganscientific_main_cs_Main_3b7fd452',
    source_analyzer: 'wpf', type: 'lifecycle', name: 'Main.Main', trigger: { event: 'app-startup' },
    metadata: { framework: 'wpf', entry_type: 'app_startup', startup_method: 'Main' },
    handler: { node_id: 'app_startup_hogganscientific_main_cs_Main_3b7fd452', method_name: 'Main', file: 'HogganScientific/Main.cs' },
  };
  for (const order of [[csharp, wpf], [wpf, csharp]]) {
    const { merged } = await mergeAll(order.map(ep => contribution((ep as any).source_analyzer, [ep])));
    assert.equal(merged.allEntryPoints.length, 1, 'cross-kind dedup must be order independent');
  }

  // ...but the SAME Main class name in a DIFFERENT project stays separate.
  const otherProject = { ...wpf, id: 'entry_other', handler: { ...wpf.handler, file: 'hoggan.windowservice/Program.cs' } };
  const { merged } = await mergeAll([contribution('csharp', [csharp]), contribution('wpf', [otherProject])]);
  assert.equal(merged.allEntryPoints.length, 2);
});

test('same analyzer, same file+line+handler, different DOM events are NOT merged (react regression)', async () => {
  // The three handlers of one component all share file, line and handler
  // method. Only a CROSS-analyzer match may ignore kind and name.
  const react = ['searchChange', 'typeChange', 'fileChange'].map((event, index) => ({
    id: `entry_event_functionspage_${event}`, source_node: `n_${event}`, source_analyzer: 'react',
    type: 'event', name: `FunctionsPage ${event}`, trigger: { event },
    handler: { node_id: `n_${event}`, method_name: 'FunctionsPage', file: 'apps/app/src/app/Functions/FunctionsPage.tsx', line: 1 },
    metadata: { index },
  }));
  const { merged } = await mergeAll([contribution('react', react)]);
  assert.equal(merged.allEntryPoints.length, 3);
});

test('cross-analyzer keys never form an identity from a bare kind label or a name alone', async () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  // "process-start" is a kind label, not a (system, channel) pair.
  assert.deepEqual(orchestrator.entryPointCrossAnalyzerKeys({ type: 'cli', name: 'x', trigger: { event: 'process-start' } }), []);
  // A file with no handler method is not an identity either.
  assert.deepEqual(orchestrator.entryPointCrossAnalyzerKeys({ type: 'cli', name: 'x', handler: { file: 'a/b.cs' } }), []);
  // system == channel carries no information beyond the system.
  assert.deepEqual(orchestrator.entryPointCrossAnalyzerKeys({ type: 'message', name: 'x', trigger: { event: 'celery:celery' } }), []);
});
