import type { FlowConcept, FlowEffect } from '../../types/cas.types';

function effectKey(effect: FlowEffect): string {
  return `${effect.exit_point_id} ${effect.kind} ${effect.produces} ${effect.node_id}`;
}

function groupKey(flow: FlowConcept): string {
  return flow.entry_point || flow.flow_id;
}

function isMoreComplete(candidate: FlowConcept, incumbent: FlowConcept): boolean {
  const candidateSteps = candidate.steps?.length || 0;
  const incumbentSteps = incumbent.steps?.length || 0;
  if (candidateSteps !== incumbentSteps) return candidateSteps > incumbentSteps;
  const candidateEntities = candidate.entities?.length || 0;
  const incumbentEntities = incumbent.entities?.length || 0;
  if (candidateEntities !== incumbentEntities) return candidateEntities > incumbentEntities;
  return candidate.flow_id.localeCompare(incumbent.flow_id) < 0;
}

function unique(values: readonly string[] | undefined): string[] {
  return values && values.length > 0 ? [...new Set(values)].sort() : [];
}

export function mergeFlowsByEntryPoint(flows: readonly FlowConcept[]): FlowConcept[] {
  if (flows.length < 2) return [...flows];

  const order: string[] = [];
  const groups = new Map<string, FlowConcept[]>();
  for (const flow of flows) {
    const key = groupKey(flow);
    const existing = groups.get(key);
    if (existing) existing.push(flow);
    else {
      groups.set(key, [flow]);
      order.push(key);
    }
  }

  const merged: FlowConcept[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }

    let representative = group[0];
    for (const candidate of group) {
      if (isMoreComplete(candidate, representative)) representative = candidate;
    }

    const effects: FlowEffect[] = [];
    const seenEffects = new Set<string>();
    for (const flow of group) {
      for (const effect of flow.effects || (flow.terminus ? [flow.terminus] : [])) {
        const key2 = effectKey(effect);
        if (seenEffects.has(key2)) continue;
        seenEffects.add(key2);
        effects.push(effect);
      }
    }
    effects.sort((left, right) => effectKey(left).localeCompare(effectKey(right)));

    merged.push({
      ...representative,
      entities: unique(group.flatMap(flow => flow.entities || [])),
      effects: effects.length > 0 ? effects : undefined,
      triggers: (() => {
        const values = unique(group.flatMap(flow => flow.triggers || []));
        return values.length > 0 ? values : undefined;
      })(),
      gaps: (() => {
        const values = unique(group.flatMap(flow => flow.gaps || []));
        return values.length > 0 ? values : undefined;
      })()
    });
  }
  return merged;
}
