import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
  saveIncrementalState,
  loadIncrementalState,
  deleteIncrementalState,
  getProjectStorageDir,
} from './storage';
import type { IncrementalState } from '../../../packages/analyzer-core/src/types/cas.types';

async function withStoragePath<T>(fn: (storagePath: string) => Promise<T>): Promise<T> {
  const previous = process.env.KLAURO_STORAGE_PATH;
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-inc-track-test-'));
  process.env.KLAURO_STORAGE_PATH = storagePath;
  try {
    return await fn(storagePath);
  } finally {
    if (previous === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previous;
    await fs.remove(storagePath);
  }
}

function makeState(projectPath: string, marker: string): IncrementalState {
  return {
    version: '1.0.0',
    projectPath,
    lastFullAnalysis: `full-${marker}`,
    lastAnalysisTimestamp: 1,
    files: {
      [`${marker}.ts`]: {
        filePath: `${marker}.ts`,
        contentHash: `hash-${marker}`,
        mtimeMs: 1,
        lastAnalyzed: '2026-07-01T00:00:00.000Z',
        analyzerId: 'typescript',
        nodeIds: [],
        edgeIds: [],
        entryPointIds: [],
        exitPointIds: [],
        importedFiles: [],
        exportedSymbols: [],
      },
    },
    analyzerVersions: {},
  };
}

async function stateArtifactExists(projectDir: string, baseName: string): Promise<boolean> {
  return (await Promise.all(['', '.zst', '.br'].map(suffix => fs.pathExists(path.join(projectDir, `${baseName}${suffix}`))))).some(Boolean);
}

test('main and in-flight incremental state coexist without overwriting each other', async () => {
  await withStoragePath(async () => {
    const projectPath = '/tmp/klauro-inc-project';
    const mainState = makeState(projectPath, 'main');
    const inflightState = makeState(projectPath, 'inflight');

    await saveIncrementalState(projectPath, mainState); // default track = 'main'
    await saveIncrementalState(projectPath, inflightState, 'in-flight');

    // Both files persisted, neither overwrote the other.
    const projectDir = getProjectStorageDir(projectPath);
    assert.ok(await stateArtifactExists(projectDir, 'incremental-state.json'));
    assert.ok(await stateArtifactExists(projectDir, 'incremental-state.inflight.json'));

    // Each loads back independently with its own contents.
    const loadedMain = await loadIncrementalState(projectPath); // default 'main'
    const loadedInflight = await loadIncrementalState(projectPath, 'in-flight');

    assert.equal(loadedMain?.lastFullAnalysis, 'full-main');
    assert.ok(loadedMain?.files['main.ts']);
    assert.equal(loadedMain?.files['inflight.ts'], undefined);

    assert.equal(loadedInflight?.lastFullAnalysis, 'full-inflight');
    assert.ok(loadedInflight?.files['inflight.ts']);
    assert.equal(loadedInflight?.files['main.ts'], undefined);
  });
});

test('default/main incremental state keeps the legacy basename with transparent compression', async () => {
  await withStoragePath(async () => {
    const projectPath = '/tmp/klauro-inc-project-legacy';
    await saveIncrementalState(projectPath, makeState(projectPath, 'main'));

    const projectDir = getProjectStorageDir(projectPath);
    assert.ok(await stateArtifactExists(projectDir, 'incremental-state.json'));
    assert.ok(!(await stateArtifactExists(projectDir, 'incremental-state.main.json')));

    // Explicit 'main' resolves to the same file as the default.
    const explicit = await loadIncrementalState(projectPath, 'main');
    const defaulted = await loadIncrementalState(projectPath);
    assert.equal(explicit?.lastFullAnalysis, defaulted?.lastFullAnalysis);
  });
});

test('deleteIncrementalState is track-scoped (deleting in-flight leaves main intact)', async () => {
  await withStoragePath(async () => {
    const projectPath = '/tmp/klauro-inc-project-delete';
    await saveIncrementalState(projectPath, makeState(projectPath, 'main'));
    await saveIncrementalState(projectPath, makeState(projectPath, 'inflight'), 'in-flight');

    await deleteIncrementalState(projectPath, 'in-flight');

    assert.equal(await loadIncrementalState(projectPath, 'in-flight'), null);
    assert.ok(await loadIncrementalState(projectPath)); // main untouched
  });
});
