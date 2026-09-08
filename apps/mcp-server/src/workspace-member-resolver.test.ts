import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CASMemberReference, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { clearLoadedAnalysisCache, loadAnalysisSectionManifest, resolveAnalysisForLoad, saveAnalysis } from './storage';
import { segmentedAnalysisRoot } from './segmented-analysis-storage';
import { resolveWorkspaceMember, WorkspaceMemberResolutionError } from './workspace-member-resolver';
import { loadWorkspaceMemberProjection } from './account-workspace-analysis';
import { workspaceMemberReference } from './workspace-member-reference';

function memberFixture(id: string, extra: Partial<CASOutput> = {}): CASOutput {
  return {
    cas_version: '1.11.0', analysis_id: id, analysis_timestamp: `2026-09-0${id.length % 9 || 1}T00:00:00.000Z`,
    system: { name: 'member', type: 'service' },
    nodes: [{ id: `${id}-node`, name: 'run', type: 'function', level: 1, file: 'src/run.ts' }],
    edges: [], method_calls: [{ caller_id: `${id}-node`, callee_name: 'run' }],
    analysis_facts: [{ id: `${id}-fact`, subject_id: `${id}-node`, kind: 'test' }],
    flows: [{ id: `${id}-flow`, name: 'flow', steps: [] }],
    intents: [{ id: `${id}-intent` }],
    entry_points: [{ id: `${id}-entry`, name: 'GET /run', type: 'http' }],
    exit_points: [{ id: `${id}-exit`, type: 'http-call', source_node: `${id}-node` }],
    source_input_identities: [{ id: `${id}-identity`, path: 'src/run.ts' }],
    analyzer_contributions: [], progressive_levels: [],
    layers_ready: {
      complete: true, generated_at: '2026-09-01T00:00:00.000Z',
      layers: [
        { layer: 'L1', name: 'graph', status: 'ready', fields: ['nodes', 'edges'] },
        { layer: 'L4', name: 'comprehension', status: 'ready', fields: ['flows', 'intents', 'entry_points'] },
      ],
    },
    ...extra,
  } as unknown as CASOutput;
}

async function withStorage<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const previous = process.env.KLAURO_STORAGE_PATH;
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-member-resolver-'));
  process.env.KLAURO_STORAGE_PATH = storagePath;
  clearLoadedAnalysisCache();
  try {
    return await fn(storagePath);
  } finally {
    clearLoadedAnalysisCache();
    if (previous === undefined) delete process.env.KLAURO_STORAGE_PATH; else process.env.KLAURO_STORAGE_PATH = previous;
    await fs.remove(storagePath);
  }
}

