import { strict as assert } from 'assert';
import { test } from 'node:test';
import { CORE_TOOL_NAMES, SERVER_INSTRUCTIONS, createServer } from './server';
import { buildAgentBootstrapPrompt } from './agent-bootstrap';

// The MCP SERVER_INSTRUCTIONS string and the get_agent_bootstrap prompt are the
// product's first-impression teaching surface — the first thing an agent reads.
// Nothing else locks them, so a tool rename/removal or a dropped concept-layer
// section could silently degrade onboarding. These golden tests catch that:
//   (a) every tool NAMED in SERVER_INSTRUCTIONS is actually registered, and
//   (b) both surfaces still teach each concept-layer pillar (runtime/telemetry,
//       communication seams, consistency/CAP, topology, CI/CD, bundled deployable).

/**
 * Snake_case tokens that appear in SERVER_INSTRUCTIONS but are NOT MCP tool
 * names — CAS field names, response-shape keys, coordination-verdict enum
 * values, and option-array hint values. Kept explicit so the tool-coverage
 * check below can subtract them: anything tool-SHAPED that is NOT here MUST be a
 * registered tool. Adding a new non-tool token to the instructions fails this
 * test until it's listed here (cheap); renaming/removing a real tool also fails
 * it (the point).
 */
const NON_TOOL_TOKENS = new Set<string>([
  // CAS field / response-shape keys referenced in prose
  'ai_enrichment',
  'entry_points',
  'exit_points',
  'node_metrics',
  'request_count',
  'error_rate',
  'staleness_risk',
  'cap_lean',
  'runtime_topology',
  'depends_on',
  'bundled_into',
  'data_lineage', // the field; the tool is get_data_lineage
  'is_cohesive',
  'state_changes',
  'external_integrations',
  // coordination verdict / option-array values (not standalone tools)
  'agent_id',
  'lease_status',
  'near_expiry',
  'auto_mergeable',
  'needs_resolution',
  'duplicate_work',
  'overlapping_grant_holders',
  'redirect_hint',
  'free_scope_hint',
  'wait_and_heartbeat_poll',
  'proceed_with_awareness_if_compatible',
  'take_over_stale_lease',
  // server-staleness response fields (the tool is get_server_version)
  'server_update',
  'running_stale',
  'installed_version',
]);

function toolShapedTokens(text: string): Set<string> {
  const out = new Set<string>();
  // snake_case identifiers (two+ segments) — the shape a tool name takes.
  for (const m of text.matchAll(/\b([a-z][a-z0-9]+(?:_[a-z0-9]+)+)\b/g)) {
    if (!NON_TOOL_TOKENS.has(m[1])) out.add(m[1]);
  }
  return out;
}

function registeredToolNames(): Set<string> {
  const previous = process.env.KLAURO_TOOL_PROFILE;
  delete process.env.KLAURO_TOOL_PROFILE; // full profile registers every tool directly
  try {
    const server = createServer();
    return new Set(Object.keys((server as any)._registeredTools));
  } finally {
    if (previous === undefined) delete process.env.KLAURO_TOOL_PROFILE;
    else process.env.KLAURO_TOOL_PROFILE = previous;
  }
}

// A minimal, CAS-independent render of the bootstrap prompt: the static teaching
// sections (Operating Rule + "how it RUNS/TALKS/SHIPS") don't depend on rich CAS
// data, so stub inputs are enough to lock their content.
function renderMinimalBootstrapPrompt(): string {
  const cas: any = { system: { name: 'fixture' } };
  const start: any = {
    default_rule: 'default rule',
    system: { type: 'service', description: 'd', languages: [], frameworks: [], top_capabilities: [] },
    scale: { nodes: 0, edges: 0, entry_points: 0, analysis_errors: 0 },
    answer_pack: { gaps: [] },
    when_to_read_files: [],
  };
  const plan: any = { rule: 'plan rule', steps: [] };
  const context: any = {};
  const readiness: any = {
    agent_context_ready: true,
    status: 'ready',
    score: 100,
    profile: { kind: 'agent-fast', confidence: 1 },
    adoption_gaps: [],
  };
  return buildAgentBootstrapPrompt(cas, start, plan, context, readiness);
}

// Each pillar → a regex that must match, keyed by human name for failure clarity.
const CONCEPT_LAYER_PILLARS: Array<[string, RegExp]> = [
  ['runtime/telemetry', /get_runtime_observations/],
  ['communication seams', /get_communication_seams|communication seam/i],
  ['consistency/CAP', /\bCAP\b|eventually consistent|cap_lean/i],
  ['topology', /runtime_topology|topology/i],
  ['CI/CD', /CI\/CD|get_cicd_pipelines/i],
  ['bundled deployable', /bundled_into|bundle members|bundled member|deployable can bundle/i],
];

test('(a) every tool named in SERVER_INSTRUCTIONS is registered', () => {
  const registered = registeredToolNames();
  const named = toolShapedTokens(SERVER_INSTRUCTIONS);
  // Sanity: the extractor found a meaningful number of tool references, so a
  // future refactor that guts the instructions can't make this vacuously pass.
  assert.ok(named.size >= 20, `expected many tool references in instructions, found ${named.size}`);
  const missing = [...named].filter(name => !registered.has(name)).sort();
  assert.deepEqual(
    missing,
    [],
    `SERVER_INSTRUCTIONS names tools that are not registered (rename/remove them, or add to NON_TOOL_TOKENS if they are not tools): ${missing.join(', ')}`
  );
  // The instructions should lead with the primary orient tools.
  for (const anchor of ['get_summary', 'search_nodes', 'get_coding_context']) {
    assert.ok(named.has(anchor), `instructions should name the primary tool ${anchor}`);
  }
});

test('(a2) core-profile anchor tools referenced in instructions are registered', () => {
  const registered = registeredToolNames();
  // Every CORE tool that the instructions mention by name must exist.
  for (const core of CORE_TOOL_NAMES) {
    if (SERVER_INSTRUCTIONS.includes(core)) {
      assert.ok(registered.has(core), `core tool ${core} named in instructions but not registered`);
    }
  }
});

test('(b) SERVER_INSTRUCTIONS teaches every concept-layer pillar', () => {
  for (const [name, rx] of CONCEPT_LAYER_PILLARS) {
    assert.ok(rx.test(SERVER_INSTRUCTIONS), `SERVER_INSTRUCTIONS no longer teaches: ${name}`);
  }
});

test('(b2) the get_agent_bootstrap prompt teaches every concept-layer pillar', () => {
  const prompt = renderMinimalBootstrapPrompt();
  for (const [name, rx] of CONCEPT_LAYER_PILLARS) {
    assert.ok(rx.test(prompt), `get_agent_bootstrap prompt no longer teaches: ${name}`);
  }
});
