import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { DockerfileAnalyzer } from './container-topology-analyzer';
import { collectDeployableEvidence } from '../core/deployable-evidence';

// A deployable's NAME is the most visible field in the whole payload — it is how
// a customer recognises their own service. Measured live 2026-08-10 (v1.0.143):
// a 92,582-node repo's primary ship unit, holding 92,575 of those nodes, was
// published as "unnamed-service" while the repo's own Dockerfile CMD named the
// app.
//
// Root cause was two functions disagreeing about what an id looks like:
// inferServiceName tested the NARROW hash/UUID shape and so ACCEPTED the
// production snapshot dir `prj_<id>` as a legitimate name, while
// safeDeployableName downstream rejected it with the BROAD test and substituted
// the placeholder — so the real evidence was never consulted.
//
// These cases pin the RANK ORDER (author's declaration > real directory >
// storage folder > honest placeholder) rather than any one repo, which is the
// only way this generalises: every case below is a shape, not a subject.
async function nameFor(files: Record<string, string>, root: string): Promise<string[]> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-naming-'));
  const projectPath = path.join(base, root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(projectPath, relative);
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, content, 'utf8');
  }
  const analyzer = new DockerfileAnalyzer();
  const contribution: any = await (analyzer as any).analyze({ projectPath });
  const nodes = contribution.nodes || [];
  const evidence: any[] = collectDeployableEvidence({
    cas: { nodes } as any,
    projectPath,
    nodes,
    exitPoints: [],
    displayName: 'Some Product',
  } as any) as any;
  await fs.remove(base);
  return evidence.map(item => item.name);
}

test('a declared run command names the ship unit even when the folder is a storage id', async () => {
  const names = await nameFor(
    { Dockerfile: 'FROM node:22\nCMD ["node", "gwapp.mjs", "gateway"]\n' },
    'prj_AbC123XyZ890',
  );
  assert.deepEqual(names, ['gwapp'], 'CMD names the app, so the storage id must never surface');
  assert.ok(!names.includes('unnamed-service'), 'evidence existed — a placeholder here is the live defect');
});

test('a task runner declares a SCRIPT, not a binary, so the real directory still wins', async () => {
  // `npm start` used to yield the ship-unit name "start" once the command was
  // ranked first — junk, and worse than the directory it displaced.
  const names = await nameFor({ Dockerfile: 'FROM node:22\nCMD ["npm", "start"]\n' }, 'real-repo');
  assert.deepEqual(names, ['real-repo']);
});

test('a named subdirectory outranks a storage-id project folder', async () => {
  const names = await nameFor(
    { 'services/api/Dockerfile': 'FROM node:22\nCMD ["npm", "start"]\n' },
    'prj_ZZZ999',
  );
  assert.deepEqual(names, ['api']);
});

test('a storage-id folder never leaks into a deployable name', async () => {
  // No declaration, no named directory: the honest placeholder is correct here —
  // what must never happen is publishing the id itself.
  const names = await nameFor({ Dockerfile: 'FROM scratch\n' }, 'prj_Nothing123');
  for (const name of names) {
    assert.ok(!/^prj_/i.test(name), `storage id leaked as a deployable name: ${name}`);
  }
});
