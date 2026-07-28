import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildOrientCapsule } from './query';
import { buildSystemFitSummary } from './context-fabric';

// orient_capsule (get_summary) and system_fit (get_system_overview) both surface
// the fabric on the summary path. They must stay DISTINCT and non-redundant:
//   - orient_capsule = a pure {available, count, tool} INDEX: what is pullable,
//     how much, and which tool pulls it — near-zero tokens, NO narrative.
//   - system_fit = the woven NARRATIVE (headline + compacted per-layer content).
// These tests lock that split so neither drifts into the other's job.

/** A CAS rich enough that every capsule dimension is populated and system_fit
 *  weaves a multi-layer headline — the worst case for capsule size. */
function richCas(): CASOutput {
  const nodes = [
    { id: 'p1', type: 'ci_pipeline', name: 'deploy' },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, type: 'function', name: `fn${i}` })),
  ];
  return {
    nodes,
    edges: [],
    analyzer_contributions: [],
    system: { name: 'sample-service' },
    enhanced_system_purpose: { primary_domain: 'payments' },
    entry_points: Array.from({ length: 8 }, () => ({ type: 'http' })),
    exit_points: Array.from({ length: 3 }, () => ({ type: 'http_call' })),
    route_table: Array.from({ length: 12 }, (_, i) => ({ method: 'GET', path: `/r${i}` })),
    data_entities: Array.from({ length: 6 }, (_, i) => ({ name: `E${i}` })),
    system_capabilities: Array.from({ length: 4 }, (_, i) => ({ name: `C${i}` })),
    test_suites: Array.from({ length: 9 }, (_, i) => ({ name: `T${i}` })),
    runtime_static_links: Array.from({ length: 2 }, () => ({})),
    communication_seams: {
      seams: [],
      inventory: { level: 'node', counts: { sync: 2, async: 1, passive: 1, total: 4 }, component_seams: [] },
    },
    consistency_model: {
      passive_seams: [], store_consistency: [],
      counts: { passive_replica: 1, passive_streaming: 0, strong_stores: 0, eventual_stores: 2, tunable_stores: 0 },
    },
    deployable_evidence: [
      { root_path: '.', name: 'client', tier: 1, kind: 'container', evidence: [], ships_paths: ['client-service'], entrypoint_member: 'client-service' },
    ],
    product_map: {
      runtime_topology: {
        edge_count: 3,
        deployables: [{ name: 'client', exposes: ['3000'], routes: [{}], depends_on: ['db'] }],
      },
    },
  } as unknown as CASOutput;
}

test('orient_capsule stays a small index (byte budget) even on a rich system', () => {
  const capsule = buildOrientCapsule(richCas());
  const bytes = Buffer.byteLength(JSON.stringify(capsule), 'utf8');
  // A pure index of ~10 dimensions must stay tiny. This is generous headroom
  // over the real size (~0.9KB); it exists to fail LOUDLY if narrative content
  // (headlines, bundled member lists, seam details) ever leaks into the capsule.
  assert.ok(bytes < 1500, `orient_capsule is ${bytes} bytes — too large for a pure index; did narrative content leak in?`);
});

test('orient_capsule is an INDEX: every dimension is exactly {available,count,tool}', () => {
  const capsule = buildOrientCapsule(richCas());
  const dims = (capsule as any).dimensions as Record<string, unknown>;
  assert.ok(dims && Object.keys(dims).length >= 8, 'capsule should index many dimensions');
  for (const [name, value] of Object.entries(dims)) {
    const v = value as Record<string, unknown>;
    // Exactly the three index keys — no narrative fields, no nested content.
    assert.deepEqual(
      Object.keys(v).sort(),
      ['available', 'count', 'tool'],
      `dimension ${name} must be a pure {available,count,tool} index, got keys ${Object.keys(v).join(',')}`
    );
    assert.equal(typeof v.available, 'boolean');
    assert.equal(typeof v.count, 'number');
    assert.equal(typeof v.tool, 'string');
  }
});

test('orient_capsule carries NO narrative fields (headline/bundles/story)', () => {
  const capsule = buildOrientCapsule(richCas());
  const serialized = JSON.stringify(capsule);
  // Narrative markers that belong to system_fit, not the capsule.
  assert.ok(!('headline' in (capsule as any)), 'capsule must not carry a headline');
  assert.ok(!serialized.includes('bundles'), 'capsule must not enumerate bundled members');
  assert.ok(!serialized.includes('->'), 'capsule must not carry a woven vertical headline');
  // But it DOES point at the tools that pull each dimension (its whole job).
  assert.ok(serialized.includes('get_communication_seams'));
  assert.ok(serialized.includes('get_product_map'));
});

test('capsule and system_fit are complementary, not duplicative', () => {
  const cas = richCas();
  const capsule = buildOrientCapsule(cas) as any;
  const fit = buildSystemFitSummary(cas)!;
  // system_fit weaves a narrative headline; the capsule never does.
  assert.match(fit.headline, /entry point/);
  assert.match(fit.headline, /client bundles client-service/);
  assert.ok(!('headline' in capsule));
  // The capsule points to get_communication_seams as the pulling tool for that
  // dimension; system_fit instead embeds the actual seam summary content.
  assert.equal(capsule.dimensions.communication_seams.tool, 'get_communication_seams');
  assert.ok(fit.communication_seams, 'system_fit embeds seam content, not just a pointer');
});

// --- P0 (2026-07-27 comprehension audit): capsule domain honesty ------------
// When L5 could not ground a product domain, primary_domain / product_map
// identity were null and the domain read "unknown" — yet the capsule in the SAME
// payload confidently reported a domain, because it silently fell back to
// system_purpose.primary_type (a structural artifact label) under the `domain`
// key. An agent reading both had no way to tell which was true.

test('orient_capsule reports an ungrounded domain as null instead of substituting the structural type', () => {
  const cas = {
    nodes: [], edges: [], analyzer_contributions: [],
    system: { name: 'sample-service' },
    // Exactly the audited shape: comprehension produced no product domain.
    enhanced_system_purpose: { primary_domain: '', domain_source: undefined },
    system_purpose: { primary_type: 'trading-automation' },
  } as unknown as CASOutput;
  const capsule = buildOrientCapsule(cas) as Record<string, unknown>;
  assert.equal(capsule.domain, null, 'capsule must not claim a domain comprehension did not produce');
  assert.equal(capsule.domain_source, null);
  // The structural type is still available — under its own name.
  assert.equal(capsule.system_type, 'trading-automation');
});

test('orient_capsule reports a grounded domain with its provenance', () => {
  const cas = {
    nodes: [], edges: [], analyzer_contributions: [],
    system: { name: 'sample-service' },
    enhanced_system_purpose: { primary_domain: 'payments', domain_source: 'ai' },
    system_purpose: { primary_type: 'api-service' },
  } as unknown as CASOutput;
  const capsule = buildOrientCapsule(cas) as Record<string, unknown>;
  assert.equal(capsule.domain, 'payments');
  assert.equal(capsule.domain_source, 'ai');
  assert.equal(capsule.system_type, 'api-service');
});
