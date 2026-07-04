import type {
  CASOutput,
  CASNode,
  CASParadigmConformance,
  CASArchitecturalConflict,
  CASPrincipleViolation,
} from '../../types/cas.types';
import type { FlowConcept, FlowStep } from './flow-concepts';
import { layerOf } from './flow-concepts';

/**
 * STRUCTURAL CROSS-LINKS — unifies the BEHAVIORAL hierarchy (Capability ->
 * Flow -> Step -> Function, flow-concepts.ts) with the STRUCTURAL
 * perspectives (architectural conflicts + paradigm conformance,
 * docs/SPEC-CONCEPTUAL-LAYER.md §3/§6) over the SAME index, in both
 * directions:
 *
 *  1. Flow/Step -> structural: which architectural LAYER(S) a step's
 *     functions actually sit in (deterministic, from node.category/type via
 *     the same layerOf() flow-concepts.ts uses for step segmentation), and
 *     which paradigm DEVIATIONS (if any) touch this step's functions —
 *     i.e. "this step's functions violate the entry-service-repository
 *     layering norm".
 *  2. Architectural conflict/principle-violation -> behavioral: which
 *     flow(s)/step(s) the conflict's evidence node_ids actually belong to —
 *     "this layering violation sits on the Persist step of the Checkout
 *     flow".
 *
 * HONESTY: a cross-link is only asserted when the evidence supports it —
 * layers come from the same node classification the flow segmenter already
 * uses (no new heuristic), and conflict/violation links are only made when a
 * conflict's own node_id/file evidence resolves to a node actually present in
 * a traced flow's function set (membership test on real ids, never a
 * name-similarity guess). No match -> omitted, not fabricated.
 */

export interface StepStructuralLinks {
  /** Distinct architectural layers spanned by this step's function(s), per
   *  the same node.category/type classification flow segmentation uses
   *  (entry/business/data/presentation/unknown). Usually one layer per step
   *  since layer change is itself a step boundary — more than one only when
   *  a sub-sectioned single function's helpers span layers ambiguously. */
  layers: string[];
  /** Paradigm names (from paradigm_conformance) with at least one deviation
   *  whose node_id falls inside this step's function set — i.e. this step
   *  is itself a site of a structural-norm deviation. Omitted (empty) when
   *  none of the step's functions appear in any paradigm's deviations. */
  paradigm_deviations: Array<{ paradigm: string; detail: string; severity: string }>;
}

export interface FlowStructuralLinks {
  /** Union of every step's layers, in step order, deduped. */
  layers: string[];
  /** Union of every step's paradigm deviations. */
  paradigm_deviations: Array<{ paradigm: string; detail: string; severity: string; step_id: string }>;
}

export interface ConflictBehavioralLinks {
  /** flow_ids whose traced function set intersects this conflict's evidence
   *  node_ids (resolved via the architectural_conflicts evidence/competing
   *  file lists matched back to node ids in the flow's function set). */
  flow_ids: string[];
  /** capability_ids reached transitively via the linked flows'
   *  capability_id (only when the flow itself resolved one — never guessed
   *  independently here). */
  capability_ids: string[];
  /** step_ids (within the linked flows) whose function set actually
   *  contains one of the conflict's evidence node ids — the precise
   *  "this conflict sits on step X of flow Y" pointer. */
  step_ids: string[];
}

/** Index: function_id -> the flow_id/step it belongs to, across all flows.
 *  Built once and reused for both directions of cross-linking. */
function buildFunctionMembershipIndex(flows: FlowConcept[]): Map<string, Array<{ flow: FlowConcept; step: FlowStep }>> {
  const index = new Map<string, Array<{ flow: FlowConcept; step: FlowStep }>>();
  for (const flow of flows) {
    for (const step of flow.steps) {
      for (const fn of step.functions) {
        const list = index.get(fn.function_id) || [];
        list.push({ flow, step });
        index.set(fn.function_id, list);
      }
    }
  }
  return index;
}

/** Node-id lookup for resolving a step's function_ids back to CASNode
 *  objects (needed for layerOf()). */
function buildNodeLookup(cas: CASOutput): Map<string, CASNode> {
  return new Map(cas.nodes.map(n => [n.id, n]));
}

/**
 * Compute per-step and per-flow structural links (direction 1: behavioral ->
 * structural). Deterministic: layer comes from layerOf(node) on each step's
 * resolved function nodes; paradigm deviations come from a node_id-membership
 * test against cas.paradigm_conformance[].deviations (already-computed
 * facts, no re-detection).
 */
