import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { listCrossCodebaseSystemGraphs, loadCrossCodebaseSystemGraph, saveCrossCodebaseSystemGraph } from './storage';

async function withStoragePath<T>(fn: (storagePath: string) => Promise<T>): Promise<T> {
  const previous = process.env.KLAURO_STORAGE_PATH;
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-storage-test-'));
  process.env.KLAURO_STORAGE_PATH = storagePath;
  try {
    return await fn(storagePath);
  } finally {
    if (previous === undefined) {
      delete process.env.KLAURO_STORAGE_PATH;
    } else {
      process.env.KLAURO_STORAGE_PATH = previous;
    }
    await fs.remove(storagePath);
  }
}

test('lists workspace analyses from metadata without parsing the full graph file', async () => {
  await withStoragePath(async () => {
    const saved = await saveCrossCodebaseSystemGraph({
      id: 'workspace-large',
      name: 'Workspace Large',
      generated_at: '2026-01-01T00:00:00.000Z',
      codebase_count: 2,
      interfaces: [{ id: 'interface-1' }, { id: 'interface-2' }],
      links: [{ id: 'link-1' }],
      unmatched_interfaces: [{ id: 'unmatched-1' }],
      inputs: [
        { project_id: 'api', repo_path: '/tmp/workspace/api', cas_generated_at: '2026-01-01T00:00:00.000Z' },
        { project_id: 'web', repo_path: '/tmp/workspace/web', cas_generated_at: '2026-01-01T00:00:00.000Z' },
      ],
    } as any);

    await fs.writeFile(saved.file, '{ this is intentionally not json');

    const summaries = await listCrossCodebaseSystemGraphs();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].id, 'workspace-large');
    assert.equal(summaries[0].name, 'Workspace Large');
    assert.equal(summaries[0].codebase_count, 2);
    assert.equal(summaries[0].interface_count, 2);
    assert.equal(summaries[0].link_count, 1);
    assert.equal(summaries[0].unmatched_interface_count, 1);
    assert.deepEqual(summaries[0].inputs?.map(input => input.repo_path), ['/tmp/workspace/api', '/tmp/workspace/web']);
  });
});

test('loading a legacy workspace analysis backfills metadata for future lightweight listing', async () => {
  await withStoragePath(async (storagePath) => {
    const directory = path.join(storagePath, 'workspace-analyses');
    await fs.ensureDir(directory);
    await fs.writeJson(path.join(directory, 'legacy-workspace.json'), {
      id: 'legacy-workspace',
      name: 'Legacy Workspace',
      generated_at: '2026-01-02T00:00:00.000Z',
      saved_at: '2026-01-02T00:00:01.000Z',
      codebase_count: 1,
      interfaces: [{ id: 'interface-1' }],
      links: [],
      unmatched_interfaces: [],
      inputs: [{ project_id: 'service', repo_path: '/tmp/legacy/service' }],
    });

    const beforeLoad = await listCrossCodebaseSystemGraphs();
    assert.equal(beforeLoad[0].id, 'legacy-workspace');
    assert.equal(beforeLoad[0].inputs, undefined);

    const graph = await loadCrossCodebaseSystemGraph('legacy-workspace');
    assert.equal(graph?.name, 'Legacy Workspace');

    const afterLoad = await listCrossCodebaseSystemGraphs();
    assert.deepEqual(afterLoad[0].inputs?.map(input => input.repo_path), ['/tmp/legacy/service']);
  });
});
