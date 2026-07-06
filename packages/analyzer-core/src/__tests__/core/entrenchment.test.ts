import {
  computeEntrenchment,
  type EntrenchmentResult,
  ENTRENCHMENT_CONTRACT_MODEL,
} from '../../analyzer/core/entrenchment';
import { CONTRACT_MODEL_NAME } from '../../analyzer/core/flow-concepts';
import type {
  CASNode,
  CASEdge,
  CASEntityLineage,
  DeployableEvidence,
} from '../../types/cas.types';
import type { CommunicationSeamsResult } from '../../analyzer/core/communication-seams';

function fn(id: string, file: string, calledBy: string[] = []): CASNode {
  return {
    id,
    name: id,
    type: 'function',
    source: { file, line: 1 },
    call_graph: {
      called_by: calledBy.map((c, i) => ({
        source_id: c,
        source_name: c,
        source_type: 'function',
        location: { file, line: i + 1 },
      })),
    },
  } as CASNode;
}

function callsEdge(source: string, target: string): CASEdge {
  return { id: `e_${source}_${target}`, source, target, type: 'CALLS' } as CASEdge;
}

/** Shared-state fixture: `writer` writes Order (in deployable A), read by a node
 *  in deployable B — a passive cross-component seam. */
function sharedOrderEntity(writerId: string, readerId: string): CASEntityLineage {
  return {
    entity_id: 'entity_order',
    entity_name: 'Order',
    sensitive_fields: [],
    writers: [{ node_id: writerId, file: 'apps/checkout/order.service.ts', via: 'lifecycle:created' }],
    readers: [{ node_id: readerId, file: 'apps/reporting/report.service.ts', via: 'lifecycle:read' }],
    external_recipients: [],
    boundaries_crossed: [],
    journeys_carrying: [],
    exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
  } as CASEntityLineage;
}

function passiveSeams(): CommunicationSeamsResult {
  return {
    seams: [
      {
        id: 'seam_passive_1',
        modality: 'passive',
        confidence: 0.7,
        kind: 'passive_state',
        source: 'apps/checkout',
        target: 'apps/reporting',
        evidence: 'entity:entity_order',
        summary: 'shared state',
        shared_resource: 'Order',
      },
    ],
    inventory: { level: 'node', counts: { sync: 0, async: 0, passive: 1, total: 1 }, component_seams: [] },
  };
}

describe('computeEntrenchment', () => {
  it('scores a hub with many dependents + shared-state high, and a leaf low', () => {
    // hub is called by 8 callers AND writes an entity another deployable reads.
    const callers = Array.from({ length: 8 }, (_, i) => `caller_${i}`);
    const nodes: CASNode[] = [
      fn('hub', 'apps/checkout/order.service.ts', callers),
      ...callers.map(c => fn(c, 'apps/checkout/handlers.ts')),
      fn('reader', 'apps/reporting/report.service.ts'),
      // a genuine leaf: no callers, no shared state, in no flow.
      fn('leaf_util', 'libs/util/format.ts'),
    ];
    const edges: CASEdge[] = callers.map(c => callsEdge(c, 'hub'));

    const deployables: DeployableEvidence[] = [
      { name: 'checkout', kind: 'container', tier: 1, root_path: 'apps/checkout', ports: [], evidence: [] } as unknown as DeployableEvidence,
      { name: 'reporting', kind: 'container', tier: 1, root_path: 'apps/reporting', ports: [], evidence: [] } as unknown as DeployableEvidence,
    ];

    const result: EntrenchmentResult = computeEntrenchment({
      nodes,
      edges,
      data_lineage: [sharedOrderEntity('hub', 'reader')],
      communication_seams: passiveSeams(),
      deployable_evidence: deployables,
    });

    const hub = result.nodes['hub'];
    const leaf = result.nodes['leaf_util'];

    expect(hub).toBeDefined();
    expect(leaf).toBeDefined();

    // Hub is decisively more entrenched than the leaf.
    expect(hub.score).toBeGreaterThan(leaf.score);
    expect(hub.raw.direct_dependents).toBe(8);
    // Shared-state facet fired: a reader in another component reads what hub writes.
    expect(hub.raw.shared_state_readers).toBeGreaterThanOrEqual(1);
    expect(hub.signals.facets.state_changes).toBeGreaterThan(0);
    expect(hub.raw.shared_state_entities).toContain('Order');
    // Level is load-bearing or above.
    expect(['load-bearing', 'foundational', 'bedrock']).toContain(hub.level);
    // Evidence is human-legible and grounded in real facts.
    expect(hub.evidence.some(e => /dependent/.test(e))).toBe(true);
    expect(hub.evidence.some(e => /Order/.test(e))).toBe(true);

    // The leaf is a leaf: no dependents, low score, leaf tier.
    expect(leaf.raw.direct_dependents).toBe(0);
    expect(leaf.raw.shared_state_readers).toBe(0);
    expect(leaf.level).toBe('leaf');
    expect(leaf.evidence).toContain('no dependents — leaf');

    // Repo summary carries the bedrock set with hub in it, and the contract model.
    expect(result.summary.contract_model).toBe(CONTRACT_MODEL_NAME);
    expect(result.summary.bedrock.some(b => b.node_id === 'hub')).toBe(true);
    expect(result.summary.counts.nodes_scored).toBeGreaterThan(0);
  });

  it('reuses the shared ICELOT contract-model constant', () => {
    expect(ENTRENCHMENT_CONTRACT_MODEL).toBe(CONTRACT_MODEL_NAME);
  });

  it('does not crash on an empty repo and returns an empty, well-formed summary', () => {
    const result = computeEntrenchment({ nodes: [] });
    expect(result.nodes).toEqual({});
    expect(result.summary.bedrock).toEqual([]);
    expect(result.summary.repo_score).toBe(0);
    expect(result.summary.repo_level).toBe('leaf');
    expect(result.summary.counts.nodes_scored).toBe(0);
    // Distribution present and all-zero.
    expect(result.summary.distribution.bedrock).toBe(0);
    expect(result.summary.distribution.leaf).toBe(0);
  });

  it('aggregates file and module rollups from node scores', () => {
    const callers = Array.from({ length: 5 }, (_, i) => `c${i}`);
    const nodes: CASNode[] = [
      fn('svc', 'apps/api/user.service.ts', callers),
      ...callers.map(c => fn(c, 'apps/api/user.controller.ts')),
    ];
    const edges = callers.map(c => callsEdge(c, 'svc'));
    const result = computeEntrenchment({ nodes, edges });

    const svcFile = result.summary.files.find(f => f.file === 'apps/api/user.service.ts');
    expect(svcFile).toBeDefined();
    expect(svcFile!.score).toBeGreaterThan(0);
    const apiModule = result.summary.modules.find(m => m.module === 'apps/api');
    expect(apiModule).toBeDefined();
    expect(apiModule!.score).toBeGreaterThan(0);
  });
});
