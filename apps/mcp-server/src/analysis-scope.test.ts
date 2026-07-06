import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveAnalysisScope,
  isPathUnderRoot,
  filterEntriesToScope,
  filterWorkspaceGraphsToScope,
  type AnalysisScope,
} from './analysis-scope';

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeKlaurorc(dir: string, config: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.klaurorc'), JSON.stringify(config, null, 2));
}

test('isPathUnderRoot: exact match, nested match, sibling-prefix rejected', () => {
  assert.equal(isPathUnderRoot('/a/b', '/a/b'), true);
  assert.equal(isPathUnderRoot('/a/b/c', '/a/b'), true);
  assert.equal(isPathUnderRoot('/a/bc', '/a/b'), false); // no partial-segment false positive
  assert.equal(isPathUnderRoot('/a/other', '/a/b'), false);
});

test('resolveAnalysisScope: no .klaurorc anywhere up the tree => machine (unscoped)', async () => {
  const root = mkTmpDir('klauro-scope-none-');
  const nested = path.join(root, 'nested', 'deep');
  fs.mkdirSync(nested, { recursive: true });
  const scope = await resolveAnalysisScope({ cwd: nested });
  assert.equal(scope.mode, 'machine');
  assert.equal(scope.workspaceId, undefined);
});

test('resolveAnalysisScope: .klaurorc with no project.workspaceId => machine (unscoped)', async () => {
  const root = mkTmpDir('klauro-scope-nows-');
  writeKlaurorc(root, { version: 1, project: { name: 'solo-repo' } });
  const scope = await resolveAnalysisScope({ cwd: root });
  assert.equal(scope.mode, 'machine');
});

test('resolveAnalysisScope: bound workspaceId => workspace mode, name from nearest .klaurorc', async () => {
  const wsRoot = mkTmpDir('klauro-scope-ws-');
  const memberDir = path.join(wsRoot, 'member-repo');
  writeKlaurorc(wsRoot, { version: 1, kind: 'workspace', project: { name: 'Soon', workspaceId: 'wsp_abc123' } });
  writeKlaurorc(memberDir, { version: 1, kind: 'project', project: { name: 'member-repo', workspaceId: 'wsp_abc123' } });

  const scope = await resolveAnalysisScope({ cwd: memberDir });
  assert.equal(scope.mode, 'workspace');
  assert.equal(scope.workspaceId, 'wsp_abc123');
  assert.ok(scope.reason.length > 0);
});

test('resolveAnalysisScope: scope.mode="machine" in .klaurorc explicitly opts out', async () => {
  const wsRoot = mkTmpDir('klauro-scope-optout-');
  writeKlaurorc(wsRoot, {
    version: 1,
    kind: 'workspace',
    project: { name: 'Soon', workspaceId: 'wsp_abc123' },
    scope: { mode: 'machine' },
  });
  const scope = await resolveAnalysisScope({ cwd: wsRoot });
  assert.equal(scope.mode, 'machine');
  assert.equal(scope.workspaceId, 'wsp_abc123');
});

test('filterEntriesToScope: machine mode is a no-op', async () => {
  const scope: AnalysisScope = { mode: 'machine', reason: 'unscoped' };
  const entries = [{ path: '/dev/soon/a' }, { path: '/dev/zerac/b' }];
  assert.deepEqual(await filterEntriesToScope(entries, scope), entries);
});

/**
 * THE CORE LEAK-PROOF TEST: reproduces the exact real-machine shape that
 * broke path-prefix scoping — a workspace root directory (`soon`) that also
 * contains unrelated sibling folders with NO .klaurorc of their own
 * (an unbound "alphaclaw" repo living next to the real workspace members).
 * Membership must be per-entry (walk up from the entry's OWN path), not
 * "lives under the workspace root directory" — otherwise the unbound sibling
 * leaks straight into the scoped response, which is the bug this module
 * exists to close.
 */
