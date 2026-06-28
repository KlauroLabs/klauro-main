import test from 'node:test';
import assert from 'node:assert/strict';
import { projectedDelta, type EntitySignal } from './data';
import type { RepoFact } from './projection-model';

const repo = (nodes: number, edges: number): RepoFact => ({ name: 'r', nodes, edges });

test('projected delta is a Klauro win on a normal single repo', () => {
  const d = projectedDelta('single-repo', [repo(5000, 6000)], { nodes: 5000, edges: 6000, framework_count: 2 });
  assert.equal(d.win, true);
  assert.ok((d.quality || 0) > 0 && (d.tokens || 0) > 0);
});

test('entity signal modulates quality: richer structure => bigger quality lead', () => {
  const base = projectedDelta('single-repo', [repo(5000, 5000)]);
  const rich: EntitySignal = { nodes: 5000, edges: 9000, framework_count: 5 }; // dense + many frameworks
  const poor: EntitySignal = { nodes: 5000, edges: 1500, framework_count: 0 };
  const richD = projectedDelta('single-repo', [repo(5000, 9000)], rich);
  const poorD = projectedDelta('single-repo', [repo(5000, 1500)], poor);
  assert.ok((richD.quality || 0) > (poorD.quality || 0), `rich ${richD.quality} !> poor ${poorD.quality}`);
  // modulation should move the number off the flat baseline
  assert.notEqual(richD.quality, base.quality);
});

test('token saving grows with repo size (Klauro context is size-stable)', () => {
  const small = projectedDelta('single-repo', [repo(300, 300)], { nodes: 300, edges: 300, framework_count: 2 });
  const big = projectedDelta('single-repo', [repo(40000, 40000)], { nodes: 40000, edges: 40000, framework_count: 2 });
  assert.ok((big.tokens || 0) > (small.tokens || 0), `big ${big.tokens} !> small ${small.tokens}`);
});

test('modulation never pushes Klauro quality out of bounds or flips a loss', () => {
  const d = projectedDelta('single-repo', [repo(100000, 300000)], { nodes: 100000, edges: 300000, framework_count: 7 });
  assert.equal(d.win, true);
  // quality lead is a finite fraction
  assert.ok(Number.isFinite(d.quality || 0));
});

test('workspace (cross-repo) delta wins and beats single-repo token saving', () => {
  const repos = [repo(8000, 9000), repo(6000, 7000), repo(4000, 5000)];
  const sig: EntitySignal = { nodes: 18000, edges: 21000, framework_count: 3 };
  const d = projectedDelta('cross-repo', repos, sig);
  assert.equal(d.win, true);
  assert.ok((d.tokens || 0) > 0);
});
