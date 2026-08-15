import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChangeSet, IncrementalState } from '../../types/cas.types';
import { buildChangeExecutionLocality } from './incremental-locality';

function state(files: string[]): IncrementalState {
  return {
    version: '1',
    projectPath: '/workspace',
    lastAnalysisTimestamp: 1,
    lastFullAnalysis: 1,
    files: Object.fromEntries(files.map(file => [file, {
      contentHash: file,
      mtimeMs: 1,
      nodeIds: [],
      edgeIds: [],
      entryPointIds: [],
      exitPointIds: [],
      imports: [],
      exports: []
    }])),
    analyzerVersions: {},
    analyzerRegistryFingerprint: 'registry'
  } as IncrementalState;
}

function changes(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    added: [],
    modified: [],
    deleted: [],
    affectedFiles: [],
    requiresFullRebuild: false,
    ...overrides
  };
}

test('reports exact file reuse for a localized incremental change', () => {
  const locality = buildChangeExecutionLocality({
    strategy: 'localized-file-merge',
    state: state(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']),
    changeSet: changes({ modified: ['src/a.ts'], affectedFiles: ['src/b.ts'] }),
    fileResults: new Map([['src/a.ts', {} as never], ['src/b.ts', {} as never]])
  });

  assert.deepEqual(locality, {
    strategy: 'localized-file-merge',
    directChangedFiles: 1,
    graphAffectedFiles: 1,
    analyzedFiles: 2,
    trackedFiles: 4,
    reusedFiles: 2,
    reuseRatio: 0.5,
    affectedPackageRoots: undefined,
    affectedDeployableRoots: undefined,
    refreshedProjectAnalyzers: undefined,
    fullRebuildReason: undefined
  });
});

test('reports zero reuse for a full rebuild', () => {
  const locality = buildChangeExecutionLocality({
    strategy: 'full-rebuild',
    state: state(['src/a.ts', 'src/b.ts']),
    changeSet: changes({ modified: ['src/a.ts'] }),
    fileResults: new Map(),
    fullRebuildReason: 'Analyzer registry changed'
  });

  assert.equal(locality.trackedFiles, 2);
  assert.equal(locality.reusedFiles, 0);
  assert.equal(locality.reuseRatio, 0);
  assert.equal(locality.fullRebuildReason, 'Analyzer registry changed');
});

test('identifies package and deployable boundaries from canonical CAS evidence', () => {
  const locality = buildChangeExecutionLocality({
    strategy: 'derived-layer-rebuild',
    state: state(['packages/core/src/index.ts', 'services/api/src/server.ts', 'services/api/src/routes.ts']),
    changeSet: changes({
      modified: ['packages/core/src/index.ts', 'services/api/src/server.ts'],
      affectedFiles: ['services/api/src/routes.ts']
    }),
    fileResults: new Map(),
    cas: {
      deployable_evidence: [
        { root_path: 'packages/core', name: 'core', tier: 3, kind: 'package', evidence: ['package manifest'] },
        { root_path: 'services/api', name: 'api', tier: 1, kind: 'container', evidence: ['container manifest'] }
      ]
    }
  });

  assert.deepEqual(locality.affectedPackageRoots, ['packages/core']);
  assert.deepEqual(locality.affectedDeployableRoots, ['services/api']);
});
