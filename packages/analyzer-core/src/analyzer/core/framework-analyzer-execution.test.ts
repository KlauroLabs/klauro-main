import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeFrameworkAnalyzers } from './framework-analyzer-execution';

test('merges each analyzer result before starting the next analyzer', async () => {
    let active = 0;
    let maximumActive = 0;
    const events: string[] = [];
    const registrations = [
      { id: 'first', name: 'First' },
      { id: 'second', name: 'Second' },
      { id: 'third', name: 'Third' },
    ];

    await executeFrameworkAnalyzers({
      registrations,
      runAnalyzer: async registration => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        events.push(`run:${registration.id}`);
        await Promise.resolve();
        active--;
        return { nodes: [], edges: [] };
      },
      mergeResult: async registration => {
        events.push(`merge:${registration.id}`);
      },
      recordFailure: () => undefined,
      yieldAfterAnalyzer: async () => undefined,
    });

    assert.equal(maximumActive, 1);
    assert.deepEqual(events, [
      'run:first', 'merge:first',
      'run:second', 'merge:second',
      'run:third', 'merge:third',
    ]);
});

test('continues after analyzer failures without suppressing merge failures', async () => {
    const failures: string[] = [];
    const merged: string[] = [];
    const registrations = [
      { id: 'failed', name: 'Failed' },
      { id: 'healthy', name: 'Healthy' },
    ];

    await executeFrameworkAnalyzers({
      registrations,
      runAnalyzer: async registration => {
        if (registration.id === 'failed') throw new Error('analysis failed');
        return { nodes: [], edges: [] };
      },
      mergeResult: async registration => {
        merged.push(registration.id);
      },
      recordFailure: registration => failures.push(registration.id),
      yieldAfterAnalyzer: async () => undefined,
    });

    assert.deepEqual(failures, ['failed']);
    assert.deepEqual(merged, ['healthy']);

    await assert.rejects(
      executeFrameworkAnalyzers({
        registrations: [{ id: 'merge-failure', name: 'Merge failure' }],
        runAnalyzer: async () => ({ nodes: [], edges: [] }),
        mergeResult: async () => { throw new Error('merge failed'); },
        recordFailure: () => undefined,
        yieldAfterAnalyzer: async () => undefined,
      }),
      /merge failed/,
    );
});

test('preserves registration order for analyzers that share the language snapshot', async () => {
  const sharedNodes: string[] = [];
  const mergedNodes: string[] = [];
  const registrations = [
    { id: 'second-alphabetically', name: 'Second alphabetically' },
    { id: 'first-alphabetically', name: 'First alphabetically' },
  ];

  await executeFrameworkAnalyzers({
    registrations,
    runAnalyzer: async registration => {
      sharedNodes.push(registration.id);
      return {
        nodes: sharedNodes.map(id => ({ id, type: 'file', name: id })),
        edges: [],
      };
    },
    mergeResult: async (_registration, result) => {
      mergedNodes.splice(0, mergedNodes.length, ...(result.nodes || []).map(node => node.id));
    },
    recordFailure: () => undefined,
    yieldAfterAnalyzer: async () => undefined,
  });

  assert.deepEqual(sharedNodes, ['second-alphabetically', 'first-alphabetically']);
  assert.deepEqual(mergedNodes, ['second-alphabetically', 'first-alphabetically']);
});
