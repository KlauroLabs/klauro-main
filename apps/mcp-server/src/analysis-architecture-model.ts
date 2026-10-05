import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

export interface Container {
  key: string;
  name: string;
  root: string;
}

export interface Relation {
  from: string;
  to: string;
  label: string;
  modality: string;
}

export interface ArchitectureModel {
  system: string;
  containers: Container[];
  externals: Container[];
  relations: Relation[];
}

const byEndpointsAndLabel = (left: Relation, right: Relation) =>
  `${left.from}\u0001${left.to}\u0001${left.label}`.localeCompare(`${right.from}\u0001${right.to}\u0001${right.label}`);

function containersOf(cas: CASOutput): Container[] {
  const parts = cas.children ?? [];
  const held = parts.length === 0 ? [cas] : parts;
  return held
    .map(part => ({ name: part.system.name, root: relativeRoot(cas, part) }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((part, at) => ({ key: `c${at}`, ...part }));
}

function relativeRoot(whole: CASOutput, part: CASOutput): string {
  const base = whole.system.root_path ?? '';
  const root = part.system.root_path ?? '';
  if (root === base) return '.';
  return root.startsWith(`${base}/`) ? root.slice(base.length + 1) : root;
}

function contractOf(seam: { summary?: string; metadata?: unknown }): string {
  const contract = (seam.metadata as { contract?: string } | undefined)?.contract;
  return contract ?? seam.summary ?? '';
}

export function architectureModelOf(cas: CASOutput): ArchitectureModel {
  const containers = containersOf(cas);
  const named = new Map(containers.map(container => [container.name, container]));
  const externals = new Map<string, Container>();
  const relations = new Map<string, Relation>();
  const keyOf = (name: string): string => {
    const found = named.get(name) ?? externals.get(name);
    if (found) return found.key;
    const external = { key: `e${externals.size}`, name, root: '' };
    externals.set(name, external);
    return external.key;
  };
  for (const seam of cas.communication_seams?.seams ?? []) {
    if (!seam.source || !seam.target || seam.source === seam.target) continue;
    const relation = { from: keyOf(seam.source), to: keyOf(seam.target), label: contractOf(seam), modality: seam.modality };
    relations.set(`${relation.from}\u0001${relation.to}\u0001${relation.label}`, relation);
  }
  return {
    system: cas.system.name,
    containers,
    externals: [...externals.values()],
    relations: [...relations.values()].sort(byEndpointsAndLabel),
  };
}
