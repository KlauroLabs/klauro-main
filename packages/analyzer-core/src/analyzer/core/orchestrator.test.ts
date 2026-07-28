import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyzerOrchestrator } from './orchestrator';
import { CASAnalysisError, CASContribution } from '../../types/cas.types';

function emptyTarget() {
  return {
    allNodes: [] as any[],
    allEdges: [] as any[],
    allEntryPoints: [] as any[],
    allExitPoints: [] as any[],
  };
}

function contributions(): CASContribution[] {
  return [
    {
      nodes: [{ id: 'node-a', name: 'first', type: 'function', metadata: { first: true } } as any],
      edges: [{ id: 'edge-a', source: 'node-a', target: 'node-a', type: 'calls' } as any],
      entry_points: [{
        id: 'entry-coarse',
        name: 'run_tool',
        type: 'message',
        source_node: 'node-a',
        handler: { node_id: 'node-a', method_name: 'run_tool', file: 'server.ts' },
      } as any],
      exit_points: [{ id: 'exit-a', name: 'API', type: 'api', source_node: 'node-a' } as any],
      analyzer_metadata: { analyzer_id: 'first', analyzer_name: 'first', contribution_type: 'language' },
    },
    {
      nodes: [
        { id: 'node-a', name: 'second', type: 'method', description: 'richer', metadata: { second: true } } as any,
        { id: 'node-b', name: 'new', type: 'function' } as any,
      ],
      edges: [
        { id: 'edge-a', source: 'node-a', target: 'node-a', type: 'calls' } as any,
        { id: 'edge-b', source: 'node-a', target: 'node-b', type: 'calls' } as any,
      ],
      entry_points: [{
        id: 'entry-rich',
        name: 'run_tool',
        type: 'message',
        source_node: 'node-a',
        handler: { node_id: 'node-a', method_name: 'handleRunTool', file: 'server.ts', line: 42 },
        metadata: { registration: 'registerTool' },
      } as any],
      exit_points: [{ id: 'exit-a', name: 'Different API', type: 'api', source_node: 'node-b' } as any],
      analyzer_metadata: { analyzer_id: 'second', analyzer_name: 'second', contribution_type: 'framework' },
    },
    {
      edges: [{ id: 'edge-invalid', source: 'entry-invalid', target: 'node-a', type: 'calls' } as any],
      entry_points: [{ id: 'entry-invalid', name: 'invalid', type: 'not-a-real-type', source_node: 'node-a' } as any],
      analyzer_metadata: { analyzer_id: 'third', analyzer_name: 'third', contribution_type: 'library' },
    },
  ];
}

async function mergeAll(usePersistentIndexes: boolean) {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const target = emptyTarget();
  const analysisErrors: CASAnalysisError[] = [];
  const originalCreateIndexes = orchestrator.createAnalysisMergeIndexes.bind(orchestrator);
  let indexBuilds = 0;
  orchestrator.createAnalysisMergeIndexes = (mergeTarget: ReturnType<typeof emptyTarget>) => {
    indexBuilds++;
    return originalCreateIndexes(mergeTarget);
  };
  const mergeIndexes = usePersistentIndexes
    ? orchestrator.createAnalysisMergeIndexes(target)
    : undefined;

  for (const contribution of contributions()) {
    await orchestrator.mergeAnalysisResult(target, contribution, {
      analyzerId: contribution.analyzer_metadata?.analyzer_id,
      analysisErrors,
      mergeIndexes,
    });
  }

  return { target, analysisErrors, indexBuilds, mergeIndexes };
}

test('persistent merge indexes build once and preserve exact CAS and warning parity', async () => {
  const persistent = await mergeAll(true);
  const fresh = await mergeAll(false);

  assert.equal(persistent.indexBuilds, 1);
  assert.equal(fresh.indexBuilds, contributions().length);
  assert.deepEqual(persistent.target, fresh.target);
  assert.deepEqual(persistent.analysisErrors, fresh.analysisErrors);
  assert.equal(persistent.mergeIndexes.nodesById.size, persistent.target.allNodes.length);
  assert.equal(persistent.mergeIndexes.edgesById.size, persistent.target.allEdges.length);
  assert.equal(persistent.mergeIndexes.entryPointsById.size, persistent.target.allEntryPoints.length);
  assert.equal(persistent.mergeIndexes.exitPointsById.size, persistent.target.allExitPoints.length);
  assert.deepEqual(persistent.target.allEntryPoints.map((entryPoint: any) => entryPoint.id), ['entry-rich']);
  assert.deepEqual(persistent.target.allEdges.map((edge: any) => edge.id), ['edge-a', 'edge-b']);
});
