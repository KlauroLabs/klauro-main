import type { CASOutput, CASNode, CASExitPoint, SystemCapability } from '../../types/cas.types';
import {
  buildTraversalIndex,
  traceForwardChain,
  TRACEABLE_NODE_TYPES,
  type FlowConcept,
} from './flow-concepts';

/**
 * SEMANTIC COVERAGE — "everything rolls up" made MEASURABLE (docs/SEMANTIC-MODEL.md,
 * "Coverage invariants"). A pure, DETERMINISTIC (Camp-B) pass over the CAS + the
 * already-computed flow set: no AI, byte-stable run-to-run, evidence-only. It answers
 * three ratios and, crucially, the HONEST lists behind them (never just counts):
 *
 *   reachable_code_to_steps  — of the executable nodes REACHABLE from an entry point
 *                              (the same forward call-graph traversal the flow layer
 *                              builds), what fraction participate in ≥1 flow STEP
 *                              (a step's `functions[].function_id` set)?
 *   steps_to_flows           — of all steps, what fraction are assigned to ≥1 flow?
 *                              (steps are nested in flows by construction, so this is
 *                              an INVARIANT ~1.0 — measured honestly to catch a future
 *                              regression that ever detaches a step from its flow.)
 *   flows_to_capabilities    — of flows, what fraction carry ≥1 capability_relationship
 *                              (B1's flow.capability_relationships M:N edge)?
 *
 * "Reachable" is defined exactly as the flow layer sees it: the union, over every
 * entry-point root (cas.entry_points handler nodes) PLUS every capability-operation
 * node reference (`node:<id>` — the same synthetic roots buildTerminalFlows/
 * computeEntryPointFlows trace from), of the forward call-chain traversal
 * (traceForwardChain), restricted to executable node types (TRACEABLE_NODE_TYPES —
 * the same set flow steps are drawn from). This makes the numerator a strict subset
 * of the denominator by construction: a mapped node is a reachable node that a step
 * cited.
 *
 * Unmapped code is SURFACED, not hidden — it indicates missing semantics, generic
 * infrastructure, dead code, framework-generated behavior, incomplete extraction, or
 * an undiscovered capability/flow. Each unmapped unit carries a deterministic `reason`
 * derived from CAS facts (its own exit points / lineage writes / generated+test
 * metadata), so a reader can tell "worth a flow" from "genuinely plumbing".
 */

// Same bounds the flow layer uses by default (DEFAULT_MAX_DEPTH / DEFAULT_MAX_FUNCTIONS
// in flow-concepts.ts) so the reachable universe matches what flows can actually cover.
const REACH_MAX_DEPTH = 6;
const REACH_MAX_FUNCTIONS = 40;

/** Honest lists are capped for response size; the omitted count is always reported. */
const UNMAPPED_LIST_CAP = 50;

export interface CoverageRatio {
  /** 0..1, rounded to 4 decimals for byte-stable serialization. `total===0`
   *  yields 1 (vacuously complete — nothing to roll up, never a false regression). */
  ratio: number;
  mapped: number;
  total: number;
}

export interface UnmappedCodeUnit {
  id: string;
  name: string;
  type: string;
  /** Deterministic classification of WHY this reachable node maps to no step. */
  reason:
    | 'reachable-with-effects-uncaptured' // has exit points / lineage writes — likely incomplete extraction or an undiscovered flow
    | 'framework-generated'               // metadata.is_generated — framework/codegen output
    | 'test-code'                         // metadata.is_test — test helper reachable from an entry
    | 'reachable-no-effects';             // no observable surface — generic infra / dead code
}

export interface UnmappedStep {
  step_id: string;
  flow_id: string;
  reason: string;
}

export interface UnmappedFlow {
  flow_id: string;
  name: string;
  reason: string;
}

