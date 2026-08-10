import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { ComposeAnalyzer } from './compose-analyzer';
import type { AnalysisContext } from '../../core/base-analyzer';

// Point straight at the component-bench fixture so this unit test and the
// gauntlet stay in lockstep on the same Compose sample.
const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../../../../apps/mcp-server/fixtures/component-bench/compose-tree'
);

function ctx(projectPath: string): AnalysisContext {
  return { projectPath } as AnalysisContext;
}

/** Reproduce the bench's edge → "Src renders Tgt" projection over the CAS. */
function renderTree(nodes: any[], edges: any[]): string[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  return [
    ...new Set(
      edges
        .filter(e => /render/i.test(String(e.type || '')))
        .map(e => {
          const s: any = byId.get(e.source);
          const t: any = byId.get(e.target);
          return s && t ? `${s.name} renders ${t.name}` : '';
        })
        .filter(Boolean)
    ),
  ].sort();
}

test('ComposeAnalyzer.canAnalyze is true for a @Composable project', async () => {
  const analyzer = new ComposeAnalyzer();
  assert.equal(await analyzer.canAnalyze(FIXTURE_DIR), true);
});

test('ComposeAnalyzer emits the exact composable render tree', async () => {
  const analyzer = new ComposeAnalyzer();
  const contribution = await analyzer.analyze(ctx(FIXTURE_DIR));

  const componentNames = contribution.nodes
    .filter(n => n.type === 'component')
    .map(n => n.name)
    .sort();

  // Every @Composable becomes a component node; the ordinary decoy does NOT.
  assert.deepEqual(componentNames, ['App', 'Footer', 'Header', 'UserCard', 'UserList']);
  assert.ok(!componentNames.includes('formatTitle'), 'decoy ordinary fn must not be a component');

  // All component nodes carry a prop_count.
  const byName = new Map(contribution.nodes.filter(n => n.type === 'component').map(n => [n.name, n]));
  assert.equal((byName.get('UserCard') as any).metadata.attributes.prop_count, 1);
  assert.equal((byName.get('App') as any).metadata.attributes.prop_count, 0);
  assert.equal((byName.get('Header') as any).metadata.attributes.prop_count, 1);

  // renders edges have the correct type + category and carry prop_count.
  const renderEdges = contribution.edges.filter(e => e.type === 'renders');
  assert.ok(renderEdges.length > 0, 'expected renders edges');
  for (const e of renderEdges) {
    assert.equal(e.category, 'behavior');
    assert.equal(typeof (e.metadata as any).prop_count, 'number');
  }

  // The exact render tree — F1 must be 1.0 against truth.json.
  const tree = renderTree(contribution.nodes, contribution.edges);
  assert.deepEqual(tree, [
    'App renders Footer',
    'App renders Header',
    'App renders UserList',
    'UserList renders UserCard',
  ]);

  // Precision: no edge into the Compose built-in `Text` (undeclared here).
  assert.ok(!tree.some(t => /renders Text$/.test(t)), 'must not render undeclared Text');
});

test('ComposeAnalyzer emits an entry point for the root of the render tree', async () => {
  const analyzer = new ComposeAnalyzer();
  const contribution = await analyzer.analyze(ctx(FIXTURE_DIR));

  // App is rendered by nothing else in the fixture, so it is the one
  // user-reachable screen; every other composable is rendered by App (or by
  // UserList) and must NOT also be surfaced as an entry point.
  const entryNames = (contribution.entry_points ?? []).map(e => e.name).sort();
  assert.deepEqual(entryNames, ['App']);
  assert.equal((contribution.entry_points ?? [])[0].type, 'page');
});
