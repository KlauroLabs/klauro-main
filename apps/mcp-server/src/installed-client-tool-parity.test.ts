import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { INSTALLED_TOOL_NAMES } from './installed-client-server';

/**
 * Task #130 regression gate.
 *
 * The defect: `apps/mcp-server/src/server.ts` (the hosted server's own
 * ~211-tool MCP surface) and `apps/mcp-server/src/installed-client-server.ts`
 * (the ~28-tool surface actually reached by `index.ts`, which is what every
 * agent's MCP client connects to via the shipped npm package) silently
 * diverged. `fab_claim_work`, `fab_check_collision`, `fab_extend`,
 * `fab_list_active_work`, `fab_release_work`, `plan_parallel_work`,
 * `check_conceptual_conflicts`, `plan_intent_merge`, `get_module_health`, and
 * every workspace/parent-CAS composition tool existed only on the hosted
 * surface — no agent using the installed client could ever call them, while
 * docs and product doctrine kept describing them as available. Nothing
 * compared the two surfaces, so the gap went unnoticed for an entire release
 * cycle ("Klauro on prod" notes, `docs/cas/SPECIFICATION.md` §0.12 item 7).
 *
 * This is NOT a blind 1:1 diff of every tool in server.ts or every heading in
 * docs/mcp/TOOLS.md against the installed client — most of that ~211/~195
 * tool surface is deliberately hosted-only (admin, benchmark, watcher-CLI,
 * and internal-analysis-debugging tools with no customer-facing consumer),
 * and copying all of it onto the client would trade a curated, agent-usable
 * 46-tool surface for an undefended ~200-tool one (task #130's own
 * instructions: "I would rather have a defended 35 than an undefended 179").
 *
 * Instead this gate encodes the tools doctrine explicitly promises an agent
 * can call — the owner's standing fabric-first workflow (`CLAUDE.md`:
 * "use plan_parallel_work FIRST ... then fab_claim_work, with ambient
 * check_conceptual_conflicts and plan_intent_merge") plus the specific named
 * gap from task #130 itself (module health, parent-CAS composition) — and
 * fails if ANY of them is missing from `INSTALLED_TOOL_NAMES`. Whichever of
 * these tools docs/mcp/TOOLS.md documents is additionally checked against the
 * doc text itself, so a future doc/product drift on an already-covered tool
 * is caught too. Add to `DOCTRINE_REQUIRED_TOOLS` whenever a new tool becomes
 * a documented or doctrine-promised customer capability — an unlisted tool is
 * exactly the silent-rot failure mode this gate exists to close.
 */

const TOOLS_DOC_PATH = path.join(__dirname, '..', '..', '..', 'docs', 'mcp', 'TOOLS.md');

interface DoctrineTool {
  name: string;
  /** Why this is a promised customer capability, independent of whether
   *  docs/mcp/TOOLS.md happens to document it yet. */
  source: 'CLAUDE.md fabric doctrine' | 'task-130 defect list' | 'AGENTS.md agent operating loop';
}

const DOCTRINE_REQUIRED_TOOLS: DoctrineTool[] = [
  { name: 'fab_claim_work', source: 'CLAUDE.md fabric doctrine' },
  { name: 'fab_check_collision', source: 'CLAUDE.md fabric doctrine' },
  { name: 'fab_extend', source: 'task-130 defect list' },
  { name: 'fab_list_active_work', source: 'task-130 defect list' },
  { name: 'fab_release_work', source: 'task-130 defect list' },
  { name: 'plan_parallel_work', source: 'CLAUDE.md fabric doctrine' },
  { name: 'check_conceptual_conflicts', source: 'CLAUDE.md fabric doctrine' },
  { name: 'plan_intent_merge', source: 'CLAUDE.md fabric doctrine' },
  { name: 'get_module_health', source: 'task-130 defect list' },
  { name: 'run_workspace_analysis', source: 'task-130 defect list' },
  { name: 'get_workspace_analysis', source: 'task-130 defect list' },
  { name: 'evaluate_analysis_truth', source: 'AGENTS.md agent operating loop' },
  { name: 'get_semantic_map', source: 'AGENTS.md agent operating loop' },
  { name: 'get_framework_depth_report', source: 'AGENTS.md agent operating loop' },
  { name: 'get_runtime_instrumentation_plan', source: 'AGENTS.md agent operating loop' },
  { name: 'evaluate_agent_task_proof', source: 'AGENTS.md agent operating loop' },
  { name: 'evaluate_agent_readiness', source: 'AGENTS.md agent operating loop' },
];

function toolsDocumentedInToolsMd(): Set<string> {
  const text = fs.readFileSync(TOOLS_DOC_PATH, 'utf8');
  const names = new Set<string>();
  for (const match of text.matchAll(/^### `([a-zA-Z_0-9]+)`/gm)) names.add(match[1]);
  return names;
}

test('every doctrine-promised coordination/module-health/workspace tool is registered on the installed client', () => {
  const installed = new Set<string>(INSTALLED_TOOL_NAMES);
  const missing = DOCTRINE_REQUIRED_TOOLS.filter(tool => !installed.has(tool.name));
  assert.deepEqual(
    missing,
    [],
    `Doctrine-promised tool(s) missing from INSTALLED_TOOL_NAMES (apps/mcp-server/src/installed-client-server.ts) — ` +
    `an agent using the shipped npm client cannot call these even though doctrine/task-130 says it should be able to: ` +
    `${missing.map(tool => `${tool.name} (${tool.source})`).join(', ')}`
  );
});

test('docs/mcp/TOOLS.md coverage of doctrine-required tools matches the installed client, where documented', () => {
  const documented = toolsDocumentedInToolsMd();
  const installed = new Set<string>(INSTALLED_TOOL_NAMES);
  const driftedFromDocs = DOCTRINE_REQUIRED_TOOLS.filter(tool => documented.has(tool.name) && !installed.has(tool.name));
  assert.deepEqual(
    driftedFromDocs,
    [],
    `docs/mcp/TOOLS.md documents these tools as available, but they are absent from the installed client: ` +
    `${driftedFromDocs.map(tool => tool.name).join(', ')}`
  );
});

test('sanity: the parsed docs/mcp/TOOLS.md heading set is non-trivial and finds known-documented tools', () => {
  const documented = toolsDocumentedInToolsMd();
  // Guards the regex/parse itself: if docs/mcp/TOOLS.md is renamed, reformatted
  // (e.g. headings stop being literal `### \`name\``), or moved, this test
  // fails LOUDLY instead of the two tests above passing vacuously with an
  // empty `documented` set.
  assert.ok(documented.size > 100, `Expected docs/mcp/TOOLS.md to document 100+ tools via '### \`name\`' headings, found ${documented.size} — the parser or file path likely broke.`);
  assert.ok(documented.has('analyze_codebase'));
  assert.ok(documented.has('check_conceptual_conflicts'));
  assert.ok(documented.has('plan_intent_merge'));
  assert.ok(documented.has('run_workspace_analysis'));
  assert.ok(documented.has('get_workspace_analysis'));
});
