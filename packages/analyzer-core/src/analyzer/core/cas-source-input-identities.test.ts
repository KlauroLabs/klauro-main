import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASAnalyzerContribution, CASOutput, CASSourceInputIdentity } from '../../types/cas.types';
import { compactCasSourceInputIdentities, sourceInputIdentityAt } from './cas-source-input-identities';
import { sourceInputObservation } from './analyzer-source-inputs';
import { invalidateIncrementalSourceInputs } from './analyzer-contribution-summary';

function contributor(files: CASSourceInputIdentity[], id = 'first'): CASAnalyzerContribution {
  return { analyzer_id: id, analyzer_name: id, contribution_type: 'language',
    source_inputs: { version: 1, coverage: 'observed-reads', digest_algorithm: 'sha256', outside_root_reads: 2, files } };
}

type Catalog = Pick<CASOutput, 'analyzer_contributions' | 'source_input_identities'>;

function expand(cas: Catalog) {
  return cas.analyzer_contributions.map(contribution => {
    const inputs = contribution.source_inputs;
    if (!inputs || inputs.version === 1) return contribution;
    const { identity_indices, ...metadata } = inputs;
    return { ...contribution, source_inputs: { ...metadata, version: 1,
      files: identity_indices.map(index => sourceInputIdentityAt(cas.source_input_identities, index)) } };
  });
}

const row = (file: string, content = file): CASSourceInputIdentity => ({ path: file, ...sourceInputObservation(content, 'utf8') });

test('canonical sharing expands losslessly including repeated observations and error evidence', () => {
  const first = row('src/a.ts');
  const conflicting = { ...first, status: 'conflicting' as const, reason: 'captured-then-unavailable', error_code: 'EACCES' };
  const unavailable = { path: 'src/missing.ts', status: 'unavailable' as const, reason: 'source-read-failed', error_code: 'ENOENT' };
  const cas: Catalog = { analyzer_contributions: [contributor([first, first, conflicting, unavailable]),
    contributor([{ ...first }, row('src/b.ts')], 'second')] };
  const original = structuredClone(cas.analyzer_contributions);
  compactCasSourceInputIdentities(cas);
  assert.equal(cas.source_input_identities?.length, 4);
  assert.deepEqual(expand(cas), original);
  assert.equal(cas.analyzer_contributions[0].source_inputs?.version, 2);
  assert.deepEqual(first, original[0].source_inputs?.version === 1 ? original[0].source_inputs.files[0] : null);
});

test('canonical table ordering is deterministic and compaction is idempotent', () => {
  const a = row('src/z.ts');
  const b = row('src/é.ts');
  const left: Catalog = { analyzer_contributions: [contributor([a, b])] };
  const right: Catalog = { analyzer_contributions: [contributor([b, { bytes: a.bytes, path: a.path,
    representation: a.representation, sha256: a.sha256, status: a.status }])] };
  compactCasSourceInputIdentities(left);
  compactCasSourceInputIdentities(right);
  assert.deepEqual(left.source_input_identities, right.source_input_identities);
  const snapshot = structuredClone(left);
  compactCasSourceInputIdentities(left);
  assert.deepEqual(left, snapshot);
});

test('raw cache metadata and all non-input CAS graph fields remain untouched', () => {
  const input = contributor([row('a.ts')]);
  const original = structuredClone(input);
  const cas = { analyzer_contributions: [input], nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'b' }] };
  const nodes = cas.nodes;
  const edges = cas.edges;
  compactCasSourceInputIdentities(cas);
  assert.deepEqual(input, original);
  assert.equal(cas.nodes, nodes);
  assert.equal(cas.edges, edges);
});

