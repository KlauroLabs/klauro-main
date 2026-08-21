import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeFrameworkAnalyzers } from './framework-analyzer-execution';

test('merges each analyzer result in canonical id order before starting the next analyzer', async () => {
  let active = 0;
  let maximumActive = 0;
  const events: string[] = [];
  const registrations = [
    { id: 'third', name: 'Third' },
    { id: 'first', name: 'First' },
    { id: 'second', name: 'Second' },
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

test('canonical merge order resolves overlapping nodes identically for every registration order', async () => {
  const run = async (registrations: Array<{ id: string; name: string }>) => {
    const mergedNodes = new Map<string, string>();
    await executeFrameworkAnalyzers({
      registrations,
      runAnalyzer: async registration => ({
        nodes: [{ id: 'shared', type: 'file', name: registration.id }],
        edges: [],
      }),
      mergeResult: async (_registration, result) => {
        for (const node of result.nodes || []) mergedNodes.set(node.id, node.name);
      },
      recordFailure: () => undefined,
      yieldAfterAnalyzer: async () => undefined,
    });
    return [...mergedNodes];
  };
  const registrations = [
    { id: 'second-alphabetically', name: 'Second alphabetically' },
    { id: 'first-alphabetically', name: 'First alphabetically' },
  ];

  assert.deepEqual(await run(registrations), [['shared', 'second-alphabetically']]);
  assert.deepEqual(await run([...registrations].reverse()), [['shared', 'second-alphabetically']]);
});
