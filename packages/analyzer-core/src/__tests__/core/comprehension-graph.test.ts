import { buildComprehensionGraph } from '../../analyzer/core/comprehension-graph';
import type { CASCallChain, CASDataEntity, CASEntryPoint, CASExitPoint, CASNode } from '../../types/cas.types';

describe('canonical comprehension graph', () => {
  it('uses structural lineage while deriving flows and enriches lineage from projected journeys', () => {
    const nodes = [{
      id: 'create-job',
      name: 'createJob',
      qualified_name: 'createJob',
      type: 'function',
      source: { file: 'src/jobs.ts', line: 1, end_line: 3 },
    }] as CASNode[];
    const entryPoints = [{
      id: 'post-job',
      source_node: 'create-job',
      type: 'http',
      name: 'POST /jobs',
      trigger: { method: 'POST', path: '/jobs' },
      handler: { node_id: 'create-job', method_name: 'createJob', file: 'src/jobs.ts', line: 1 },
    }] as CASEntryPoint[];
    const exitPoints = [{
      id: 'job-response',
      source_node: 'create-job',
      type: 'api',
      name: 'created job',
      target: { endpoint: '/jobs' },
      operation: { method: 'POST' },
    }] as CASExitPoint[];
    const callChains = [{
      id: 'create-job-chain',
      chain_type: 'entry-to-exit',
      entry_point: { node_id: 'create-job', method_name: 'createJob', entry_point_id: 'post-job' },
      exit_point: { node_id: 'create-job', method_name: 'createJob', exit_point_id: 'job-response' },
      call_path: [{ call_id: 'create-job-call', node_id: 'create-job', method_name: 'createJob', depth: 0 }],
      characteristics: {
        total_calls: 1,
        max_depth: 0,
        has_external_calls: false,
        has_database_calls: false,
        has_async_calls: false,
        is_circular: false,
        is_recursive: false,
        complexity_score: 1,
      },
      risk_analysis: { risk_level: 'low', risk_factors: [] },
    }] as CASCallChain[];
    const dataEntities = [{
      id: 'entity-job',
      name: 'Job',
      kind: 'persisted-entity',
      fields: [],
      lifecycle: { created_by: ['create-job'], read_by: [], updated_by: [], deleted_by: [] },
    }] as CASDataEntity[];

    const result = buildComprehensionGraph({
      nodes,
      edges: [],
      entryPoints,
      exitPoints,
      callChains,
      dataEntities,
      capabilities: [],
      behaviorSurfaces: [],
      changeRisks: [],
    });

    expect(result.flows).toHaveLength(1);
    expect(result.flows[0].contract.side_effects.state_changes).toContain('Job created');
    expect(result.flows[0].steps.some(step => /create job/i.test(`${step.name} ${step.description}`))).toBe(true);
    expect(result.journeyResult.journeys[0].derived_from_flow_id).toBe(result.flows[0].flow_id);
    expect(result.dataLineage[0].journeys_carrying).toContain(result.journeyResult.journeys[0].id);
  });
});
