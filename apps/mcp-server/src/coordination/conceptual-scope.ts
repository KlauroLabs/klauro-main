/**
 * Conceptual vocabulary for the coordination fabric (§4 of
 * docs/SPEC-CONCEPTUAL-LAYER.md — "what the conceptual layer powers: agent
 * work-alignment + fabric").
 *
 * Today the fabric coordinates on FILES and SYMBOLS: "I'm touching
 * src/checkout.ts" / "I'm editing chargeCard()". That's necessary but not
 * sufficient — two agents can hold textually-disjoint file/symbol claims and
 * still be doing conceptually related (or conceptually conflicting) work:
 * "I own the Charge step of the Checkout flow" / "I'm changing the Order
 * entity's constraints" are higher-signal, human-legible, and far less
 * collision-prone than a path list, because they say WHAT the work means,
 * not just WHERE it lands.
 *
 * This module is the mapping layer between the two: given a claim's declared
 * paths/symbols and a repo's FlowConcept graph (from
 * packages/analyzer-core/.../flow-concepts.ts, surfaced via
 * apps/mcp-server/src/query.ts's `getFlowConcepts`), derive which flow/step/
 * capability/entities that claim's footprint actually belongs to — and
 * classify pairs of conceptual coordinates as SAFE (different steps of the
 * same flow — real awareness, not a conflict), CONCEPTUAL CONFLICT (same
 * step, or the same entity's constraints even across different files — the
 * §4 case textual diff can't see), or unrelated.
 *
 * DETERMINISTIC-FIRST (cardinal rule, CLAUDE.md "Klauro deterministic facts +
 * AI"): every mapping here comes from a REAL FlowConcept produced by
 * `computeFlowConcepts` — a file/symbol that doesn't resolve to any known
 * step, or a repo with no flow-concepts computed at all, produces NO
 * conceptual coordinate rather than a guessed one. A claim with no derivable
 * concept simply stays file-level, exactly as before this module existed
 * (honest degrade).
 *
 * Pure module: no IO, no transport, no storage reads. Callers (server.ts)
 * pass in the FlowConcept[] (from a real getFlowConcepts(cas) call) and the
 * claim scopes to compare.
 */

import type { FlowConcept, FlowStep } from '../../../../packages/analyzer-core/src/analyzer/core/flow-concepts';
import type { ConceptualCoordinate } from './types';

// ---------------------------------------------------------------------------
// File/symbol -> concept index
// ---------------------------------------------------------------------------

interface StepIndexEntry {
  flow: FlowConcept;
  step: FlowStep;
}

/** Built once per (flows) call and reused across many claims/lookups. */
export interface ConceptIndex {
  /** function_id (a CAS node id) -> the step(s) that function belongs to. */
  byFunctionId: Map<string, StepIndexEntry[]>;
  /** entry_point id -> its flow (root-level fallback when only the entry
   *  point's own node, not a downstream function, is named). */
  byEntryPoint: Map<string, FlowConcept>;
  flows: FlowConcept[];
}

/** Build a lookup index from a repo's computed flows, for fast per-claim
 *  concept derivation. Call once per CAS snapshot, reuse across claims. */
export function buildConceptIndex(flows: FlowConcept[]): ConceptIndex {
  const byFunctionId = new Map<string, StepIndexEntry[]>();
  const byEntryPoint = new Map<string, FlowConcept>();

  for (const flow of flows) {
    byEntryPoint.set(flow.entry_point, flow);
    for (const step of flow.steps) {
      for (const fn of step.functions) {
        const list = byFunctionId.get(fn.function_id) ?? [];
        list.push({ flow, step });
        byFunctionId.set(fn.function_id, list);
      }
    }
  }

  return { byFunctionId, byEntryPoint, flows };
}

