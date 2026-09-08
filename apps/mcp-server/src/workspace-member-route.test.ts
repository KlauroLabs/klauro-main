import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { AccountHttpError, type AccountStore } from './account-store';
import { compactWorkspaceMemberCas, loadWorkspaceMemberProjection } from './account-workspace-analysis';
import { clearLoadedAnalysisCache, saveAnalysis } from './storage';
import { workspaceMemberReference } from './workspace-member-reference';
import { resolveWorkspaceMemberResponse, workspaceMemberPath } from './workspace-member-route';

function cas(id: string, parentId: string | null = null): CASOutput {
  return {
    id, parent_id: parentId, label: id, cas_version: '3.0.0',
    analysis_id: 'analysis-one', analysis_timestamp: '2026-09-08T00:00:00.000Z',
    system: { id: 'system', name: 'member', type: 'application', root_path: '/source' },
    nodes: [{ id: 'fn:' + id, name: 'run', type: 'function' }],
    edges: [], analyzer_contributions: [], progressive_levels: { total_levels: 0 },
    layers_ready: { complete: true, generated_at: '2026-09-08T00:00:00.000Z', layers: [
      { layer: 'L1', name: 'graph', status: 'ready', fields: ['nodes', 'edges'] },
    ] },
  };
}

async function withMember(
  run: (input: { dataDir: string; graph: CASOutput; owner: CASOutput; accounts: AccountStore; memberPath: string }) => Promise<void>,
  idless = false,
): Promise<void> {
  const previous = process.env.KLAURO_STORAGE_PATH;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-member-route-'));
  process.env.KLAURO_STORAGE_PATH = path.join(dataDir, 'storage');
  clearLoadedAnalysisCache();
  try {
    const memberPath = workspaceMemberPath(dataDir, 'project-analysis');
    await fs.ensureDir(memberPath);
    const member = cas('cas:custom-root');
    if (idless) delete member.id;
    else {
      member.children = [cas('cas:child', member.id!)];
      member.children[0].analysis_id = 'analysis-child';
      member.composition_mode = 'composed';
    }
    await saveAnalysis(memberPath, member, 'main', { canonicalSegmented: true });
    const projected = await loadWorkspaceMemberProjection(memberPath, 'project-one');
    assert(projected);
    const owner = workspaceMemberReference({ path: memberPath, name: 'Member', cas: compactWorkspaceMemberCas(projected) }, 'member');
    owner.parent_id = 'workspace-root';
    const graph: CASOutput = { ...cas('workspace-root'), composition_mode: 'composed', children: [owner] };
    const accounts = {
      listProjectsForWorkspace: async (workspaceId: string) => workspaceId === 'workspace-ok'
        ? [{ id: 'project-one', analysis_id: 'project-analysis' }] : [],
    } as unknown as AccountStore;
    await run({ dataDir, graph, owner, accounts, memberPath });
  } finally {
    clearLoadedAnalysisCache();
    if (previous === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previous;
    await fs.remove(dataDir);
  }
}

test('workspace route resolves the pinned member and discovers nested IDs in its composed namespace', async () => {
  await withMember(async ({ dataDir, graph, owner, accounts, memberPath }) => {
    const newer = cas('cas:new-root');
    newer.analysis_id = 'analysis-newer';
    newer.analysis_timestamp = '2026-09-08T01:00:00.000Z';
    await saveAnalysis(memberPath, newer, 'main', { canonicalSegmented: true });
    clearLoadedAnalysisCache();
    const response = await resolveWorkspaceMemberResponse(accounts, dataDir, 'workspace-ok', graph, owner.id!, new URLSearchParams('sections=identity'));
    const body = response.body as { member: Partial<CASOutput>; identity: { root_id: string; nodes: Array<{ id: string; child_ids: string[] }> } };
    assert.equal(response.statusCode, 200);
    assert.equal(body.member.id, owner.id);
    assert.equal(body.member.parent_id, graph.id);
    assert.equal(body.member.analysis_id, 'analysis-one');
    assert.equal(Object.hasOwn(body.member, 'nodes'), false);
    assert.equal(body.identity.root_id, owner.id);
    assert.deepEqual(body.identity.nodes[0].child_ids, [owner.id + ':cas:child']);
    const childResponse = await resolveWorkspaceMemberResponse(accounts, dataDir, 'workspace-ok', graph, body.identity.nodes[0].child_ids[0], new URLSearchParams('sections=graph'));
    const child = (childResponse.body as { member: Partial<CASOutput> }).member;
    assert.equal(child.id, owner.id + ':cas:child');
    assert.equal(child.parent_id, owner.id);
    assert.equal(child.analysis_id, 'analysis-child');
    assert.equal(child.nodes?.[0].id, 'fn:cas:child');
  });
});

test('workspace route preserves authorization and missing-generation/CAS HTTP errors', async () => {
  await withMember(async ({ dataDir, graph, owner, accounts }) => {
    const request = (workspace: string, id: string) => resolveWorkspaceMemberResponse(accounts, dataDir, workspace, graph, id, new URLSearchParams('sections=facts'));
    const status = (expected: number) => (error: unknown) => error instanceof AccountHttpError && error.statusCode === expected;
    await assert.rejects(request('workspace-other', owner.id!), status(403));
    await assert.rejects(request('workspace-ok', owner.id! + ':cas:missing'), status(404));
    await assert.rejects(request('workspace-ok', 'missing-owner'), status(404));
    await assert.rejects(request('workspace-ok', owner.id! + ':'), status(404));
    owner.member_reference = { ...owner.member_reference!, generation: 'gen-' + 'f'.repeat(64) };
    await assert.rejects(request('workspace-ok', owner.id!), status(409));
  });
});

test('workspace route supports legacy id-less members using the saved analysis identity convention', async () => {
  await withMember(async ({ dataDir, graph, owner, accounts }) => {
    const response = await resolveWorkspaceMemberResponse(accounts, dataDir, 'workspace-ok', graph, owner.id!, new URLSearchParams('sections=identity'));
    const member = (response.body as { member: Partial<CASOutput> }).member;
    assert.equal(member.id, owner.id);
    assert.equal(member.analysis_id, 'analysis-one');
  }, true);
});
