import { EMPTY_CATEGORY_COUNTS } from '../core/idiom-detector';
import type {
  CASAnalysisFact,
  CASBehavioralInvariant,
  CASBehavioralInvariantSummary,
  CASCodebaseIdiom,
  CASDataEntity,
  CASEntryPoint,
  CASExitPoint,
  CASIdiomCategory,
  CASIdiomSummary,
  CASIdiomViolation,
  CASNode,
  CASOutput,
  CASParadigmConformance,
} from '../../types/cas.types';
import type { CASCausalJourney } from '../../types/causal-journey.types';

const PRODUCER = 'tier-stack';
const FOUND_BY_ENGINE = 0.85;
const MIN_COMPARABLE = 2;
const BOUNDARY_PARADIGMS = new Set(['requests pass a guard', 'surface-guarding']);
const MAX_KEY_INVARIANTS = 100;

const IDIOM_CATEGORY: Record<string, CASIdiomCategory> = {
  'file-naming': 'naming',
  'exported-documentation': 'naming',
  'test-placement': 'testing',
  'exit-handling': 'error-handling',
  'surface-guarding': 'auth-tenant-scope',
  'requests pass a guard': 'auth-tenant-scope',
  'data kept behind repositories': 'data-access',
};

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function locationOf(nodes: Map<string, CASNode>, nodeId: string): { file?: string; line?: number } {
  const source = nodes.get(nodeId)?.source;
  return { file: source?.file, line: source?.line };
}

export function analysisFactsOf(input: {
  nodes: CASNode[];
  entryPoints: CASEntryPoint[];
  exitPoints: CASExitPoint[];
  capabilities: NonNullable<CASOutput['capabilities']>;
  journeys: CASCausalJourney[];
}): CASAnalysisFact[] {
  const nodes = new Map(input.nodes.map(node => [node.id, node]));
  const facts: CASAnalysisFact[] = [];
  for (const entry of input.entryPoints) {
    facts.push({
      id: `fact_entry_${entry.id}`,
      subject_type: 'entry_point',
      subject_id: entry.id,
      fact_type: 'entry',
      claim: `${entry.name} exposes ${entry.type}`,
      confidence: FOUND_BY_ENGINE,
      produced_by: PRODUCER,
      evidence: [{ kind: 'route', source: entry.id, ...locationOf(nodes, entry.source_node), confidence: FOUND_BY_ENGINE }],
    });
  }
  for (const exit of input.exitPoints) {
    facts.push({
      id: `fact_exit_${exit.id}`,
      subject_type: 'exit_point',
      subject_id: exit.id,
      fact_type: 'exit',
      claim: `${exit.name} is reached through ${exit.type}`,
      confidence: FOUND_BY_ENGINE,
      produced_by: PRODUCER,
      evidence: [{ kind: 'source-location', source: exit.id, ...locationOf(nodes, exit.source_node), confidence: FOUND_BY_ENGINE }],
    });
  }
  for (const capability of input.capabilities) {
    facts.push({
      id: `fact_capability_${capability.id}`,
      subject_type: 'capability',
      subject_id: capability.id,
      fact_type: 'capability',
      claim: capability.description ? `${capability.name}: ${capability.description}` : capability.name,
      confidence: capability.confidence ?? FOUND_BY_ENGINE,
      produced_by: PRODUCER,
      evidence: [{ kind: 'analyzer', source: capability.name, confidence: capability.confidence ?? FOUND_BY_ENGINE }],
    });
  }
  for (const journey of input.journeys) {
    const first = journey.steps[0];
    facts.push({
      id: `fact_journey_${journey.id}`,
      subject_type: 'journey',
      subject_id: journey.id,
      fact_type: 'journey',
      claim: `${journey.label}: ${journey.does}`,
      confidence: FOUND_BY_ENGINE,
      produced_by: PRODUCER,
      evidence: [{ kind: 'graph', source: journey.id, ...(first ? { file: first.file } : {}), confidence: FOUND_BY_ENGINE }],
    });
  }
  return facts;
}

function idiomOf(held: CASParadigmConformance): { idiom: CASCodebaseIdiom; violations: CASIdiomViolation[] } {
  const id = `idiom:${slug(held.paradigm)}`;
  const category = IDIOM_CATEGORY[held.paradigm] ?? 'module-boundary';
  const { following_count: following, comparable_count: population, adoption_rate: rate, evidence_files: files } = held.adoption;
  const violations: CASIdiomViolation[] = held.deviations.map((deviation, at) => ({
    id: `${id}:deviation:${at}`,
    idiom_id: id,
    category,
    severity: 'info',
    file: deviation.file,
    node_id: deviation.node_id,
    description: deviation.detail,
    recommendation: `Follow ${held.paradigm}: ${held.description}`,
  }));
  const idiom: CASCodebaseIdiom = {
    id,
    category,
    name: held.paradigm,
    description: `${held.description}. ${following} of ${population} comparable sites follow it.`,
    confidence: Math.round((rate * Math.min(1, population / 8)) * 100) / 100,
    prevalence: rate,
    evidence: [{
      kind: 'pattern',
      ...(files[0] ? { file: files[0] } : {}),
      claim: `${following} of ${population} comparable sites follow ${held.paradigm}`,
      confidence: rate,
    }],
    positive_examples: [],
    affected_scopes: { files },
    agent_guidance: {
      do: [`Follow ${held.paradigm}: ${held.description}`],
      avoid: held.deviations.slice(0, 3).map(deviation => deviation.detail),
      validation: [`Compare new code against the ${population - following} known departures from ${held.paradigm}`],
    },
    ...(violations.length > 0 ? { deviations: violations } : {}),
    provenance: {
      evidence_files: files.length,
      evidence_nodes: held.deviations.length,
      population,
      matching: following,
      derivation: 'engine conformance measurement over comparable sites',
    },
  };
  return { idiom, violations };
}

