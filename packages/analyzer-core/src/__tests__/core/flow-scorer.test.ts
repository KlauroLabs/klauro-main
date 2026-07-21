/**
 * FlowScorer — importance-driven capability ranking regression tests.
 *
 * The former implementation ranked with three hardcoded keyword sets and a
 * centrality_score wired to 0, which is why UI click-handler chains surfaced
 * as core flows. These tests pin the structural fix:
 * - a click-handler chain with NO downstream structural-importance mass must
 *   rank below a deep pipeline flow,
 * - ranking must be evidence-driven, not name-driven (an "important-sounding"
 *   name with no mass loses to a bland name with mass),
 * - deterministic ordering, and a working fallback when no importance map
 *   exists (pre-layer CAS outputs).
 */

import { FlowScorer } from '../../analyzer/core/flow-scorer';
import { CASCapability, CASDomainConcept } from '../../types/cas.types';

function capability(input: {
  id: string;
  name: string;
  implementingNodes: string[];
  operationPattern?: 'action' | 'read';
  operationPatterns?: CASCapability['operation_patterns'];
  avgDepth?: number;
}): CASCapability {
  return {
    id: input.id,
    name: input.name,
    description: '',
    entry_points: [`ep-${input.id}`],
    entry_point_summary: { types: ['http'], count: 1, primary_type: 'http' },
    operations: [{
      id: `op-${input.id}`,
      name: `op-${input.id}`,
      pattern: input.operationPattern || 'action',
      call_chain_ids: [],
      implementing_nodes: input.implementingNodes,
    }],
    operation_patterns: input.operationPatterns || [],
    services_used: [],
    exit_points: [],
    call_chain_ids: [],
    complexity_profile: {
      avg_depth: input.avgDepth ?? 3,
      max_depth: input.avgDepth ?? 3,
      has_external_calls: false,
      has_database_calls: false,
      has_async_calls: false,
      branching_factor: 2,
    },
    classification: 'supporting',
    criticality: 'medium',
    signals: {
      domain_concept_score: 0,
      centrality_score: 0,
      coverage_score: 0,
      complexity_score: 0,
      total_score: 0,
    },
    depends_on: [],
    depended_by: [],
  } as CASCapability;
}

const noConcepts: CASDomainConcept[] = [];

describe('FlowScorer (structural-importance-driven ranking)', () => {
  test('click-handler chain with no downstream mass ranks below a deep pipeline flow', () => {
    // Importance map shaped like the real layer produces it: the pipeline
    // chain accumulates walk mass, the UI event handler is a dead end.
    const importance = new Map<string, number>([
      ['pipeline-entry', 1],
      ['pipeline-transform', 0.85],
      ['pipeline-persist', 0.72],
      ['click-handler', 0.01],
    ]);

    const pipeline = capability({
      id: 'cap-pipeline',
      name: 'Report Generation',
      implementingNodes: ['pipeline-entry', 'pipeline-transform', 'pipeline-persist'],
      operationPatterns: ['pipeline'],
      avgDepth: 5,
    });
    const click = capability({
      id: 'cap-click',
      name: 'Row Click',
      implementingNodes: ['click-handler'],
      avgDepth: 1,
    });

    const scorer = new FlowScorer();
    scorer.scoreCapabilities([click, pipeline], noConcepts, undefined, importance);

    expect(pipeline.signals.centrality_score).toBe(100);
    expect(click.signals.centrality_score).toBeLessThanOrEqual(1);
    expect(pipeline.signals.total_score).toBeGreaterThan(click.signals.total_score);

    const top = scorer.getTopCapabilities([click, pipeline], 1);
    expect(top[0].id).toBe('cap-pipeline');
  });

  test('ranking is evidence-driven, not name-driven', () => {
    // The keyword era would have boosted "Analyze Process Execute" and
    // penalized "Health Status" by name alone. With the keyword sets ripped,
    // only structural mass decides.
    const importance = new Map<string, number>([
      ['bland-core-a', 0.95],
      ['bland-core-b', 0.9],
      ['important-sounding-leaf', 0.02],
    ]);

    const importantSoundingButHollow = capability({
      id: 'cap-hollow',
      name: 'Analyze Process Execute',
      implementingNodes: ['important-sounding-leaf'],
    });
    const blandButCentral = capability({
      id: 'cap-central',
      name: 'Health Status',
      implementingNodes: ['bland-core-a', 'bland-core-b'],
    });

    const scorer = new FlowScorer();
    scorer.scoreCapabilities([importantSoundingButHollow, blandButCentral], noConcepts, undefined, importance);

    expect(blandButCentral.signals.total_score).toBeGreaterThan(importantSoundingButHollow.signals.total_score);
  });

  test('deterministic: identical inputs yield identical scores and classifications', () => {
    const importance = new Map<string, number>([['n1', 0.8], ['n2', 0.4]]);
    const build = () => [
      capability({ id: 'cap-a', name: 'Alpha', implementingNodes: ['n1'] }),
      capability({ id: 'cap-b', name: 'Beta', implementingNodes: ['n2'] }),
    ];
    const scorer = new FlowScorer();

    const first = build();
    const second = build();
    scorer.scoreCapabilities(first, noConcepts, undefined, importance);
    scorer.scoreCapabilities(second, noConcepts, undefined, importance);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test('core domain-concept alignment still contributes (repo-derived, not hardcoded)', () => {
    const importance = new Map<string, number>([['n1', 0.5], ['n2', 0.5]]);
    const concepts: CASDomainConcept[] = [
      { name: 'invoice', classification: 'core' } as CASDomainConcept,
    ];
    const aligned = capability({ id: 'cap-inv', name: 'Invoice Delivery', implementingNodes: ['n1'] });
    const unaligned = capability({ id: 'cap-misc', name: 'Widget Painting', implementingNodes: ['n2'] });

    new FlowScorer().scoreCapabilities([aligned, unaligned], concepts, undefined, importance);

    expect(aligned.signals.domain_concept_score).toBeGreaterThan(unaligned.signals.domain_concept_score);
  });

  test('fallback without an importance map: dependency topology drives centrality, never all-zero', () => {
    const heavilyDepended = capability({ id: 'cap-hub', name: 'Hub', implementingNodes: ['h'] });
    heavilyDepended.depended_by = ['cap-a', 'cap-b', 'cap-c'];
    const leaf = capability({ id: 'cap-leaf', name: 'Leaf', implementingNodes: ['l'] });

    new FlowScorer().scoreCapabilities([heavilyDepended, leaf], noConcepts, undefined, undefined);

    expect(heavilyDepended.signals.centrality_score).toBeGreaterThan(leaf.signals.centrality_score);
    expect(heavilyDepended.signals.centrality_score).toBeGreaterThan(0);
  });
});
