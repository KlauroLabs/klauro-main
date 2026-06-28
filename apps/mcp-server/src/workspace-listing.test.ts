import test from 'node:test';
import assert from 'node:assert/strict';
import { listWorkspaceAnalysesFiltered, memberRepoNames, normalizeWorkspaceName, type WorkspaceListEntry } from './workspace-listing';

function ws(over: Partial<WorkspaceListEntry>): WorkspaceListEntry {
  return {
    id: over.id || 'id',
    name: over.name || 'soon',
    generated_at: over.generated_at || '2026-01-01T00:00:00.000Z',
    codebase_count: over.codebase_count,
    interface_count: over.interface_count,
    link_count: over.link_count,
    inputs: over.inputs,
    file: over.file || 'ws.json',
  };
}

function inputs(names: string[]) {
  return names.map(n => ({ project_id: n, repo_path: `/dev/${n}` }));
}

test('dedupe_by name (default) collapses re-runs to the richest entry', () => {
  const data = [
    ws({ id: 'r1', name: 'soon', inputs: inputs(['a', 'b']) }),
    ws({ id: 'r2', name: 'soon', inputs: inputs(['a', 'b', 'c', 'd', 'e']) }),
    ws({ id: 'r3', name: 'zerac', inputs: inputs(['x', 'y', 'z']) }),
  ];
  const res = listWorkspaceAnalysesFiltered(data);
  assert.equal(res.matched, 2);
  const soon = (res.workspaces as any[]).find(w => w.name === 'soon');
  assert.equal(soon.repo_count, 5);
});

test('normalizeWorkspaceName strips run-id / variant stamps', () => {
  assert.equal(normalizeWorkspaceName('gauntlet-soon-mqnrvdut-qgek0'), 'soon');
  assert.equal(normalizeWorkspaceName('spot-zerac-ai-quality-1781948679890'), 'zerac');
  assert.equal(normalizeWorkspaceName('soon-workspace'), 'soon');
  assert.equal(normalizeWorkspaceName('zerac-zerac'), 'zerac');
  assert.equal(normalizeWorkspaceName('klauro'), 'klauro');
  // all-letter run-id of the exact 8-5 shape, with trailing qualifier
  assert.equal(normalizeWorkspaceName('gauntlet-zerac-mqnaltbj-nottk-exclude-proof'), 'zerac');
});

test('normalizeWorkspaceName never truncates legitimate multi-word names', () => {
  // English multi-word names must survive — no digit, not the 8-5 stamp shape.
  for (const name of ['soon-finance-context-ts', 'zerac-poc-old', 'zerac-admin-ui', 'zerac-self-hosted-builder', 'zerac-client-ui']) {
    assert.equal(normalizeWorkspaceName(name), name, `truncated ${name}`);
  }
});

test('dedupe collapses run-stamped re-runs of the same workspace', () => {
  const data = [
    ws({ id: 'a', name: 'gauntlet-soon-mqnpqbcb-q6lrs', inputs: inputs(['s1', 's2']) }),
    ws({ id: 'b', name: 'gauntlet-soon-mqnrvdut-qgek0', inputs: inputs(['s1', 's2', 's3']) }),
    ws({ id: 'c', name: 'gauntlet-zerac-mqnr3kes-qpfso', inputs: inputs(['z1', 'z2']) }),
  ];
  const res = listWorkspaceAnalysesFiltered(data);
  assert.equal(res.matched, 2);
  const names = (res.workspaces as any[]).map(w => w.workspace).sort();
  assert.deepEqual(names, ['soon', 'zerac']);
  const soon = (res.workspaces as any[]).find(w => w.workspace === 'soon');
  assert.equal(soon.repo_count, 3); // richest run kept
});

test('dedupe_by none preserves all re-runs', () => {
  const data = [ws({ id: 'r1', name: 'soon', inputs: inputs(['a']) }), ws({ id: 'r2', name: 'soon', inputs: inputs(['a', 'b']) })];
  const res = listWorkspaceAnalysesFiltered(data, { dedupe_by: 'none' });
  assert.equal(res.matched, 2);
});

test('sort repos desc by default', () => {
  const data = [
    ws({ name: 'small', inputs: inputs(['a']) }),
    ws({ name: 'big', inputs: inputs(['a', 'b', 'c', 'd']) }),
    ws({ name: 'mid', inputs: inputs(['a', 'b']) }),
  ];
  const order = (listWorkspaceAnalysesFiltered(data).workspaces as any[]).map(w => w.name);
  assert.deepEqual(order, ['big', 'mid', 'small']);
});

test('min_repos filter', () => {
  const data = [ws({ name: 'a', inputs: inputs(['1', '2']) }), ws({ name: 'b', inputs: inputs(['1', '2', '3', '4']) })];
  const res = listWorkspaceAnalysesFiltered(data, { min_repos: 3 });
  assert.equal(res.matched, 1);
  assert.equal((res.workspaces[0] as any).name, 'b');
});

test('compact caps member names and reports truncation', () => {
  const data = [ws({ name: 'big', inputs: inputs(Array.from({ length: 30 }, (_, i) => `r${i}`)) })];
  const w = listWorkspaceAnalysesFiltered(data, { max_members: 10 }).workspaces[0] as any;
  assert.equal(w.member_repos.length, 10);
  assert.equal(w.member_repos_truncated, 20);
});

test('memberRepoNames derives basenames from repo_path/project_id', () => {
  const e = ws({ inputs: [{ repo_path: '/dev/soon/soon-lens' }, { project_id: 'soon-ui' }] });
  assert.deepEqual(memberRepoNames(e), ['soon-lens', 'soon-ui']);
});

test('pagination is exhaustive and non-overlapping over distinct names', () => {
  const data = Array.from({ length: 120 }, (_, i) => ws({ id: `id-${i}`, name: `wq-${i}`, inputs: inputs(['a']) }));
  const seen = new Set<string>();
  let offset = 0;
  for (let guard = 0; guard < 100; guard++) {
    const res = listWorkspaceAnalysesFiltered(data, { limit: 50, offset });
    for (const w of res.workspaces as any[]) { assert.equal(seen.has(w.name), false); seen.add(w.name); }
    if (!res.has_more) break;
    offset = res.next_offset!;
  }
  assert.equal(seen.size, 120);
});