test('workspace member projection stamps an honest reference and resolves the pinned generation', async () => {
  await withStorage(async () => {
    const memberWorkspace = path.join(os.tmpdir(), 'klauro-member-resolver-project');
    await saveAnalysis(memberWorkspace, memberFixture('first'), 'main', { canonicalSegmented: true });
    const projected = await loadWorkspaceMemberProjection(memberWorkspace, 'prj_member');
    assert.ok(projected?.member_reference);
    const reference = projected!.member_reference as CASMemberReference;
    assert.equal(reference.project_id, 'prj_member');
    assert.equal(reference.analysis_id, 'first');
    assert.match(reference.generation, /^gen-[a-f0-9]{64}$/);
    assert.ok(reference.omitted_sections.includes('graph'));
    assert.ok(reference.omitted_fields.includes('intents'));
    assert.equal(projected!.intents, undefined);
    assert.equal(projected!.layers_ready?.complete, false);
    assert.equal(projected!.layers_ready?.layers.find(layer => layer.layer === 'L4')?.status, 'not_loaded');
    assert.deepEqual(projected!.layers_ready?.layers.find(layer => layer.layer === 'L4')?.not_loaded_fields, ['intents']);
    assert.equal(projected!.layers_ready?.layers.find(layer => layer.layer === 'L1')?.status, 'not_loaded');

    const child = workspaceMemberReference({ path: 'account-project:prj_member', name: 'member', cas: { ...projected, nodes: [], edges: [] } as CASOutput }, 'codebase-1');
    assert.equal(child.id, 'workspace:codebase-1');
    assert.equal(child.member_reference?.composed_id, 'workspace:codebase-1');
    assert.equal('entry_points' in child, false);
    assert.ok(child.member_reference?.omitted_fields.includes('entry_points'));

    const context = {
      listProjectsForWorkspace: async (workspaceId: string) => workspaceId === 'wsp_ok' ? [{ id: 'prj_member', analysis_id: 'member-analysis' }] : [],
      workspacePathFor: () => memberWorkspace,
    };
    const resolved = await resolveWorkspaceMember(context, 'wsp_ok', child.member_reference!, ['comprehension', 'supplemental', 'facts']);
    assert.equal(resolved.member.analysis_id, 'first');
    assert.deepEqual(resolved.member.flows, memberFixture('first').flows);
    assert.deepEqual(resolved.member.intents, memberFixture('first').intents);
    assert.deepEqual(resolved.member.entry_points, memberFixture('first').entry_points);
    assert.deepEqual(resolved.member.source_input_identities, memberFixture('first').source_input_identities);
    assert.equal(resolved.member.nodes, undefined);
    assert.equal(resolved.identity.root_id, 'cas:first');
    const explicit = path.join(os.tmpdir(), 'klauro-member-resolver-explicit');
    await saveAnalysis(explicit, memberFixture('explicit', { id: 'cas:custom-root' } as Partial<CASOutput>), 'main', { canonicalSegmented: true });
    const explicitProjection = await loadWorkspaceMemberProjection(explicit, 'prj_explicit');
    const explicitResolved = await resolveWorkspaceMember({ listProjectsForWorkspace: async () => [{ id: 'prj_explicit', analysis_id: 'x' }], workspacePathFor: () => explicit }, 'wsp_ok', explicitProjection!.member_reference as CASMemberReference, ['identity']);
    assert.equal(explicitResolved.identity.root_id, 'cas:custom-root');
    await assert.rejects(resolveWorkspaceMember(context, 'wsp_other', child.member_reference!, ['facts']), (error: unknown) => error instanceof WorkspaceMemberResolutionError && error.code === 'not_authorized');
    await assert.rejects(resolveWorkspaceMember(context, 'wsp_ok', child.member_reference!, ['facts'], { cas_id: 'cas:nope' }), (error: unknown) => error instanceof WorkspaceMemberResolutionError && error.code === 'cas_missing');

    await saveAnalysis(memberWorkspace, memberFixture('second'), 'main', { canonicalSegmented: true });
    clearLoadedAnalysisCache();
    const manifest = await loadAnalysisSectionManifest(memberWorkspace);
    assert.equal(manifest?.analysis_id, 'second');
    const pinned = await resolveWorkspaceMember(context, 'wsp_ok', child.member_reference!, ['comprehension']);
    assert.equal(pinned.member.analysis_id, 'first');
    assert.deepEqual(pinned.member.flows, memberFixture('first').flows);

    const resolvedForLoad = await resolveAnalysisForLoad(memberWorkspace);
    await fs.remove(path.join(segmentedAnalysisRoot(resolvedForLoad!.filePath), reference.generation));
    await assert.rejects(resolveWorkspaceMember(context, 'wsp_ok', child.member_reference!, ['comprehension']), (error: unknown) => error instanceof WorkspaceMemberResolutionError && error.code === 'generation_missing');
    const secondManifest = await loadAnalysisSectionManifest(memberWorkspace);
    const secondGeneration = (await fs.readJson(path.join(segmentedAnalysisRoot(resolvedForLoad!.filePath), 'current.json'))).current as string;
    await fs.writeFile(path.join(segmentedAnalysisRoot(resolvedForLoad!.filePath), 'current.json'), '{"manifest_version":2,"current":"gen-corrupt"}');
    const throughCorruptPointer = await resolveWorkspaceMember(context, 'wsp_ok', { ...child.member_reference!, analysis_id: String(secondManifest?.analysis_id), generation: secondGeneration }, ['comprehension']);
    assert.equal(throughCorruptPointer.member.analysis_id, 'second');
    await assert.rejects(resolveWorkspaceMember(context, 'wsp_ok', { ...child.member_reference!, analysis_id: 'first', generation: secondGeneration }, ['comprehension']), (error: unknown) => error instanceof WorkspaceMemberResolutionError && error.code === 'generation_mismatch');
  });
});
