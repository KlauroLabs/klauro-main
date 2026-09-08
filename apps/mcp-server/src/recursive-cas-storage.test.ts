import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASMemberReference, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { CasMemberResolutionRequiredError, findCasById } from './recursive-cas-storage';
import { findWorkspaceCasById } from './workspace-member-resolver';
import { projectCasChild, type CASChildProjectedValues } from './cas-child-projection';

const reference: CASMemberReference = {
  format: 'workspace-member-reference', version: 1, project_id: 'project-one',
  composed_id: 'workspace:member', analysis_id: 'analysis-original',
  analysis_timestamp: '2026-09-08T00:00:00.000Z', generation: 'gen-' + 'a'.repeat(64),
  storage_format: 'segmented-v2', loaded_sections: ['identity'], omitted_sections: ['graph', 'facts'],
  loaded_fields: ['id'], omitted_fields: ['nodes', 'edges', 'flows'],
};
function fixture() {
  const base: CASOutput = {
    cas_version: '3.0.0', analysis_id: reference.analysis_id, analysis_timestamp: reference.analysis_timestamp,
    system: { id: 'system', name: 'member', type: 'application', root_path: '/original' },
    nodes: [], edges: [], analyzer_contributions: [], progressive_levels: { total_levels: 0 },
  };
  const child: CASOutput = { ...base, id: reference.composed_id, parent_id: 'workspace:root', label: 'Member', member_reference: reference };
  const root: CASOutput = { ...base, id: 'workspace:root', composition_mode: 'composed', children: [child] };
  const identity = { root_id: 'cas:original', nodes: [
    { id: 'cas:original', parent_id: null, child_ids: ['cas:a', 'cas:b'] },
    { id: 'cas:a', parent_id: 'cas:original', child_ids: [] },
    { id: 'cas:b', parent_id: 'cas:original', child_ids: [] },
  ] };
  return { root, child, identity };
}

test('synchronous member and descendant reads never return an unresolved reference as complete CAS', () => {
  const { root } = fixture();
  for (const id of [reference.composed_id, reference.composed_id + ':cas:a']) {
    assert.throws(() => findCasById(root, id), error => {
      assert.ok(error instanceof CasMemberResolutionRequiredError);
      assert.match(error.message, /requires.*member resolution/i);
      assert.equal(error.casId, id);
      assert.equal(error.owner.member_reference, reference);
      assert.deepEqual(Object.keys(error.owner).sort(), ['id', 'label', 'member_reference', 'parent_id']);
      assert.equal(error.owner.id, reference.composed_id);
      return true;
    });
  }
  assert.equal(findCasById(root, 'not-a-member'), null);
});

test('child projection rejects reference-bearing parents before publishing scoped values', () => {
  const { child } = fixture();
  assert.throws(() => projectCasChild(child, {
    id: 'projected', parent_id: child.id!, label: 'projected', analysis_id: 'child-analysis', system: child.system,
  }, { nodes: [], edges: [] } as unknown as CASChildProjectedValues), /requires.*member resolution/i);
});

