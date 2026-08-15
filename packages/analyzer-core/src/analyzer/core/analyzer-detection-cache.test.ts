import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAnalyzerDetectionEvidence,
  invalidateAnalyzerDetectionEvidence,
  refreshAnalyzerDetectionEvidence,
  setAnalyzerDetectionEvidence,
} from './analyzer-detection-cache';

test('shares analyzer detection evidence only for the same live registry', () => {
  const projectPath = `/project-${Date.now()}`;
  setAnalyzerDetectionEvidence(projectPath, {
    registryFingerprint: 'registry-a',
    analyzerIds: ['typescript'],
    projectRoots: [projectPath],
    manifestOwningProjectRoots: [projectPath],
    analyzerRootEntries: [['typescript', projectPath]],
    expiresAt: Date.now() + 1_000,
  });

  assert.deepEqual(getAnalyzerDetectionEvidence(projectPath, 'registry-a')?.analyzerIds, ['typescript']);
  assert.equal(getAnalyzerDetectionEvidence(projectPath, 'registry-b'), undefined);
  invalidateAnalyzerDetectionEvidence(projectPath);
  assert.equal(getAnalyzerDetectionEvidence(projectPath, 'registry-a'), undefined);
});

test('refreshes completed long-running detection evidence without reviving another registry', () => {
  const projectPath = `/project-${Date.now()}-refresh`;
  setAnalyzerDetectionEvidence(projectPath, {
    registryFingerprint: 'registry-a',
    analyzerIds: ['typescript'],
    projectRoots: [],
    manifestOwningProjectRoots: [],
    analyzerRootEntries: [],
    expiresAt: 0,
  });

  refreshAnalyzerDetectionEvidence(projectPath, 'registry-b', Date.now() + 1_000);
  assert.equal(getAnalyzerDetectionEvidence(projectPath, 'registry-a'), undefined);
  refreshAnalyzerDetectionEvidence(projectPath, 'registry-a', Date.now() + 1_000);
  assert.deepEqual(getAnalyzerDetectionEvidence(projectPath, 'registry-a')?.analyzerIds, ['typescript']);
  invalidateAnalyzerDetectionEvidence(projectPath);
});