test('filterEntriesToScope: workspace mode keeps only entries whose OWN .klaurorc binds them to the workspace — cross-workspace + unbound-sibling leak proof', async () => {
  const wsRoot = mkTmpDir('klauro-scope-leak-proof-');
  writeKlaurorc(wsRoot, { version: 1, kind: 'workspace', project: { name: 'Soon', workspaceId: 'wsp_soon' } });

  const soonUi = path.join(wsRoot, 'soon-ui');
  const soonLink = path.join(wsRoot, 'soon-link');
  writeKlaurorc(soonUi, { version: 1, kind: 'project', project: { name: 'soon-ui', workspaceId: 'wsp_soon' } });
  writeKlaurorc(soonLink, { version: 1, kind: 'project', project: { name: 'soon-link', workspaceId: 'wsp_soon' } });

  // Unrelated sibling folders that live under the SAME parent directory as
  // the workspace root but were never bound to it (no .klaurorc at all, or a
  // .klaurorc bound to a DIFFERENT workspace).
  const alphaclaw = path.join(wsRoot, 'alphaclaw'); // no .klaurorc — just a folder that happens to be nested here
  fs.mkdirSync(alphaclaw, { recursive: true });

  const zeracDir = mkTmpDir('klauro-scope-zerac-');
  writeKlaurorc(zeracDir, { version: 1, kind: 'workspace', project: { name: 'Zerac', workspaceId: 'wsp_zerac' } });

  const scope = await resolveAnalysisScope({ cwd: soonUi });
  assert.equal(scope.mode, 'workspace');
  assert.equal(scope.workspaceId, 'wsp_soon');

  const entries = [
    { path: soonUi, name: 'soon-ui' },
    { path: soonLink, name: 'soon-link' },
    { path: alphaclaw, name: 'alphaclaw' }, // unbound sibling — MUST be excluded
    { path: zeracDir, name: 'zerac-api' }, // different workspace — MUST be excluded
  ];
  const filtered = await filterEntriesToScope(entries, scope);
  assert.deepEqual(filtered.map(e => e.name).sort(), ['soon-link', 'soon-ui']);

  const serialized = JSON.stringify(filtered);
  for (const leaked of ['alphaclaw', 'zerac-api']) {
    assert.ok(!serialized.includes(leaked), `${leaked} must not appear anywhere in the scoped response`);
  }
});

test('filterWorkspaceGraphsToScope: keeps only graphs with a member repo bound to the scoped workspace, drops unrelated gauntlet artifacts', async () => {
  const wsRoot = mkTmpDir('klauro-scope-graph-ws-');
  writeKlaurorc(wsRoot, { version: 1, kind: 'workspace', project: { name: 'Soon', workspaceId: 'wsp_soon' } });
  const soonUi = path.join(wsRoot, 'soon-ui');
  const soonLink = path.join(wsRoot, 'soon-link');
  writeKlaurorc(soonUi, { version: 1, project: { name: 'soon-ui', workspaceId: 'wsp_soon' } });
  writeKlaurorc(soonLink, { version: 1, project: { name: 'soon-link', workspaceId: 'wsp_soon' } });

  const randomScanRoot = mkTmpDir('klauro-scope-random-scan-'); // no .klaurorc: a gauntlet artifact that scanned an arbitrary folder

  const scope = await resolveAnalysisScope({ cwd: soonUi });
  const graphs = [
    { id: 'soon-live', name: 'soon', inputs: [{ repo_path: soonUi }, { repo_path: soonLink }] },
    { id: 'gauntlet-soon-mqym1l7l-sn011', name: 'gauntlet-soon-mqym1l7l-sn011', inputs: [{ path: randomScanRoot }] },
    { id: 'no-inputs', name: 'no-inputs' },
  ];
  const filtered = await filterWorkspaceGraphsToScope(graphs, scope);
  assert.deepEqual(filtered.map(g => g.id), ['soon-live']);
});

test('filterWorkspaceGraphsToScope: machine mode is a no-op', async () => {
  const scope: AnalysisScope = { mode: 'machine', reason: 'unscoped' };
  const graphs = [{ id: 'a', inputs: [{ path: '/anywhere' }] }];
  assert.deepEqual(await filterWorkspaceGraphsToScope(graphs, scope), graphs);
});