test('async member lookup loads requested sections and remaps unloaded sibling provenance without inventing graph data', async () => {
  const { root, identity } = fixture();
  const member = {
    id: 'cas:original', parent_id: null, analysis_id: 'analysis-original', label: 'Original',
    source_input_identities: [{ path: 'src/run.ts', bytes: 7, sha256: 'observed' }],
    source_input_root: '/original',
    analyzer_contributions: [{ analyzer_id: 'reader', source_inputs: { version: 2, identity_indices: [0] } }],
    capabilities: [{ id: 'cap:one', composition_provenance: [{
      source_child_id: 'cas:a', relation_path: [{ source_id: 'cas:a', target_id: 'cas:b' }],
    }] }],
  } as unknown as Partial<CASOutput>;
  const before = structuredClone(member);
  let calls = 0;
  const result = await findWorkspaceCasById(root, reference.composed_id, {
    sections: ['comprehension', 'supplemental'],
    resolveMember: async (requestedReference, sections, options) => {
      calls += 1;
      assert.equal(requestedReference, reference);
      assert.deepEqual(sections, ['comprehension', 'supplemental']);
      assert.equal(options.cas_id, undefined);
      return { reference, sections: [...sections], cas_id: null, identity, member };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result?.id, reference.composed_id);
  assert.equal(result?.parent_id, root.id);
  assert.equal(result?.label, 'Member');
  assert.equal(result?.analysis_id, member.analysis_id);
  assert.equal(Object.hasOwn(result!, 'nodes'), false);
  assert.equal(Object.hasOwn(result!, 'edges'), false);
  assert.equal(Object.hasOwn(result!, 'children'), false);
  assert.equal(result?.capabilities?.[0].composition_provenance?.[0].source_child_id, reference.composed_id + ':cas:a');
  assert.deepEqual(result?.capabilities?.[0].composition_provenance?.[0].relation_path, [{
    source_id: reference.composed_id + ':cas:a', target_id: reference.composed_id + ':cas:b',
  }]);
  assert.deepEqual(result?.source_input_identities, member.source_input_identities);
  assert.deepEqual(result?.analyzer_contributions, member.analyzer_contributions);
  assert.equal(result?.source_input_root, '/original');
  assert.deepEqual(member, before);
  assert.equal(root.children?.[0].member_reference, reference);
});

test('async nested lookup sends only the original selected CAS id to the pinned resolver', async () => {
  const { root, identity } = fixture();
  const result = await findWorkspaceCasById(root, reference.composed_id + ':cas:a', {
    sections: ['graph', 'comprehension'],
    resolveMember: async (_reference, sections, options) => {
      assert.equal(options.cas_id, 'cas:a');
      return { reference, sections: [...sections], cas_id: 'cas:a', identity, member: {
        id: 'cas:a', parent_id: 'cas:original', analysis_id: 'analysis-nested', label: 'A',
        nodes: [{ id: 'cas:b', name: 'B', type: 'cas', metadata: { attributes: { cas_id: 'cas:b' } } }],
        edges: [{ id: 'edge', source: 'cas:a', target: 'cas:b', type: 'calls' }],
        terminality: { nodes: [{ id: 'cas:b', composition_provenance: {
          source_child_id: 'cas:b', supporting_source_ids: ['cas:original', 'ordinary-symbol'],
          relation_path: [{ source_id: 'cas:a', target_id: 'cas:b' }],
        } }], entities: [], flows: [], capabilities: [] },
      } as unknown as Partial<CASOutput> };
    },
  });
  assert.equal(result?.id, reference.composed_id + ':cas:a');
  assert.equal(result?.parent_id, reference.composed_id);
  assert.equal(result?.analysis_id, 'analysis-nested');
  assert.equal(result?.label, 'A');
  assert.equal(result?.nodes?.[0].id, reference.composed_id + ':cas:b');
  assert.equal(result?.nodes?.[0].metadata?.attributes?.cas_id, reference.composed_id + ':cas:b');
  assert.equal(result?.edges?.[0].target, reference.composed_id + ':cas:b');
  assert.deepEqual(result?.terminality?.nodes[0].composition_provenance?.supporting_source_ids, [reference.composed_id, 'ordinary-symbol']);
});

test('member resolution propagates authorization and pruned-generation errors without fallback', async () => {
  const { root } = fixture();
  for (const message of ['not_authorized', 'generation_missing']) {
    const error = new Error(message);
    await assert.rejects(findWorkspaceCasById(root, reference.composed_id, {
      sections: ['facts'], resolveMember: async () => { throw error; },
    }), candidate => candidate === error);
  }
});

test('resolver identity mismatch and invalid identity trees fail instead of mapping unrelated data', async () => {
  const { root, identity } = fixture();
  for (const value of [
    { identity, member: { id: 'cas:other' } },
    { identity: { ...identity, nodes: identity.nodes.slice(0, 1) }, member: { id: identity.root_id } },
  ]) {
    await assert.rejects(findWorkspaceCasById(root, reference.composed_id, {
      sections: ['facts'],
      resolveMember: async (_reference, sections) => ({ reference, sections: [...sections], cas_id: null, ...value }),
    }), /identity|missing child/i);
  }
});

test('complete in-memory CAS lookup keeps its synchronous contract and needs no member resolver', async () => {
  const { root } = fixture();
  assert.equal(findCasById(root, root.id!), root);
  const result = await findWorkspaceCasById(root, root.id!, {
    sections: ['identity'], resolveMember: async () => { throw new Error('unexpected resolver'); },
  });
  assert.equal(result?.id, root.id);
  assert.equal(await findWorkspaceCasById(root, reference.composed_id + '-different', {
    sections: ['identity'], resolveMember: async () => { throw new Error('prefix collision'); },
  }), null);
});