/** Match a claimed symbol/path token against a CAS node id or a file path
 *  suffix (claims commonly declare bare symbol names or relative paths that
 *  won't match a node id exactly — this mirrors partitioner.ts's `resolveIds`
 *  looseness, but here we only need file-path suffix matching since we
 *  already have the concrete function_id keys from the index). */
function tokenMatchesFunction(token: string, functionId: string): boolean {
  if (token === functionId) return true;
  // function_id is typically a CAS node id like "file.ts:funcName" or a bare
  // symbol id; also allow a bare-name match against the tail after the last
  // ':' or '.' separator, matching partitioner.ts's name-vs-id looseness.
  const tail = functionId.split(/[:./]/).pop();
  return !!tail && tail === token;
}

/**
 * Derive the conceptual coordinate(s) a claim's declared paths/symbols map
 * onto, using a prebuilt `ConceptIndex`. Returns one entry per distinct
 * (flow, step) the claim's footprint touches — usually 0 or 1, but a claim
 * spanning multiple functions in different steps/flows can resolve to more
 * than one; callers typically use the first (or all, for awareness).
 *
 * DETERMINISTIC: only returns entries backed by an actual step->function
 * membership in the index. A claim naming files/symbols that don't appear in
 * any computed flow returns [] — never fabricated.
 */
export function deriveConceptualCoordinates(
  claim: { scope: { paths: string[]; symbols: string[] } },
  index: ConceptIndex
): ConceptualCoordinate[] {
  const found = new Map<string, ConceptualCoordinate>();

  const tokens = [...claim.scope.symbols, ...claim.scope.paths];
  for (const token of tokens) {
    for (const [functionId, entries] of index.byFunctionId) {
      if (!tokenMatchesFunction(token, functionId)) continue;
      for (const { flow, step } of entries) {
        const key = `${flow.flow_id}::${step.step_id}`;
        if (found.has(key)) continue;
        found.set(key, {
          flow_id: flow.flow_id,
          step_id: step.step_id,
          capability_id: flow.capability_id,
          entities: flow.entities.length ? flow.entities : undefined,
          source: 'derived',
        });
      }
    }
  }

  return [...found.values()];
}

/** Convenience: the single best-match coordinate (first derived entry), for
 *  callers that just want to annotate a claim with "the" concept it belongs
 *  to rather than every step it might touch. Undefined when nothing derives. */
export function deriveConceptualCoordinate(
  claim: { scope: { paths: string[]; symbols: string[] } },
  index: ConceptIndex
): ConceptualCoordinate | undefined {
  return deriveConceptualCoordinates(claim, index)[0];
}

// ---------------------------------------------------------------------------
// Pairwise classification
// ---------------------------------------------------------------------------

export type ConceptualScopeVerdict = 'unrelated' | 'awareness' | 'conceptual_conflict';

export interface ConceptualScopeComparison {
  verdict: ConceptualScopeVerdict;
  /** Why this verdict was reached — human-legible, names the flow/step/entity. */
  reason: string;
  shared_flow_id?: string;
  shared_step_id?: string;
  shared_entities?: string[];
}

/**
 * Compare two agents' conceptual coordinates and classify the relationship:
 *
 *  - Same flow_id, DIFFERENT step_id -> 'awareness' (SAFE): both agents are
 *    working within one flow but on disjoint steps — worth knowing about
 *    each other, but not a conflict. Both proceed.
 *  - Same flow_id AND same step_id -> 'conceptual_conflict': real overlap,
 *    two agents changing the same semantic unit of work.
 *  - Different flows (or one/both missing a flow) but sharing an entity in
 *    `entities` -> 'conceptual_conflict': touching the same entity's
 *    constraints is a conceptual conflict EVEN ACROSS DIFFERENT FILES/FLOWS
 *    (§4's "conceptual conflicts > merge conflicts" case — semantic overlap
 *    a textual diff cannot see).
 *  - Anything else (no shared flow, no shared entity) -> 'unrelated'.
 *
 * Entity-overlap is checked even when a flow/step match already fired, so a
 * conflict's `shared_entities` is always populated when applicable, giving
 * callers the full evidence rather than just the first reason found.
 */
