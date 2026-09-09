import type { CASOutput, FlowConcept } from '../../types/cas.types';

type Access = { reads: Set<string>; writes: Set<string> };
type EntityAccess = Map<string, Access>;

function mergeAccess(target: EntityAccess, source: EntityAccess): void {
  for (const [entity, access] of source) {
    let merged = target.get(entity);
    if (!merged) {
      merged = { reads: new Set(), writes: new Set() };
      target.set(entity, merged);
    }
    for (const node of access.reads) merged.reads.add(node);
    for (const node of access.writes) merged.writes.add(node);
  }
}

function hasDistinctNodes(writers: Set<string>, readers: Set<string>): boolean {
  if (!writers.size || !readers.size) return false;
  if (writers.size > 1 || readers.size > 1) return true;
  return writers.values().next().value !== readers.values().next().value;
}

export function groundCapabilityFlowRelationships(flows: FlowConcept[], cas: CASOutput): FlowConcept[] {
  const byNode = new Map<string, EntityAccess>();
  const entityNames = new Map<string, string>();
  for (const lineage of cas.data_lineage || []) {
    if (!lineage.entity_id) continue;
    entityNames.set(lineage.entity_id, lineage.entity_name);
    for (const [kind, sites] of [['reads', lineage.readers], ['writes', lineage.writers]] as const) {
      for (const site of sites || []) {
        if (!site.node_id) continue;
        let entities = byNode.get(site.node_id);
        if (!entities) {
          entities = new Map();
          byNode.set(site.node_id, entities);
        }
        let access = entities.get(lineage.entity_id);
        if (!access) {
          access = { reads: new Set(), writes: new Set() };
          entities.set(lineage.entity_id, access);
        }
        access[kind].add(site.node_id);
      }
    }
  }
  const entryNodes = new Map((cas.entry_points || []).map(entry => [entry.id, entry.handler?.node_id || entry.source_node]));
  const accessByFlow = new Map<string, EntityAccess>();
  const accessByCapability = new Map<string, EntityAccess>();
  for (const flow of flows) {
    const access: EntityAccess = new Map();
    const nodes = new Set(flow.steps.flatMap(step => step.functions.map(fn => fn.function_id)));
    const root = entryNodes.get(flow.entry_point);
    if (root) nodes.add(root);
    for (const node of nodes) {
      const nodeAccess = byNode.get(node);
      if (nodeAccess) mergeAccess(access, nodeAccess);
    }
    accessByFlow.set(flow.flow_id, access);
    for (const rel of flow.capability_relationships || []) {
      if (rel.evidence !== 'operation') continue;
      let capabilityAccess = accessByCapability.get(rel.capability_id);
      if (!capabilityAccess) {
        capabilityAccess = new Map();
        accessByCapability.set(rel.capability_id, capabilityAccess);
      }
      mergeAccess(capabilityAccess, access);
    }
  }
  for (const flow of flows) {
    const access = accessByFlow.get(flow.flow_id)!;
    let removed = false;
    const grounded = (flow.capability_relationships || []).flatMap(rel => {
      if (rel.evidence !== 'entity-overlap') return [rel];
      const capabilityAccess = accessByCapability.get(rel.capability_id);
      const dependencies: string[] = [];
      for (const [entity, flowAccess] of access) {
        const operationAccess = capabilityAccess?.get(entity);
        if (!operationAccess) continue;
        const label = entityNames.get(entity) || entity;
        if (hasDistinctNodes(flowAccess.writes, operationAccess.reads)) {
          dependencies.push(`${label} (${entity}): flow writes data read by a cited capability operation`);
        }
        if (hasDistinctNodes(operationAccess.writes, flowAccess.reads)) {
          dependencies.push(`${label} (${entity}): flow reads data written by a cited capability operation`);
        }
      }
      if (dependencies.length) return [{
        ...rel,
        evidence: 'entity-lineage' as const,
        rationale: `${rel.rationale}; static producer-consumer evidence: ${dependencies.sort().join('; ')}; runtime ordering and record identity are not established`,
      }];
      removed = true;
      return [];
    });
    if (!removed && grounded.every((rel, index) => rel === flow.capability_relationships?.[index])) continue;
    flow.capability_relationships = grounded.length ? grounded : undefined;
    if (removed) {
      const gap = 'Shared entities alone do not establish a capability relationship; links without a grounded producer-consumer dependency on a cited operation were omitted. Source entities, steps and effects are retained.';
      if (!flow.gaps?.includes(gap)) flow.gaps = [...(flow.gaps || []), gap];
    }
  }
  return flows;
}
