import { groundCapabilityFlowRelationships } from '../../analyzer/core/capability-flow-evidence';
import type { CASOutput } from '../../types/cas.types';
import type { FlowConcept, CapabilityFlowRelationship } from '../../analyzer/core/flow-concepts';

// Minimal flow shells: the prune only reads flow_id / capability_relationships
// / gaps, so everything else stays out of the fixture.
const flow = (id: string, rels?: CapabilityFlowRelationship[]): FlowConcept => ({
  flow_id: id,
  name: id,
  intent: 'x',
  entry_point: `ep_${id}`,
  entities: [],
  contract: { input: [], output: [], side_effects: { state_changes: [], external_integrations: [] }, constraints: [] },
  steps: [],
  capability_relationships: rels,
} as unknown as FlowConcept);

const overlap = (capId: string): CapabilityFlowRelationship => ({
  capability_id: capId,
  role: 'supporting',
  rationale: 'flow touches entities in this capability\'s related_entities (Analysis)',
  evidence: 'entity-overlap',
});

const anchored = (capId: string): CapabilityFlowRelationship => ({
  capability_id: capId,
  role: 'primary',
  rationale: 'capability operation "list" (entry_point_id=ep_x) references this flow\'s entry point',
  evidence: 'operation',
});

describe('capability-flow evidence grounding', () => {
  it('prunes entity-overlap edges of a capability that overlaps every flow, keeping anchor edges', () => {
    // 20 flows, all linked to cap_blanket via entity overlap; one also has a
    // real operation anchor to cap_real.
    const flows = Array.from({ length: 20 }, (_, i) =>
      flow(`f${i}`, i === 0 ? [overlap('cap_blanket'), anchored('cap_real')] : [overlap('cap_blanket')]));

    groundCapabilityFlowRelationships(flows, { data_lineage: [], entry_points: [] } as unknown as CASOutput);

    for (const f of flows) {
      const capIds = (f.capability_relationships || []).map(r => r.capability_id);
      expect(capIds).not.toContain('cap_blanket');
    }
    expect(flows[0].capability_relationships).toHaveLength(1);
    expect(flows[0].capability_relationships![0].capability_id).toBe('cap_real');
    // Flows stripped to zero relationships record the prune honestly.
    expect(flows[1].capability_relationships).toBeUndefined();
    expect(flows[1].gaps?.some(g => g.includes('Shared entities'))).toBe(true);
  });

  it('never prunes anchor-based blanket coverage (operation edges are real evidence)', () => {
    const flows = Array.from({ length: 20 }, (_, i) => flow(`f${i}`, [anchored('cap_hub')]));
    groundCapabilityFlowRelationships(flows, { data_lineage: [], entry_points: [] } as unknown as CASOutput);
    for (const f of flows) {
      expect(f.capability_relationships).toHaveLength(1);
    }
  });

  it('rejects unsupported entity overlap even below the old blanket fraction', () => {
    const flows = Array.from({ length: 20 }, (_, i) =>
      flow(`f${i}`, i < 5 ? [overlap('cap_partial')] : undefined));
    groundCapabilityFlowRelationships(flows, { data_lineage: [], entry_points: [] } as unknown as CASOutput);
    expect(flows[0].capability_relationships).toBeUndefined();
  });

  it('rejects unsupported entity overlap regardless of flow-set size', () => {
    const flows = Array.from({ length: 6 }, (_, i) => flow(`f${i}`, [overlap('cap_small')]));
    groundCapabilityFlowRelationships(flows, { data_lineage: [], entry_points: [] } as unknown as CASOutput);
    for (const f of flows) {
      expect(f.capability_relationships).toBeUndefined();
    }
  });

  it('prunes untagged legacy edges never (evidence field absent means no prune)', () => {
    const legacy: CapabilityFlowRelationship = { capability_id: 'cap_legacy', role: 'supporting', rationale: 'legacy' };
    const flows = Array.from({ length: 20 }, (_, i) => flow(`f${i}`, [legacy]));
    groundCapabilityFlowRelationships(flows, { data_lineage: [], entry_points: [] } as unknown as CASOutput);
    for (const f of flows) {
      expect(f.capability_relationships).toHaveLength(1);
    }
  });
});

describe('directed lineage evidence', () => {
  function linkedFlows(writer = 'writer', reader = 'reader') {
    const operation = flow('operation', [anchored('cap')]);
    operation.steps = [{ functions: [{ function_id: reader }] }] as any;
    const dependent = flow('dependent', [overlap('cap')]);
    dependent.steps = [{ functions: [{ function_id: writer }] }] as any;
    return [operation, dependent];
  }
  function lineage(writer = 'writer', reader = 'reader'): CASOutput {
    return { entry_points: [], data_lineage: [{
      entity_id: 'entity_order', entity_name: 'Order',
      writers: [{ node_id: writer }], readers: [{ node_id: reader }],
    }] } as unknown as CASOutput;
  }

  test('retains a static producer-consumer dependency with explicit uncertainty', () => {
    const flows = linkedFlows();
    groundCapabilityFlowRelationships(flows, lineage());
    expect(flows[1].capability_relationships![0].evidence).toBe('entity-lineage');
    expect(flows[1].capability_relationships![0].rationale).toContain('flow writes data read by a cited capability operation');
    expect(flows[1].capability_relationships![0].rationale).toContain('runtime ordering and record identity are not established');
    const first = JSON.stringify(flows);
    groundCapabilityFlowRelationships(flows, lineage());
    expect(JSON.stringify(flows)).toBe(first);
  });

  test('a shared read/write helper does not establish a dependency on itself', () => {
    const flows = linkedFlows('shared', 'shared');
    groundCapabilityFlowRelationships(flows, lineage('shared', 'shared'));
    expect(flows[1].capability_relationships).toBeUndefined();
    expect(flows[0].capability_relationships![0].evidence).toBe('operation');
  });

  test('identically named entities with different canonical identities are not joined', () => {
    const flows = linkedFlows();
    const cas = lineage();
    cas.data_lineage![0].readers = [];
    cas.data_lineage!.push({
      ...cas.data_lineage![0], entity_id: 'other_app_order',
      writers: [], readers: [{ node_id: 'reader' }] as any,
    });
    groundCapabilityFlowRelationships(flows, cas);
    expect(flows[1].capability_relationships).toBeUndefined();
  });
});
