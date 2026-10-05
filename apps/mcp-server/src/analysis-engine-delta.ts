import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { RenameMatch } from './analysis-rename-match';

type Facets = Record<string, string | number | boolean | string[] | undefined>;

interface Item {
  id: string;
  name: string;
  facets: Facets;
  alias?: string;
}

interface FacetChange {
  facet: string;
  from?: string | number | boolean;
  to?: string | number | boolean;
  added?: string[];
  removed?: string[];
}

export interface SectionDelta {
  added: Array<{ id: string; name: string }>;
  removed: Array<{ id: string; name: string }>;
  renamed: Array<{ from: { id: string; name: string }; to: { id: string; name: string }; basis: string; changes: FacetChange[] }>;
  changed: Array<{ id: string; name: string; changes: FacetChange[] }>;
  unchanged: number;
}

function diffFacets(from: Facets, to: Facets): FacetChange[] {
  const changes: FacetChange[] = [];
  for (const facet of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const left = from[facet];
    const right = to[facet];
    if (Array.isArray(left) || Array.isArray(right)) {
      const before = new Set(Array.isArray(left) ? left : []);
      const after = new Set(Array.isArray(right) ? right : []);
      const added = [...after].filter(held => !before.has(held)).sort();
      const removed = [...before].filter(held => !after.has(held)).sort();
      if (added.length > 0 || removed.length > 0) changes.push({ facet, added, removed });
    } else if (left !== right) {
      changes.push({ facet, from: left, to: right });
    }
  }
  return changes;
}

function sectionDelta(before: Item[], after: Item[], carry: (id: string) => string): SectionDelta {
  const result: SectionDelta = { added: [], removed: [], renamed: [], changed: [], unchanged: 0 };
  const byId = new Map(after.map(item => [item.id, item]));
  const pairedAfter = new Set<string>();
  const leftover: Item[] = [];
  for (const item of before) {
    const held = byId.get(item.id) ?? byId.get(carry(item.id));
    if (held === undefined) {
      leftover.push(item);
      continue;
    }
    pairedAfter.add(held.id);
    const changes = diffFacets(item.facets, held.facets);
    if (changes.length > 0) result.changed.push({ id: held.id, name: held.name, changes });
    else result.unchanged++;
  }
  const arrived = after.filter(item => !pairedAfter.has(item.id));
  const aliasOf = (items: Item[]) => {
    const grouped = new Map<string, Item[]>();
    for (const item of items) {
      if (item.alias === undefined || item.alias === '') continue;
      grouped.set(item.alias, [...(grouped.get(item.alias) ?? []), item]);
    }
    return grouped;
  };
  const gone = aliasOf(leftover);
  const came = aliasOf(arrived);
  const matched = new Set<string>();
  for (const [alias, left] of gone) {
    const right = came.get(alias);
    if (right === undefined || left.length !== 1 || right.length !== 1) continue;
    matched.add(left[0].id);
    matched.add(right[0].id);
    result.renamed.push({
      from: { id: left[0].id, name: left[0].name },
      to: { id: right[0].id, name: right[0].name },
      basis: 'same identifying facts, unique on both sides',
      changes: diffFacets(left[0].facets, right[0].facets),
    });
  }
  result.removed = leftover.filter(item => !matched.has(item.id)).map(item => ({ id: item.id, name: item.name }));
  result.added = arrived.filter(item => !matched.has(item.id)).map(item => ({ id: item.id, name: item.name }));
  return result;
}

function handlers(cas: CASOutput): Map<string, string> {
  return new Map((cas.entry_points ?? []).map(point => [point.id, point.source_node]));
}

function sortedUnique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((held): held is string => held !== undefined && held !== ''))].sort();
}

function operationKey(cas: CASOutput, flowEntry: string): string | undefined {
  const entry = (cas.entry_points ?? []).find(point => point.id === flowEntry);
  return entry === undefined ? undefined : `${entry.trigger?.method ?? ''} ${entry.trigger?.path ?? entry.name}`.trim();
}

function capabilityItems(cas: CASOutput, carry: (id: string) => string): Item[] {
  return (cas.capabilities ?? []).map(capability => {
    const operations = sortedUnique((capability.operations ?? []).map(held =>
      `${held.trigger?.method ?? ''} ${held.path_or_command ?? held.action}`.trim()));
    return {
      id: capability.id,
      name: capability.name,
      alias: operations.length === 0 ? undefined : operations.join('|'),
      facets: {
        category: capability.category,
        criticality: capability.criticality,
        operations,
        entities: sortedUnique(capability.related_entities ?? []).map(carry),
      },
    };
  });
}

