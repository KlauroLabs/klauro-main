import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeLanguageAnalyzers, type AnalysisAccumulators } from './language-analyzer-execution';

function accumulators(): AnalysisAccumulators<Record<string, never>> {
  return {
    allNodes: [],
    allEdges: [],
    allEntryPoints: [],
    allExitPoints: [],
    allBehaviors: [],
    allPatterns: [],
    allTags: [],
    allPerspectives: [],
    allLibraries: [],
    categories: {},
    contributions: [],
    analysisErrors: [],
    mergeIndexes: {},
  };
}

test('isolated analyzers overlap, merge in registration order, and precede dependent analyzers', async () => {
  let isolatedStarted = 0;
  let releaseIsolated: () => void = () => undefined;
  const isolatedGate = new Promise<void>(resolve => {
    releaseIsolated = resolve;
  });
  const seenByDependent: string[] = [];
  const registrations = [
    { id: 'first', name: 'First', consumesExistingAnalysis: false },
    { id: 'second', name: 'Second', consumesExistingAnalysis: false },
    { id: 'dependent', name: 'Dependent' },
  ];
  const target = accumulators();

  await Promise.race([
    executeLanguageAnalyzers({
      registrations,
      context: {},
      projectPath: process.cwd(),
      accumulators: target,
      createMergeIndexes: () => ({}),
      runAnalyzer: async (registration, _context, _projectPath, output) => {
        if (registration.consumesExistingAnalysis === false) {
          isolatedStarted++;
          if (isolatedStarted === 2) releaseIsolated();
          await isolatedGate;
        } else {
          seenByDependent.push(...output.allNodes.map(node => node.id));
        }
        output.allNodes.push({ id: `node-${registration.id}`, name: registration.name, type: 'function' } as any);
        output.contributions.push({ analyzer_id: registration.id });
      },
      mergeContribution: async (output, contribution) => {
        output.allNodes.push(...(contribution.nodes || []));
      },
      mergeCategories: (output, source) => Object.assign(output, source),
      logTiming: () => undefined,
      yieldAfterAnalyzer: async () => undefined,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('isolated analyzers did not overlap')), 1_000)),
  ]);

  assert.equal(isolatedStarted, 2);
  assert.deepEqual(target.allNodes.map(node => node.id), ['node-first', 'node-second', 'node-dependent']);
  assert.deepEqual(seenByDependent, ['node-first', 'node-second']);
  assert.deepEqual(target.contributions.map(item => item.analyzer_id), ['first', 'second', 'dependent']);
});
