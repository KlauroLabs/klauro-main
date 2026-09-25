import type {
  CASArchitecturalPatternSummary,
  CASParadigmConformance,
  CASPrincipleViolation,
} from '../../types/cas.types';
import type { TierStackIndex } from './read-tier-stack';

type Found = NonNullable<NonNullable<TierStackIndex['patterns']>['found']>[number];

const CATEGORY_OF: Record<string, CASArchitecturalPatternSummary['category']> = {
  architecture: 'application-architecture',
  data: 'data-access',
  messaging: 'integration',
  interface: 'integration',
  resilience: 'integration',
  workflow: 'integration',
  domain: 'business-logic',
  design: 'object-lifecycle',
  boundary: 'presentation',
};

const PRINCIPLE_OF: Record<string, CASPrincipleViolation['principle']> = {
  'god class': 'single-responsibility',
  'long method': 'single-responsibility',
  'long parameter list': 'coupling',
  'service locator': 'coupling',
  'circular dependency': 'coupling',
};

const WELL_EVIDENCED = 3;

const DEPARTURES_SHOWN = 12;

function fileOf(id: string): string {
  const at = id.search(/:(function|type|callback|field|method|class):/);
  return at > 0 ? id.slice(0, at) : id.split(':')[0];
}

function nodeIdOf(example: string): string {
  return example.split(' (')[0].trim();
}

export function projectsOfFound(found: Found, index: TierStackIndex): Set<string> {
  const projects = new Set(found.projects ?? []);
  const projectOfNode = new Map(index.nodes.map(node => [node.id, node.project]));
  const projectsOfPackage = new Map((index.dependencies?.dependencies ?? []).map(held => [held.name, held.projects ?? []]));
  for (const example of found.examples ?? []) {
    const id = nodeIdOf(example);
    const owner = projectOfNode.get(id);
    if (owner) projects.add(owner);
    for (const held of projectsOfPackage.get(example) ?? []) projects.add(held);
  }
  return projects;
}

export function patternsOf(index: TierStackIndex): CASArchitecturalPatternSummary[] {
  return (index.patterns?.found ?? []).map(found => ({
    name: found.pattern,
    category: CATEGORY_OF[found.family] ?? 'application-architecture',
    confidence: found.count >= WELL_EVIDENCED ? 0.9 : 0.6,
    evidence: [`${found.evidence} (${found.count})`, ...(found.examples ?? []).filter(Boolean)],
    node_ids: (found.examples ?? []).map(nodeIdOf).filter(id => id.includes(':')),
    guidance: found.evidence,
  }));
}

export function conformanceOf(index: TierStackIndex, project?: string): CASParadigmConformance[] {
  const departed = (departing: string[] | undefined, detail: string) =>
    (departing ?? []).slice(0, DEPARTURES_SHOWN).map(id => ({
      file: fileOf(id),
      node_id: id,
      kind: 'convention-departure' as const,
      detail,
      severity: 'info' as const,
    }));
  const adoption = (following: number, population: number, departing?: string[]) => ({
    following_count: following,
    comparable_count: population,
    adoption_rate: population === 0 ? 0 : Math.round((following / population) * 100) / 100,
    evidence_files: [...new Set((departing ?? []).map(fileOf))].slice(0, DEPARTURES_SHOWN),
  });
  const paradigms = (index.patterns?.conformance ?? [])
    .filter(held => project === undefined || held.project === project)
    .map(held => ({
      paradigm: held.paradigm,
      description: `${held.following} of ${held.population} follow it`,
      adoption: adoption(held.following, held.population, held.departing),
      deviations: departed(held.departing, `departs from: ${held.paradigm}`),
    }));
  if (project !== undefined) return paradigms;
  const conventions = (index.conformance?.conventions ?? []).map(held => ({
    paradigm: held.convention,
    description: held.shape,
    adoption: adoption(held.following, held.population, held.departing),
    deviations: departed(held.departing, `departs from the ${held.convention} convention (${held.shape})`),
  }));
  const principles = (index.principles?.solid ?? [])
    .filter(held => (held.departing ?? []).length > 0)
    .map(held => ({
      paradigm: held.principle,
      description: held.reads_as,
      adoption: adoption(held.following, held.population, held.departing),
      deviations: departed(held.departing, `departs from ${held.principle}: ${held.reads_as}`),
    }));
  return [...paradigms, ...conventions, ...principles];
}

export function violationsOf(index: TierStackIndex, owned?: (nodeId: string) => boolean): CASPrincipleViolation[] {
  return (index.principles?.anti_patterns ?? []).flatMap(held =>
    (held.examples ?? [])
      .map(example => ({ example, id: nodeIdOf(example) }))
      .filter(({ id }) => owned === undefined || owned(id))
      .map(({ example, id }) => ({
        id: `${held.anti_pattern}:${id}`,
        principle: PRINCIPLE_OF[held.anti_pattern] ?? 'coupling',
        file: fileOf(id),
        node_id: id,
        detail: `${held.anti_pattern} — ${held.reads_as}${example.includes(' (') ? ` ${example.slice(example.indexOf(' ('))}` : ''}`,
        severity: 'warning' as const,
      })),
  );
}