function flowItems(cas: CASOutput, carry: (id: string) => string): Item[] {
  const held = handlers(cas);
  return (cas.flows ?? []).map(flow => ({
    id: flow.flow_id,
    name: flow.name,
    alias: operationKey(cas, flow.entry_point),
    facets: {
      standing: flow.standing,
      open: flow.open,
      cut: flow.cut,
      entry: carry(held.get(flow.entry_point) ?? flow.entry_point),
      entities: sortedUnique(flow.entities),
      steps: flow.steps.map(step => step.name),
    },
  }));
}

function stepItems(cas: CASOutput, carry: (id: string) => string, flowKey: (flowId: string) => string, matched: Set<string>): Item[] {
  return (cas.flows ?? []).filter(flow => matched.has(flowKey(flow.flow_id))).flatMap(flow => flow.steps.map((step, at) => {
    const key = `${flowKey(flow.flow_id)}#${step.name}#${at}`;
    return {
      id: key,
      name: `${flow.name} / ${step.name}`,
      facets: {
        functions: sortedUnique(step.functions.map(held => carry(held.function_id))),
        entities: sortedUnique(step.entities),
      },
    };
  }));
}

function entityItems(cas: CASOutput): Item[] {
  return (cas.entities ?? []).map(entity => ({
    id: entity.id,
    name: entity.name,
    facets: {
      fields: sortedUnique((entity.fields ?? []).map(field => `${field.name}:${field.type}`)),
      relations: sortedUnique((entity.relations ?? []).map(relation => `${relation.field ?? ''}->${relation.target_name}`)),
      written_by: sortedUnique(entity.lifecycle?.created_by ?? []),
      read_by: sortedUnique(entity.lifecycle?.read_by ?? []),
    },
  }));
}

function seamItems(cas: CASOutput): Item[] {
  return (cas.communication_seams?.seams ?? []).map(seam => {
    const contract = String((seam.metadata as { contract?: string } | undefined)?.contract ?? '');
    const key = `${seam.kind}:${seam.source ?? ''}->${seam.target ?? ''}:${contract}`;
    return { id: key, name: seam.summary ?? key, facets: { modality: seam.modality } };
  });
}

function subProjectItems(cas: CASOutput): Item[] {
  const held: Item[] = [];
  const walk = (parts: CASOutput[] | undefined) => {
    for (const part of parts ?? []) {
      held.push({
        id: part.id ?? part.system.name,
        name: part.system.name,
        alias: part.system.root_path,
        facets: {
          nodes: part.nodes.length,
          entry_points: (part.entry_points ?? []).length,
          capabilities: (part.capabilities ?? []).length,
          flows: (part.flows ?? []).length,
        },
      });
      walk(part.children);
    }
  };
  walk(cas.children);
  return held;
}

export interface EngineDelta {
  revisions: { baseline: Revision; proposed: Revision };
  capabilities: SectionDelta;
  flows: SectionDelta;
  steps: SectionDelta;
  entities: SectionDelta;
  seams: SectionDelta;
  sub_projects: SectionDelta;
}

interface Revision {
  analysis_id: string;
  analysis_timestamp?: string;
  label?: string;
}

function revisionOf(cas: CASOutput, label?: string): Revision {
  return {
    analysis_id: cas.analysis_id,
    ...(cas.analysis_timestamp === undefined ? {} : { analysis_timestamp: cas.analysis_timestamp }),
    ...(label === undefined ? {} : { label }),
  };
}

export function engineDeltaBetween(
  baseline: CASOutput,
  proposed: CASOutput,
  renames: RenameMatch,
  labels: { baseline?: string; proposed?: string } = {},
): EngineDelta {
  const carry = (id: string) => renames.idMap.get(id) ?? id;
  const keep = (id: string) => id;
  const flows = sectionDelta(flowItems(baseline, carry), flowItems(proposed, keep), id => id);
  const flowKeyOf = new Map<string, string>();
  for (const pair of flows.renamed) flowKeyOf.set(pair.from.id, pair.to.id);
  const proposedFlows = new Set((proposed.flows ?? []).map(flow => flow.flow_id));
  const matched = new Set((baseline.flows ?? []).map(flow => flowKeyOf.get(flow.flow_id) ?? flow.flow_id).filter(id => proposedFlows.has(id)));
  return {
    revisions: { baseline: revisionOf(baseline, labels.baseline), proposed: revisionOf(proposed, labels.proposed) },
    capabilities: sectionDelta(capabilityItems(baseline, carry), capabilityItems(proposed, keep), id => id),
    flows,
    steps: sectionDelta(
      stepItems(baseline, carry, id => flowKeyOf.get(id) ?? id, matched),
      stepItems(proposed, keep, id => id, matched),
      id => id,
    ),
    entities: sectionDelta(entityItems(baseline), entityItems(proposed), id => id),
    seams: sectionDelta(seamItems(baseline), seamItems(proposed), id => id),
    sub_projects: sectionDelta(subProjectItems(baseline), subProjectItems(proposed), id => id),
  };
}