export function computeFlowStructuralLinks(
  cas: CASOutput,
  flows: FlowConcept[]
): Map<string /* flow_id */, { flow: FlowStructuralLinks; steps: Map<string /* step_id */, StepStructuralLinks> }> {
  const nodesById = buildNodeLookup(cas);
  const paradigms = cas.paradigm_conformance || [];

  // deviation node_id -> [{paradigm, detail, severity}], built once.
  const deviationsByNode = new Map<string, Array<{ paradigm: string; detail: string; severity: string }>>();
  for (const p of paradigms) {
    for (const d of p.deviations) {
      const list = deviationsByNode.get(d.node_id) || [];
      list.push({ paradigm: p.paradigm, detail: d.detail, severity: d.severity });
      deviationsByNode.set(d.node_id, list);
    }
  }

  const result = new Map<string, { flow: FlowStructuralLinks; steps: Map<string, StepStructuralLinks> }>();

  for (const flow of flows) {
    const stepsMap = new Map<string, StepStructuralLinks>();
    const flowLayers: string[] = [];
    const flowDeviations: FlowStructuralLinks['paradigm_deviations'] = [];

    for (const step of flow.steps) {
      const layerSet = new Set<string>();
      const stepDeviations: StepStructuralLinks['paradigm_deviations'] = [];

      for (const fn of step.functions) {
        const node = nodesById.get(fn.function_id);
        if (node) layerSet.add(layerOf(node));

        for (const dev of deviationsByNode.get(fn.function_id) || []) {
          stepDeviations.push(dev);
          flowDeviations.push({ ...dev, step_id: step.step_id });
        }
      }

      const layers = [...layerSet];
      for (const l of layers) if (!flowLayers.includes(l)) flowLayers.push(l);

      stepsMap.set(step.step_id, { layers, paradigm_deviations: stepDeviations });
    }

    result.set(flow.flow_id, {
      flow: { layers: flowLayers, paradigm_deviations: flowDeviations },
      steps: stepsMap,
    });
  }

  return result;
}

/** Resolve a conflict/violation's evidence back to concrete node ids. A
 *  CASPrincipleViolation carries node_id directly. A CASArchitecturalConflict
 *  does not (its `competing[].files`/`evidence` are file-path/text strings,
 *  not ids) — for those we resolve by matching the file paths named in
 *  `competing[].files` against the source file of nodes actually present in
 *  a flow's function set, which is the only honest join available (no
 *  fabricated node_id on the conflict). */
function resolveConflictNodeIds(
  conflict: CASArchitecturalConflict,
  cas: CASOutput
): Set<string> {
  const files = new Set(conflict.competing.flatMap(c => c.files));
  const ids = new Set<string>();
  if (files.size === 0) return ids;
  for (const node of cas.nodes) {
    if (node.source?.file && files.has(node.source.file)) ids.add(node.id);
  }
  return ids;
}

export interface ConflictLinkResult {
  conflicts: Map<string, ConflictBehavioralLinks>;
  violations: Map<string, ConflictBehavioralLinks>;
}

/**
 * Compute behavioral links for architectural conflicts and principle
 * violations (direction 2: structural -> behavioral). A conflict/violation
 * links to a flow/step only when one of its resolved evidence node ids is
 * actually present in that flow's traced function set — real membership,
 * never a name/file-prefix guess.
 */
export function computeConflictBehavioralLinks(
  cas: CASOutput,
  flows: FlowConcept[],
  conflicts: CASArchitecturalConflict[],
  violations: CASPrincipleViolation[]
): ConflictLinkResult {
  const membership = buildFunctionMembershipIndex(flows);

  function linksForNodeIds(nodeIds: Iterable<string>): ConflictBehavioralLinks {
    const flowIds = new Set<string>();
    const capabilityIds = new Set<string>();
    const stepIds = new Set<string>();
    for (const nodeId of nodeIds) {
      for (const { flow, step } of membership.get(nodeId) || []) {
        flowIds.add(flow.flow_id);
        stepIds.add(step.step_id);
        if (flow.capability_id) capabilityIds.add(flow.capability_id);
      }
    }
    return { flow_ids: [...flowIds], capability_ids: [...capabilityIds], step_ids: [...stepIds] };
  }

  const conflictLinks = new Map<string, ConflictBehavioralLinks>();
  for (const conflict of conflicts) {
    const nodeIds = resolveConflictNodeIds(conflict, cas);
    const links = linksForNodeIds(nodeIds);
    if (links.flow_ids.length > 0) conflictLinks.set(conflict.id, links);
  }

  const violationLinks = new Map<string, ConflictBehavioralLinks>();
  for (const violation of violations) {
    const links = linksForNodeIds([violation.node_id]);
    if (links.flow_ids.length > 0) violationLinks.set(violation.id, links);
  }

  return { conflicts: conflictLinks, violations: violationLinks };
}
