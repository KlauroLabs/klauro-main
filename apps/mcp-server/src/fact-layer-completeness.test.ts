import { strict as assert } from 'assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SERVER_INSTRUCTIONS, createServer } from './server';
import { buildOrientCapsule } from './query';

// FACT-LAYER COMPLETENESS GUARD — the standing "last-mile rule" gate.
//
// Every new fact layer must ship SURFACED, not just computed: it gets a
// capsule dimension, is taught in SERVER_INSTRUCTIONS, and (where the
// channel-parity matrix says a CLI read exists) is wired in cli.ts. This
// session's retro: seams did all of that; runtime topology shipped computed
// but unmeasured/broken. This test makes the rule mechanical — a new
// buildOrientCapsule dimension that skips teaching or parity fails loudly.
//
// Companion checklist: docs/FACT-LAYER-CHECKLIST.md (the human ship-gate this
// test enforces the enforceable slice of).

/**
 * CHANNEL-PARITY MATRIX for orient-capsule dimensions.
 *
 * Key = dimension key in buildOrientCapsule (query.ts). Value:
 *   cli — the engineer-facing CLI read subcommand wrapping the SAME query
 *         builder (the "Read surfaces (CLI parity with the MCP reads)" section
 *         of cli.ts), or null when the dimension is MCP-only by design.
 *
 * Adding a dimension to buildOrientCapsule WITHOUT adding a row here fails the
 * matrix-completeness test below — that is the point. Decide the CLI story
 * (subcommand or an explicit null) at ship time, not never.
 */
const DIMENSION_PARITY: Record<string, { cli: string | null }> = {
  behavior_surfaces: { cli: null },
  entry_points: { cli: null },
  routes: { cli: null },
  exit_points: { cli: null },
  communication_seams: { cli: 'seams' },
  cicd_pipelines: { cli: 'cicd' },
  runtime_topology: { cli: 'product-map' },
  runtime_node_metrics: { cli: 'node-metrics' },
  data_entities: { cli: null },
  capabilities: { cli: null },
  tests: { cli: null },
};

/** Dimension list straight from the product surface (no duplicated fixture). */
function capsuleDimensions(): Array<[string, { tool: string }]> {
  const emptyCas: any = { nodes: [], edges: [], system: { name: 'guard-fixture' } };
  const capsule = buildOrientCapsule(emptyCas);
  return Object.entries(capsule.dimensions) as Array<[string, { tool: string }]>;
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

function cliSource(): string {
  return fs.readFileSync(path.join(__dirname, 'cli.ts'), 'utf8');
}

test('fact-layer guard: every orient-capsule dimension names a REGISTERED tool', () => {
  const registered = registeredToolNames();
  const dimensions = capsuleDimensions();
  assert.ok(dimensions.length >= 10, `expected the capsule to index many dimensions, found ${dimensions.length}`);
  const missing = dimensions
    .filter(([, dim]) => !registered.has(dim.tool))
    .map(([name, dim]) => `${name} -> ${dim.tool}`);
  assert.deepEqual(missing, [],
    `orient-capsule dimensions point at unregistered tools (the capsule teaches a pull that does not exist): ${missing.join(', ')}`);
});

test('fact-layer guard: every orient-capsule dimension tool is TAUGHT in SERVER_INSTRUCTIONS', () => {
  const untaught = capsuleDimensions()
    .filter(([, dim]) => !SERVER_INSTRUCTIONS.includes(dim.tool))
    .map(([name, dim]) => `${name} -> ${dim.tool}`);
  assert.deepEqual(untaught, [],
    `orient-capsule dimensions whose tool is never mentioned in SERVER_INSTRUCTIONS (shipped fact layer nobody is taught to pull): ${untaught.join(', ')}`);
});

test('fact-layer guard: the channel-parity matrix covers EXACTLY the capsule dimensions', () => {
  const fromCapsule = capsuleDimensions().map(([name]) => name).sort();
  const fromMatrix = Object.keys(DIMENSION_PARITY).sort();
  assert.deepEqual(fromCapsule, fromMatrix,
    'buildOrientCapsule dimensions and DIMENSION_PARITY diverged — a new fact layer must add a parity row (CLI subcommand or explicit null) when it adds a capsule dimension');
});

test('fact-layer guard: every parity-matrix CLI subcommand is WIRED and DOCUMENTED in cli.ts', () => {
  const source = cliSource();
  for (const [dimension, parity] of Object.entries(DIMENSION_PARITY)) {
    if (!parity.cli) continue;
    assert.ok(
      source.includes(`args.command === '${parity.cli}'`),
      `dimension ${dimension}: CLI subcommand '${parity.cli}' from the parity matrix is not wired in cli.ts`);
    assert.ok(
      new RegExp(`klauro ${parity.cli}\\b`).test(source),
      `dimension ${dimension}: CLI subcommand '${parity.cli}' is wired but not documented in the cli.ts help text`);
  }
  // The orient capsule itself must stay CLI-reachable (klauro orient).
  assert.ok(source.includes(`args.command === 'orient'`), `the orient capsule lost its own CLI read ('klauro orient')`);
});