export interface SemanticCoverage {
  reachable_code_to_steps: CoverageRatio;
  steps_to_flows: CoverageRatio;
  flows_to_capabilities: CoverageRatio;
  unmapped: {
    code_units: UnmappedCodeUnit[];
    code_units_omitted: number;
    steps: UnmappedStep[];
    steps_omitted: number;
    flows: UnmappedFlow[];
    flows_omitted: number;
  };
}

/** The compact projection surfaced in buildSummary: ratios + counts only (no full
 *  unmapped lists — those live in the dedicated get_semantic_coverage tool). */
export interface SemanticCoverageCompact {
  reachable_code_to_steps: CoverageRatio;
  steps_to_flows: CoverageRatio;
  flows_to_capabilities: CoverageRatio;
  unmapped_counts: {
    code_units: number;
    steps: number;
    flows: number;
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function ratio(mapped: number, total: number): CoverageRatio {
  return { ratio: total > 0 ? round4(mapped / total) : 1, mapped, total };
}

function buildExitPointIndex(cas: CASOutput): Map<string, CASExitPoint[]> {
  const index = new Map<string, CASExitPoint[]>();
  for (const ep of cas.exit_points || []) {
    if (!index.has(ep.source_node)) index.set(ep.source_node, []);
    index.get(ep.source_node)!.push(ep);
  }
  return index;
}

/** Node ids that write at least one data-lineage entity (a state-changing effect). */
function buildLineageWriterSet(cas: CASOutput): Set<string> {
  const writers = new Set<string>();
  for (const entry of cas.data_lineage || []) {
    for (const w of entry.writers) writers.add(w.node_id);
  }
  return writers;
}

/** Entry-point roots + capability-operation node roots — the SAME roots the flow
 *  layer traces from (real entry points, plus `node:<id>` capability operation
 *  references that buildTerminalFlows/computeEntryPointFlows synthesize roots for).
 *  Sorted for deterministic traversal order. */
function collectEntryRoots(cas: CASOutput, nodesById: Map<string, CASNode>): string[] {
  const roots = new Set<string>();
  for (const ep of cas.entry_points || []) {
    const nid = ep.handler?.node_id || ep.source_node;
    if (nid && nodesById.has(nid)) roots.add(nid);
  }
  for (const cap of cas.system_capabilities || []) {
    for (const op of cap.operations || []) {
      const epId = op.entry_point_id || '';
      if (epId.startsWith('node:')) {
        const nid = epId.slice('node:'.length);
        if (nodesById.has(nid)) roots.add(nid);
      }
    }
  }
  return [...roots].sort();
}

function isExecutable(node: CASNode): boolean {
  return TRACEABLE_NODE_TYPES.has(node.type);
}

function classifyUnmappedReason(
  node: CASNode,
  exitPointsByNode: Map<string, CASExitPoint[]>,
  lineageWriters: Set<string>
): UnmappedCodeUnit['reason'] {
  const meta = node.metadata;
  if (meta?.is_generated) return 'framework-generated';
  if (meta?.is_test) return 'test-code';
  const hasExit = (exitPointsByNode.get(node.id) || []).length > 0;
  const writes = lineageWriters.has(node.id);
  if (hasExit || writes) return 'reachable-with-effects-uncaptured';
  return 'reachable-no-effects';
}

/**
 * computeSemanticCoverage — the deterministic coverage computer. Takes the CAS,
 * the already-computed `flows` (the flow set whose rollup is being measured — pass
 * the FULL set for an honest product-surface ratio), and the capabilities (only used
 * to align the reachable-root set with the flow layer; flow↔capability edges are read
 * off the flows themselves). Never mutates its inputs.
 */
export function computeSemanticCoverage(
  cas: CASOutput,
  flows: FlowConcept[],
  _capabilities: SystemCapability[] = cas.system_capabilities || []
): SemanticCoverage {
  const nodesById = new Map((cas.nodes || []).map(n => [n.id, n]));
  const exitPointsByNode = buildExitPointIndex(cas);
  const lineageWriters = buildLineageWriterSet(cas);

  // --- reachable executable universe (denominator of reachable_code_to_steps) ---
  const traversal = buildTraversalIndex(cas);
  const roots = collectEntryRoots(cas, nodesById);
  const reachable = new Set<string>();
  for (const root of roots) {
    const chain = traceForwardChain(traversal, root, REACH_MAX_DEPTH, REACH_MAX_FUNCTIONS);
    for (const { node } of chain) {
      if (isExecutable(node)) reachable.add(node.id);
    }
  }

  // --- nodes cited by ≥1 flow step (numerator source) ---
  const stepNodeIds = new Set<string>();
  let totalSteps = 0;
  const orphanSteps: UnmappedStep[] = [];
  for (const flow of flows) {
    for (const step of flow.steps || []) {
      totalSteps++;
      // Every step is nested in a flow by construction — a step with a resolvable
      // flow_id IS assigned to a flow. An orphan (missing flow_id) would be a real
      // regression: surface it rather than silently counting it as covered.
      if (!flow.flow_id) {
        orphanSteps.push({ step_id: step.step_id, flow_id: '(none)', reason: 'step belongs to a flow with no flow_id' });
      }
      for (const f of step.functions || []) stepNodeIds.add(f.function_id);
    }
  }
  const mappedSteps = totalSteps - orphanSteps.length;

  // --- reachable_code_to_steps ---
  const reachableSorted = [...reachable].sort();
  let mappedCode = 0;
  const unmappedCode: UnmappedCodeUnit[] = [];
  for (const id of reachableSorted) {
    if (stepNodeIds.has(id)) {
      mappedCode++;
    } else {
      const node = nodesById.get(id);
      if (!node) continue;
      unmappedCode.push({
        id: node.id,
        name: node.name,
        type: node.type,
        reason: classifyUnmappedReason(node, exitPointsByNode, lineageWriters),
      });
    }
  }

  // --- flows_to_capabilities ---
  let mappedFlows = 0;
  const capablessFlows: UnmappedFlow[] = [];
  for (const flow of flows) {
    if ((flow.capability_relationships?.length || 0) > 0) {
      mappedFlows++;
    } else {
      capablessFlows.push({
        flow_id: flow.flow_id,
        name: flow.name,
        reason: 'no capability operation references this flow\'s entry point and it shares no entity with any capability',
      });
    }
  }
  capablessFlows.sort((a, b) => a.flow_id.localeCompare(b.flow_id));

  const capCode = unmappedCode.slice(0, UNMAPPED_LIST_CAP);
  const capFlows = capablessFlows.slice(0, UNMAPPED_LIST_CAP);
  const capStepsList = orphanSteps.slice(0, UNMAPPED_LIST_CAP);

  return {
    reachable_code_to_steps: ratio(mappedCode, reachable.size),
    steps_to_flows: ratio(mappedSteps, totalSteps),
    flows_to_capabilities: ratio(mappedFlows, flows.length),
    unmapped: {
      code_units: capCode,
      code_units_omitted: unmappedCode.length - capCode.length,
      steps: capStepsList,
      steps_omitted: orphanSteps.length - capStepsList.length,
      flows: capFlows,
      flows_omitted: capablessFlows.length - capFlows.length,
    },
  };
}

/** Strip the full unmapped lists down to the compact summary projection (ratios +
 *  counts) used in buildSummary — the dedicated tool carries the full lists. */
export function toCompactSemanticCoverage(coverage: SemanticCoverage): SemanticCoverageCompact {
  return {
    reachable_code_to_steps: coverage.reachable_code_to_steps,
    steps_to_flows: coverage.steps_to_flows,
    flows_to_capabilities: coverage.flows_to_capabilities,
    unmapped_counts: {
      code_units: coverage.unmapped.code_units.length + coverage.unmapped.code_units_omitted,
      steps: coverage.unmapped.steps.length + coverage.unmapped.steps_omitted,
      flows: coverage.unmapped.flows.length + coverage.unmapped.flows_omitted,
    },
  };
}
