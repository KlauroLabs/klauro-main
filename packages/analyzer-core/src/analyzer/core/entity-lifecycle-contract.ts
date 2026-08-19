import type { CASDataEntity, ProvenanceFacet } from '../../types/cas.types';

export interface EntityLifecycleContractEvidence {
  facet: ProvenanceFacet;
  value: string;
  evidence: string;
}

export interface EntityLifecycleContractFacts {
  inputs: string[];
  stateChanges: string[];
  writtenEntityKeys: Set<string>;
  evidence: EntityLifecycleContractEvidence[];
}

export function entityLifecycleContractFacts(
  entities: CASDataEntity[],
  nodeIds: Set<string>,
  normalizeEntityKey: (name: string) => string
): EntityLifecycleContractFacts {
  const inputs: string[] = [];
  const stateChanges: string[] = [];
  const writtenEntityKeys = new Set<string>();
  const evidence: EntityLifecycleContractEvidence[] = [];

  for (const entity of entities) {
    const lifecycle = entity.lifecycle;
    if (!lifecycle) continue;
    const actions = [
      ['created', lifecycle.created_by],
      ['updated', lifecycle.updated_by],
      ['deleted', lifecycle.deleted_by],
    ] as const;
    for (const [action, sources] of actions) {
      if (!sources.some(nodeId => nodeIds.has(nodeId))) continue;
      const value = `${entity.name} ${action}`;
      stateChanges.push(value);
      writtenEntityKeys.add(normalizeEntityKey(entity.name));
      evidence.push({
        facet: 'state_change',
        value,
        evidence: `data entity "${entity.name}" lifecycle.${action}_by includes a node in this unit`,
      });
    }
    if (lifecycle.read_by.some(nodeId => nodeIds.has(nodeId))) {
      const value = `reads ${entity.name}`;
      inputs.push(value);
      evidence.push({
        facet: 'input',
        value,
        evidence: `data entity "${entity.name}" lifecycle.read_by includes a node in this unit`,
      });
    }
  }

  return { inputs, stateChanges, writtenEntityKeys, evidence };
}
