import { pruneBlanketCapabilityRelationships } from '../../analyzer/core/flow-concepts';
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

describe('pruneBlanketCapabilityRelationships (v1.0.126 blanket related_flows defect)', () => {
  it('prunes entity-overlap edges of a capability that overlaps every flow, keeping anchor edges', () => {
    // 20 flows, all linked to cap_blanket via entity overlap; one also has a
    // real operation anchor to cap_real.
    const flows = Array.from({ length: 20 }, (_, i) =>
      flow(`f${i}`, i === 0 ? [overlap('cap_blanket'), anchored('cap_real')] : [overlap('cap_blanket')]));

    pruneBlanketCapabilityRelationships(flows);

    for (const f of flows) {
      const capIds = (f.capability_relationships || []).map(r => r.capability_id);
      expect(capIds).not.toContain('cap_blanket');
    }
    expect(flows[0].capability_relationships).toHaveLength(1);
    expect(flows[0].capability_relationships![0].capability_id).toBe('cap_real');
    // Flows stripped to zero relationships record the prune honestly.
    expect(flows[1].capability_relationships).toBeUndefined();
    expect(flows[1].gaps?.some(g => g.includes('blanket'))).toBe(true);
  });

  it('never prunes anchor-based blanket coverage (operation edges are real evidence)', () => {
    const flows = Array.from({ length: 20 }, (_, i) => flow(`f${i}`, [anchored('cap_hub')]));
    pruneBlanketCapabilityRelationships(flows);
    for (const f of flows) {
      expect(f.capability_relationships).toHaveLength(1);
    }
  });

  it('keeps discriminative entity-overlap edges (below the blanket fraction)', () => {
    const flows = Array.from({ length: 20 }, (_, i) =>
      flow(`f${i}`, i < 5 ? [overlap('cap_partial')] : undefined));
    pruneBlanketCapabilityRelationships(flows);
    expect(flows[0].capability_relationships).toHaveLength(1);
  });

  it('does nothing on small flow sets where blanket cannot be distinguished from centrality', () => {
    const flows = Array.from({ length: 6 }, (_, i) => flow(`f${i}`, [overlap('cap_small')]));
    pruneBlanketCapabilityRelationships(flows);
    for (const f of flows) {
      expect(f.capability_relationships).toHaveLength(1);
    }
  });

  it('prunes untagged legacy edges never (evidence field absent means no prune)', () => {
    const legacy: CapabilityFlowRelationship = { capability_id: 'cap_legacy', role: 'supporting', rationale: 'legacy' };
    const flows = Array.from({ length: 20 }, (_, i) => flow(`f${i}`, [legacy]));
    pruneBlanketCapabilityRelationships(flows);
    for (const f of flows) {
      expect(f.capability_relationships).toHaveLength(1);
    }
  });
});
