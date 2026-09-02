import { buildUserJourneys } from '../../analyzer/core/journey-builder';
import {
  buildTraversalIndex,
  computeFlowConcepts,
  traceForwardChain,
} from '../../analyzer/core/flow-concepts';
import { computeSemanticCoverage } from '../../analyzer/core/semantic-coverage';
import type { CASOutput } from '../../types/cas.types';

function graphCas(nodeCount: number): CASOutput {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `node_${index}`,
    name: `operation_${index}`,
    qualified_name: `operation_${index}`,
    type: index === 0 ? 'controller' : 'function',
    category: index === 0 ? 'entry' : 'business',
  }));
  const edges = Array.from({ length: nodeCount - 1 }, (_, index) => ({
    id: `edge_${index}`,
    source: `node_${index}`,
    target: `node_${index + 1}`,
    type: 'calls',
  }));
  edges.push(
    { id: 'edge_branch', source: 'node_2', target: 'node_50', type: 'calls' },
    { id: 'edge_cycle', source: `node_${nodeCount - 1}`, target: 'node_10', type: 'calls' },
  );
  return {
    cas_version: '3.0.0',
    analysis_id: 'semantic-traversal-completeness',
    analysis_timestamp: '2026-08-30T00:00:00.000Z',
    system: {
      id: 'system',
      name: 'system',
      type: 'application',
      root_path: '.',
      technologies: { languages: [], frameworks: [] },
      quality: {},
    },
    nodes,
    edges,
    entry_points: [{
      id: 'entry',
      source_node: 'node_0',
      type: 'http',
      name: 'GET /operations',
      handler: { node_id: 'node_0', method_name: 'operation_0' },
    }],
    exit_points: [{
      id: 'exit',
      source_node: `node_${nodeCount - 1}`,
      type: 'api',
      name: 'deliver result',
      target: { service_id: 'result-service' },
    }],
    call_chains: [{
      id: 'chain',
      chain_type: 'entry-to-exit',
      entry_point: { node_id: 'node_0', entry_point_id: 'entry', method_name: 'operation_0' },
      exit_point: {
        node_id: `node_${nodeCount - 1}`,
        exit_point_id: 'exit',
        method_name: `operation_${nodeCount - 1}`,
      },
      call_path: nodes.map((node, depth) => ({
        call_id: `call_${depth}`,
        node_id: node.id,
        method_name: node.name,
        depth,
      })),
      characteristics: {
        total_calls: nodeCount,
        max_depth: nodeCount - 1,
        has_external_calls: true,
        has_database_calls: false,
        has_async_calls: false,
        is_circular: true,
        is_recursive: false,
        complexity_score: nodeCount,
      },
    }],
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

describe('semantic traversal completeness', () => {
  test('indexed reachability preserves every node across old depth/function bounds and terminates on cycles', () => {
    const cas = graphCas(70);
    const chain = traceForwardChain(buildTraversalIndex(cas), 'node_0');
    expect(chain).toHaveLength(70);
    expect(new Set(chain.map(item => item.node.id)).size).toBe(70);
    expect(chain.find(item => item.node.id === 'node_69')?.depth).toBe(22);
  });

  test('terminal flows retain the full exact call path even when legacy rendering bounds are supplied', () => {
    const cas = graphCas(70);
    const flows = computeFlowConcepts(cas, { maxDepth: 2, maxFunctionsPerFlow: 3 });
    const terminal = flows.find(flow => flow.terminus?.exit_point_id === 'exit');
    expect(terminal).toBeDefined();
    const functionIds = new Set(terminal!.steps.flatMap(step => step.functions.map(fn => fn.function_id)));
    expect(functionIds.size).toBe(70);
    expect(functionIds.has('node_69')).toBe(true);
    expect(terminal!.gaps || []).not.toEqual(expect.arrayContaining([expect.stringContaining('truncated')]));
  });

  test('coverage denominator includes every reachable executable node beyond the old cap', () => {
    const cas = graphCas(70);
    const coverage = computeSemanticCoverage(cas, []);
    expect(coverage.reachable_code_to_steps).toEqual({ ratio: 0, mapped: 0, total: 70 });
    expect(coverage.unmapped.code_units.length).toBe(50);
    expect(coverage.unmapped.code_units_omitted).toBe(20);
  });

  test('journeys preserve complete cyclic reachability and do not default-truncate discovered entries', () => {
    const cas = graphCas(70);
    const longJourney = buildUserJourneys({
      nodes: cas.nodes,
      edges: cas.edges,
      entryPoints: cas.entry_points || [],
      exitPoints: cas.exit_points || [],
      callChains: cas.call_chains || [],
    });
    expect(longJourney.journeys).toHaveLength(1);
    expect(new Set(longJourney.journeys[0].steps.map(step => step.node_id)).size).toBe(70);

    const manyNodes = Array.from({ length: 55 }, (_, index) => [
      {
        id: `entry_node_${index}`,
        name: `entry_${index}`,
        qualified_name: `entry_${index}`,
        type: 'controller',
      },
      {
        id: `effect_node_${index}`,
        name: `effect_${index}`,
        qualified_name: `effect_${index}`,
        type: 'function',
      },
    ]).flat();
    const result = buildUserJourneys({
      nodes: manyNodes as any,
      edges: Array.from({ length: 55 }, (_, index) => ({
        id: `many_edge_${index}`,
        source: `entry_node_${index}`,
        target: `effect_node_${index}`,
        type: 'calls',
      })),
      entryPoints: Array.from({ length: 55 }, (_, index) => ({
        id: `many_entry_${index}`,
        source_node: `entry_node_${index}`,
        type: 'http',
        name: `GET /items/${index}`,
        handler: { node_id: `entry_node_${index}` },
      })) as any,
      exitPoints: Array.from({ length: 55 }, (_, index) => ({
        id: `many_exit_${index}`,
        source_node: `effect_node_${index}`,
        type: 'api',
        name: `deliver_${index}`,
        target: { service_id: `service_${index}` },
      })) as any,
      callChains: [],
    });
    expect(result.summary).toMatchObject({ total_discovered: 55, included: 55 });
    expect(result.journeys).toHaveLength(55);

    const rendered = buildUserJourneys({
      nodes: manyNodes as any,
      edges: Array.from({ length: 55 }, (_, index) => ({
        id: `render_edge_${index}`,
        source: `entry_node_${index}`,
        target: `effect_node_${index}`,
        type: 'calls',
      })),
      entryPoints: Array.from({ length: 55 }, (_, index) => ({
        id: `render_entry_${index}`,
        source_node: `entry_node_${index}`,
        type: 'http',
        name: `GET /rendered/${index}`,
        handler: { node_id: `entry_node_${index}` },
      })) as any,
      exitPoints: [],
      callChains: [],
    }, { maxJourneys: 5 });
    expect(rendered.summary.total_discovered).toBe(55);
    expect(rendered.summary.included).toBe(5);
  });
});