test('existing referenced and new raw contributions can be combined without losing unused table evidence', () => {
  const a = row('a.ts'), b = row('b.ts'), historical = row('previous.ts');
  const cas: Catalog = { analyzer_contributions: [contributor([a])], source_input_identities: [historical] };
  compactCasSourceInputIdentities(cas);
  cas.analyzer_contributions.push(contributor([b, a], 'second'));
  const expected = structuredClone(expand(cas));
  compactCasSourceInputIdentities(cas);
  assert.deepEqual(expand(cas), expected);
  assert.equal(cas.source_input_identities?.length, 3);
  assert.ok(cas.source_input_identities?.some(identity => identity.path === historical.path));
});

test('invalid references never get rebound to a new table entry', () => {
  for (const reference of [-1, 1, 0.5, NaN, '0', '__proto__']) {
    const cas: Catalog = { analyzer_contributions: [contributor([row('a.ts')])] };
    compactCasSourceInputIdentities(cas);
    const inputs = cas.analyzer_contributions[0].source_inputs;
    assert.ok(inputs?.version === 2);
    inputs.identity_indices = [reference as number];
    cas.analyzer_contributions.push(contributor([row('b.ts')], 'second'));
    const before = structuredClone(cas);
    compactCasSourceInputIdentities(cas);
    assert.deepEqual(cas, { ...before, source_input_catalog: { status: 'unnormalized', reason: 'invalid-input-reference' } });
    assert.equal(sourceInputIdentityAt(cas.source_input_identities, reference), undefined);
  }
});

test('sparse or absent tables and nonobject identities cannot invent evidence', () => {
  assert.equal(sourceInputIdentityAt(undefined, 0), undefined);
  assert.equal(sourceInputIdentityAt(new Array(1), 0), undefined);
  assert.equal(sourceInputIdentityAt([null], 0), undefined);
  const cas: Catalog = { analyzer_contributions: [contributor([null as unknown as CASSourceInputIdentity])] };
  const before = structuredClone(cas);
  compactCasSourceInputIdentities(cas);
  assert.deepEqual(cas, { ...before, source_input_catalog: { status: 'unnormalized', reason: 'invalid-input-identity' } });
});

test('child CAS identities remain local and never implicitly inherit the parent table', () => {
  const child: Catalog = { analyzer_contributions: [contributor([row('same.ts', 'child')])] };
  compactCasSourceInputIdentities(child);
  const before = structuredClone(child);
  const parent = { analyzer_contributions: [contributor([row('same.ts', 'parent')])], children: [child] };
  compactCasSourceInputIdentities(parent);
  assert.deepEqual(parent.children[0], before);
  assert.notDeepEqual(expand(parent)[0].source_inputs, expand(child)[0].source_inputs);
});

test('legacy absence remains absence and incremental invalidation remains explicit', () => {
  const legacy: Catalog = { analyzer_contributions: [{ analyzer_id: 'legacy', analyzer_name: 'legacy', contribution_type: 'language' }] };
  compactCasSourceInputIdentities(legacy);
  assert.equal(legacy.source_input_identities, undefined);
  const cas: Catalog = { analyzer_contributions: [contributor([row('source.ts')])] };
  compactCasSourceInputIdentities(cas);
  cas.analyzer_contributions = invalidateIncrementalSourceInputs(cas.analyzer_contributions);
  compactCasSourceInputIdentities(cas);
  assert.equal(cas.analyzer_contributions[0].source_inputs?.coverage, 'unavailable');
  assert.equal(cas.analyzer_contributions[0].source_inputs?.reason, 'incremental-input-identities-not-refreshed');
});

test('JSON round trips preserve nullable and extension fields without merging distinct identities', () => {
  const missing = { ...row('source.ts'), reason: undefined };
  const nullable = { ...row('source.ts'), reason: null } as unknown as CASSourceInputIdentity;
  const extension = { ...row('source.ts'), producer_detail: { parser: 'custom' } };
  const cas: Catalog = { analyzer_contributions: [contributor([missing, nullable, extension])] };
  const expected = JSON.parse(JSON.stringify(cas.analyzer_contributions));
  compactCasSourceInputIdentities(cas);
  assert.equal(cas.source_input_identities?.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(expand(cas))), expected);
});
