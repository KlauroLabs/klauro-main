import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

export interface Container {
  key: string;
  name: string;
  root: string;
  owner?: string;
  system?: string;
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

const DECLARED_DEPENDENCY = 'declared';
const DECLARED_DEPENDENCY_LABEL = 'depends on';
const REFERENCE_SEPARATOR = /[/:]/;

interface Part {
  container: Omit<Container, 'key'>;
  dependsOn: string[];
}

function partsOf(cas: CASOutput): Part[] {
  const parts = cas.children ?? [];
  const held = parts.length === 0 ? [cas] : parts;
  return held
    .map(part => {
      const catalog = part.system.catalog;
      return {
        container: {
          name: part.system.name,
          root: relativeRoot(cas, part),
          ...(catalog?.owner === undefined ? {} : { owner: catalog.owner }),
          ...(catalog?.system === undefined ? {} : { system: catalog.system }),
        },
        dependsOn: catalog?.depends_on ?? [],
      };
    })
    .sort((left, right) => left.container.name.localeCompare(right.container.name));
}

function referencedName(reference: string): string {
  return reference.split(REFERENCE_SEPARATOR).pop() ?? reference;
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
  const parts = partsOf(cas);
  const containers = parts.map((part, at) => ({ key: `c${at}`, ...part.container }));
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
  const seamed = new Set([...relations.values()].map(relation => `${relation.from}\u0001${relation.to}`));
  parts.forEach((part, at) => {
    for (const reference of part.dependsOn) {
      const target = named.has(referencedName(reference)) ? referencedName(reference) : reference;
      const relation = { from: containers[at].key, to: keyOf(target), label: DECLARED_DEPENDENCY_LABEL, modality: DECLARED_DEPENDENCY };
      if (relation.from === relation.to || seamed.has(`${relation.from}\u0001${relation.to}`)) continue;
      relations.set(`${relation.from}\u0001${relation.to}\u0001${relation.label}`, relation);
    }
  });
  return {
    system: cas.system.name,
    containers,
    externals: [...externals.values()],
    relations: [...relations.values()].sort(byEndpointsAndLabel),
  };
}
