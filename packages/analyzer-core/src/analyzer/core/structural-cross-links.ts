import type {
  CASOutput,
  CASNode,
  CASArchitecturalConflict,
  CASPrincipleViolation,
} from '../../types/cas.types';
import type { FlowConcept, FlowStep } from './flow-concepts';
import { layerOf } from './flow-concepts';



























export interface StepStructuralLinks {





  layers: string[];




  paradigm_deviations: Array<{ paradigm: string; detail: string; severity: string }>;
}

export interface FlowStructuralLinks {

  layers: string[];

  paradigm_deviations: Array<{ paradigm: string; detail: string; severity: string; step_id: string }>;
}

export interface ConflictBehavioralLinks {



  flow_ids: string[];



  capability_ids: string[];



  step_ids: string[];
}



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



function buildNodeLookup(cas: CASOutput): Map<string, CASNode> {
  return new Map(cas.nodes.map(n => [n.id, n]));
}








export function computeFlowStructuralLinks(
  cas: CASOutput,
  flows: FlowConcept[]
): Map<string  , { flow: FlowStructuralLinks; steps: Map<string  , StepStructuralLinks> }> {
  const nodesById = buildNodeLookup(cas);
  const paradigms = cas.paradigm_conformance || [];


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
