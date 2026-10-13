import { getAnalysis } from '../analysis-access';
import { buildConceptIndex, compareConceptualCoordinates, deriveConceptualCoordinates, type ConceptIndex } from './conceptual-scope';
import type { ConceptualCoordinate } from './types';

export interface AnalysisRef {
  analysis_id: string;
  commit?: string;
  analyzed_at?: string;
}

export interface ClaimedConcepts {
  concept?: ConceptualCoordinate;
  concepts: ConceptualCoordinate[];
  attribution_source: 'declared' | 'derived' | 'none';
  analysis_ref?: AnalysisRef;
}

interface HeldIndex {
  index: ConceptIndex;
  ref: AnalysisRef;
}

const held = new Map<string, HeldIndex>();
const HELD_WORKSPACES = 32;

async function indexFor(analysisKey: string): Promise<HeldIndex | undefined> {
  const identity = await getAnalysis(analysisKey, { sections: ['identity'] }).catch(() => undefined);
  if (!identity?.analysis_id) return undefined;
  const known = held.get(analysisKey);
  if (known?.ref.analysis_id === identity.analysis_id) return known;
  const cas = await getAnalysis(analysisKey, { sections: ['identity', 'comprehension'] }).catch(() => undefined);
  if (!cas?.flows?.length) return undefined;
  const fresh: HeldIndex = {
    index: buildConceptIndex(cas.flows),
    ref: {
      analysis_id: identity.analysis_id,
      ...(identity.base_commit ? { commit: identity.base_commit } : {}),
      ...(identity.analysis_timestamp ? { analyzed_at: identity.analysis_timestamp } : {}),
    },
  };
  held.delete(analysisKey);
  held.set(analysisKey, fresh);
  while (held.size > HELD_WORKSPACES) held.delete(held.keys().next().value as string);
  return fresh;
}

export async function claimedConcepts(
  analysisKey: string,
  scope: { paths?: string[]; symbols?: string[] },
  declared?: ConceptualCoordinate,
): Promise<ClaimedConcepts> {
  const named = (scope.paths?.length ?? 0) + (scope.symbols?.length ?? 0) > 0;
  return conceptsWith(named ? await indexFor(analysisKey) : undefined, scope, declared);
}

function conceptsWith(
  found: HeldIndex | undefined,
  scope: { paths?: string[]; symbols?: string[] },
  declared?: ConceptualCoordinate,
): ClaimedConcepts {
  const derived = found
    ? deriveConceptualCoordinates({ scope: { paths: scope.paths ?? [], symbols: scope.symbols ?? [] } }, found.index)
    : [];
  const ref = found ? { analysis_ref: found.ref } : {};
  if (declared) {
    const own = { ...declared, source: 'declared' as const };
    return { concept: own, concepts: [own, ...derived], attribution_source: 'declared', ...ref };
  }
  return {
    ...(derived[0] ? { concept: derived[0] } : {}),
    concepts: derived,
    attribution_source: derived.length ? 'derived' : 'none',
    ...ref,
  };
}

export type ConceptualNeighbour = ReturnType<typeof compareConceptualCoordinates> & {
  agent_id: string;
  intent: string;
  theirs: ConceptualCoordinate;
};

function closeness(neighbour: Pick<ConceptualNeighbour, 'verdict' | 'shared_step_id' | 'shared_flow_id'>): number {
  if (neighbour.verdict === 'conceptual_conflict') return neighbour.shared_step_id ? 0 : 1;
  return neighbour.shared_flow_id ? 2 : 3;
}

export async function conceptualNeighbours(
  analysisKey: string,
  agentId: string,
  mine: ConceptualCoordinate[],
  others: Array<{ agent_id: string; intent: string; scope: { paths?: string[]; symbols?: string[]; concept?: ConceptualCoordinate } }>,
): Promise<ConceptualNeighbour[]> {
  if (!mine.length) return [];
  const found = await indexFor(analysisKey);
  const neighbours: ConceptualNeighbour[] = [];
  for (const other of others) {
    if (other.agent_id === agentId) continue;
    const theirs = conceptsWith(found, other.scope, other.scope.concept).concepts;
    let closest: ConceptualNeighbour | undefined;
    for (const own of mine) {
      for (const their of theirs) {
        const comparison = compareConceptualCoordinates(own, their);
        if (comparison.verdict === 'unrelated') continue;
        const candidate = { ...comparison, agent_id: other.agent_id, intent: other.intent, theirs: their };
        if (closest && closeness(closest) <= closeness(candidate)) continue;
        closest = candidate;
      }
    }
    if (closest) neighbours.push(closest);
  }
  return neighbours.sort((a, b) => closeness(a) - closeness(b));
}

export async function extendedConcepts(
  analysisKey: string,
  claim: { agent_id: string; scope: { paths?: string[]; symbols?: string[]; concept?: ConceptualCoordinate } },
  active: Parameters<typeof conceptualNeighbours>[3],
) {
  const claimed = await claimedConcepts(analysisKey, claim.scope, claim.scope.concept);
  return {
    concepts: claimed.concepts,
    attribution_source: claimed.attribution_source,
    analysis_ref: claimed.analysis_ref,
    conceptual_awareness: await conceptualNeighbours(analysisKey, claim.agent_id, claimed.concepts, active),
  };
}
