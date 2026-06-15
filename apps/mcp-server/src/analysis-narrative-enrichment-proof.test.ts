import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { runAnalysisNarrativeEnrichmentProof } from './analysis-narrative-enrichment-proof';
import { saveAnalysis } from './storage';

test('narrative enrichment proof queues weak descriptions while preserving zero-cost agent-fast evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-narrative-proof-'));
  const storage = path.join(root, 'storage');
  const coldReviewPath = path.join(root, 'cold-review.json');
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = storage;

  try {
    const reviews: any[] = [];
    for (let index = 0; index < 10; index += 1) {
      const repoPath = path.join(root, `repo-${index}`);
      await fs.ensureDir(repoPath);
      await saveAnalysis(repoPath, weakNarrativeCas(repoPath, index));
      reviews.push({
        repo: `repo-${index}`,
        path: repoPath,
        category: 'test-fixture',
        narrative_score: 72,
        concerns: ['narrative debt: deterministic capability description'],
      });
    }
    const noTargetRepoPath = path.join(root, 'repo-no-targets');
    await fs.ensureDir(noTargetRepoPath);
    await saveAnalysis(noTargetRepoPath, noTargetNarrativeCas(noTargetRepoPath));
    reviews.push({
      repo: 'repo-no-targets',
      path: noTargetRepoPath,
      category: 'test-fixture',
      narrative_score: 72,
      concerns: ['narrative debt: deterministic system description'],
    });

    await fs.writeJson(coldReviewPath, {
      summary: {
        sample_count: reviews.length,
        narrative_debt_count: reviews.length,
      },
      reviews,
    });

    const report = await runAnalysisNarrativeEnrichmentProof({ coldReviewPath });

    assert.equal(report.status, 'warn');
    assert.equal(report.score, 100);
    assert.equal(report.summary.agent_fast_optional_work_units, 0);
    assert.equal(report.summary.ui_overview_optional_work_units, 135);
    assert.equal(report.summary.queued_repos, 10);
    assert.equal(report.summary.no_target_count, 1);
    assert.equal(report.summary.missing_analysis_count, 0);
    assert.ok(report.summary.total_enrichment_targets >= 10);
    assert.ok(report.gates.every(gate => gate.status === 'pass'));
  } finally {
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    await fs.remove(root);
  }
});

function weakNarrativeCas(repoPath: string, index: number): CASOutput {
  return {
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: `analysis-narrative-proof-${index}`,
    system: {
      id: `system-${index}`,
      name: `repo-${index}`,
      type: 'service',
      root_path: repoPath,
      description: 'A service built with TypeScript. Key capabilities: task management.',
    },
    enhanced_system_purpose: {
      primary_type: 'backend-service',
      confidence: 0.8,
      evidence: [],
      primary_domain: 'task-management',
      core_concepts: ['task'],
      inferred_description: 'A service built with TypeScript. Key capabilities: task management.',
      supporting_workflow_ids: [],
      description_source: 'deterministic',
      description_generation: { attempted: false, status: 'ai_unavailable' },
    } as any,
    system_capabilities: [{
      id: `cap-${index}`,
      name: 'Task Management',
      description: 'execute operations for task management',
      description_source: 'deterministic',
      description_generation: { attempted: false, status: 'ai_unavailable' },
      category: 'core',
      criticality: 'high',
      evidence: [],
    } as any],
    nodes: [{
      id: `node-${index}`,
      name: 'TaskService',
      type: 'service',
      source: { file: 'src/task.service.ts', line: 1 },
      description: 'handles task operations',
      description_source: 'deterministic',
      metadata: {},
    } as any],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { levels: {}, level_definitions: [] } as any,
  };
}

function noTargetNarrativeCas(repoPath: string): CASOutput {
  return {
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-narrative-proof-no-targets',
    system: {
      id: 'system-no-targets',
      name: 'repo-no-targets',
      type: 'service',
      root_path: repoPath,
      description: 'This infrastructure project provisions the network and deployment surfaces that application services rely on, keeping environment wiring, service placement, and runtime configuration visible for operators.',
    },
    enhanced_system_purpose: {
      primary_type: 'infrastructure',
      confidence: 0.8,
      evidence: [],
      primary_domain: 'infrastructure',
      core_concepts: [],
      inferred_description: 'This infrastructure project provisions the network and deployment surfaces that application services rely on, keeping environment wiring, service placement, and runtime configuration visible for operators.',
      supporting_workflow_ids: [],
      description_source: 'ai',
      description_generation: { attempted: true, status: 'ai_generated' },
    } as any,
    system_capabilities: [],
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { levels: {}, level_definitions: [] } as any,
  };
}