export function idiomsOf(conformance: CASParadigmConformance[]): {
  idioms: CASCodebaseIdiom[];
  violations: CASIdiomViolation[];
  summary: CASIdiomSummary;
} {
  const built = conformance
    .filter(held => held.adoption.comparable_count >= MIN_COMPARABLE)
    .map(held => idiomOf(held));
  const idioms = built.map(item => item.idiom);
  const violations = built.flatMap(item => item.violations);
  const byCategory = { ...EMPTY_CATEGORY_COUNTS };
  for (const idiom of idioms) byCategory[idiom.category] += 1;
  const ranked = [...idioms].sort((left, right) => right.confidence - left.confidence || right.prevalence - left.prevalence);
  return {
    idioms,
    violations,
    summary: {
      total: idioms.length,
      high_confidence: idioms.filter(idiom => idiom.confidence >= 0.8).length,
      violations: violations.length,
      by_category: byCategory,
      top_idioms: ranked.slice(0, 8).map(idiom => idiom.id),
      guidance_digest: ranked.slice(0, 8).flatMap(idiom => idiom.agent_guidance.do.slice(0, 1)),
    },
  };
}

function boundaryInvariantOf(held: CASParadigmConformance): CASBehavioralInvariant {
  const { following_count: following, comparable_count: population, evidence_files: files } = held.adoption;
  const unguarded = population - following;
  return {
    id: `invariant:${slug(held.paradigm)}`,
    name: held.paradigm,
    invariant_type: 'auth-boundary',
    description: `${held.description}. ${following} of ${population} request surfaces satisfy it.`,
    scope: { file_paths: files, node_ids: held.deviations.map(deviation => deviation.node_id).filter((id): id is string => Boolean(id)) },
    enforcement: [{
      source: 'security-boundary',
      mechanism: held.paradigm,
      confidence: unguarded === 0 ? 'enforced' : following === 0 ? 'missing' : 'inferred',
    }],
    evidence: files.map(file => ({ source: 'source_file' as const, file })),
    ...(unguarded > 0 ? { gaps: [`${unguarded} of ${population} request surfaces depart from: ${held.paradigm}`] } : {}),
    confidence: population >= 8 ? 'high' : 'medium',
  };
}

function keyInvariantOf(entity: CASDataEntity): CASBehavioralInvariant | undefined {
  const keys = (entity.relations ?? []).filter(relation => relation.evidence_source === 'orm-declaration');
  if (keys.length === 0) return undefined;
  return {
    id: `invariant:keys:${slug(entity.name)}`,
    name: `${entity.name} keeps its references`,
    invariant_type: 'db-constraint',
    description: `${entity.name} declares foreign keys to ${keys.map(key => key.target_name).join(', ')}; rows must reference existing records.`,
    scope: { entity_names: [entity.name, ...keys.map(key => key.target_name)], field_names: keys.map(key => key.field).filter((field): field is string => Boolean(field)) },
    enforcement: keys.map(key => ({
      source: 'database-schema' as const,
      mechanism: key.evidence || `${entity.name}.${key.field} references ${key.target_name}`,
      confidence: 'enforced' as const,
    })),
    evidence: [{ source: 'database_schema', id: entity.id, ...(entity.schema_source ? { file: entity.schema_source } : {}) }],
    related_entities: keys.map(key => key.target_name),
    confidence: 'high',
  };
}

export function invariantsOf(input: {
  conformance: CASParadigmConformance[];
  entities: CASDataEntity[];
}): { invariants: CASBehavioralInvariant[]; summary: CASBehavioralInvariantSummary } {
  const boundaries = input.conformance
    .filter(held => BOUNDARY_PARADIGMS.has(held.paradigm) && held.adoption.comparable_count >= MIN_COMPARABLE)
    .map(boundaryInvariantOf);
  const keys = input.entities
    .map(keyInvariantOf)
    .filter((held): held is CASBehavioralInvariant => held !== undefined)
    .slice(0, MAX_KEY_INVARIANTS);
  const invariants = [...boundaries, ...keys];
  const byType: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  let enforced = 0;
  let inferred = 0;
  let missing = 0;
  for (const invariant of invariants) {
    byType[invariant.invariant_type] = (byType[invariant.invariant_type] ?? 0) + 1;
    byConfidence[invariant.confidence] = (byConfidence[invariant.confidence] ?? 0) + 1;
    const states = invariant.enforcement.map(item => item.confidence);
    if (states.includes('missing')) missing += 1;
    else if (states.includes('inferred')) inferred += 1;
    else enforced += 1;
  }
  const gaps = invariants.flatMap(invariant => (invariant.gaps ?? []).map(gap => ({
    invariant_id: invariant.id,
    gap,
    severity: invariant.enforcement.some(item => item.confidence === 'missing') ? ('high' as const) : ('medium' as const),
  })));
  return {
    invariants,
    summary: {
      total: invariants.length,
      by_type: byType,
      by_confidence: byConfidence,
      by_gap_severity: {
        high: gaps.filter(gap => gap.severity === 'high').length,
        medium: gaps.filter(gap => gap.severity === 'medium').length,
        low: 0,
      },
      enforced,
      inferred,
      missing,
      gaps,
    },
  };
}
