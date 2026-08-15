import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { captureCasGraphFingerprint, compareCasGraphFingerprint } from './incremental-graph-equivalence';

function output(): CASOutput {
  return {
    cas_version: '3.0.0',
    analysis_timestamp: '2026-08-14T00:00:00.000Z',
    analysis_id: 'fingerprint-fixture',
    system: { id: 'fixture', name: 'Fixture', type: 'service', root_path: '.' },
    nodes: [
      { id: 'a', name: 'A', type: 'function' },
      { id: 'b', name: 'B', type: 'function' },
    ],
    edges: [{ id: 'a-b', source: 'a', target: 'b', type: 'calls' }],
    entry_points: [],
    exit_points: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 1 },
  } as unknown as CASOutput;
}

test('graph fingerprints prove exact equality without retaining the original CAS', () => {
  const original = output();
  const fingerprint = captureCasGraphFingerprint(original);
  const reordered = structuredClone(original);
  reordered.nodes.reverse();
  assert.equal(compareCasGraphFingerprint(fingerprint, reordered).graph_equivalent, true);
});

test('graph fingerprints report content changes and missing items', () => {
  const fingerprint = captureCasGraphFingerprint(output());
  const changed = output();
  changed.nodes[0].name = 'Changed';
  changed.nodes.pop();
  const comparison = compareCasGraphFingerprint(fingerprint, changed);
  assert.equal(comparison.graph_equivalent, false);
  assert.equal(comparison.graph_difference_count, 2);
  assert.match(comparison.graph_difference_sample.join('\n'), /content-changed/);
  assert.match(comparison.graph_difference_sample.join('\n'), /missing-from-cold/);
});