export function compareConceptualCoordinates(
  a: ConceptualCoordinate | undefined,
  b: ConceptualCoordinate | undefined
): ConceptualScopeComparison {
  const sharedEntities = intersectEntities(a?.entities, b?.entities);

  if (a?.flow_id && b?.flow_id && a.flow_id === b.flow_id) {
    if (a.step_id && b.step_id && a.step_id === b.step_id) {
      return {
        verdict: 'conceptual_conflict',
        reason: `Both agents are working the SAME step ("${a.step_id}") of flow "${a.flow_id}" — real overlap, not just file/symbol collision.`,
        shared_flow_id: a.flow_id,
        shared_step_id: a.step_id,
        shared_entities: sharedEntities.length ? sharedEntities : undefined,
      };
    }
    return {
      verdict: 'awareness',
      reason: `Both agents are working within flow "${a.flow_id}" but on DIFFERENT steps (${a.step_id ?? 'unknown'} vs ${b.step_id ?? 'unknown'}) — safe to proceed in parallel, but worth knowing about each other.`,
      shared_flow_id: a.flow_id,
    };
  }

  if (sharedEntities.length > 0) {
    return {
      verdict: 'conceptual_conflict',
      reason: `Both agents touch the SAME entity's constraints (${sharedEntities.join(', ')}) even though their flows/files differ — semantic overlap a textual/file diff would miss.`,
      shared_entities: sharedEntities,
    };
  }

  return { verdict: 'unrelated', reason: 'No shared flow, step, or entity — no conceptual relationship detected.' };
}

function intersectEntities(a?: string[], b?: string[]): string[] {
  if (!a?.length || !b?.length) return [];
  const setB = new Set(b);
  return [...new Set(a.filter((e) => setB.has(e)))];
}

/** Minimal scope shape this module's claim-level helpers need — a structural
 *  subset of `WorkClaim['scope']`, not the full shape, so callers with a bare
 *  `{ paths, symbols }` object (tests, lightweight fixtures) don't have to
 *  fabricate `repo`/`capability` just to use these helpers. */
interface ScopeLike {
  paths: string[];
  symbols: string[];
  concept?: ConceptualCoordinate;
}

/**
 * Annotate a claim's scope with a derived conceptual coordinate, IF one can
 * be derived AND the claim doesn't already declare one explicitly (declared
 * always wins over derived — an agent's explicit "I own the Charge step" is
 * authoritative over an inferred mapping). Returns the same claim object
 * shape with `scope.concept` filled in when applicable; otherwise returns it
 * unchanged. Pure — does not mutate the input.
 */
export function withDerivedConcept<T extends { scope: ScopeLike }>(
  claim: T,
  index: ConceptIndex
): T {
  if (claim.scope.concept) return claim; // declared wins — never override.
  const derived = deriveConceptualCoordinate(claim, index);
  if (!derived) return claim;
  return { ...claim, scope: { ...claim.scope, concept: derived } };
}

/**
 * Compare two claims' conceptual coordinates end-to-end: derive coordinates
 * for both (declared coordinates win; missing ones are derived from `index`
 * when supplied), then classify. Convenience wrapper over
 * `deriveConceptualCoordinate` + `compareConceptualCoordinates` for callers
 * that only have raw claims, not pre-derived coordinates.
 */
export function compareClaimsConceptually(
  claimA: { scope: ScopeLike },
  claimB: { scope: ScopeLike },
  index?: ConceptIndex
): ConceptualScopeComparison {
  const coordA = claimA.scope.concept ?? (index ? deriveConceptualCoordinate(claimA, index) : undefined);
  const coordB = claimB.scope.concept ?? (index ? deriveConceptualCoordinate(claimB, index) : undefined);
  return compareConceptualCoordinates(coordA, coordB);
}
