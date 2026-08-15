import type { CASOutput, CASNode, CASExitPoint, SystemCapability } from '../../types/cas.types';
import {
  buildTraversalIndex,
  traceForwardChain,
  TRACEABLE_NODE_TYPES,
  type FlowConcept,
} from './flow-concepts';




































const REACH_MAX_DEPTH = 6;
const REACH_MAX_FUNCTIONS = 40;


const UNMAPPED_LIST_CAP = 50;

export interface CoverageRatio {


  ratio: number;
  mapped: number;
  total: number;
}

export interface UnmappedCodeUnit {
  id: string;
  name: string;
  type: string;





  structural_importance?: number;

  reason:
    | 'reachable-with-effects-uncaptured'
    | 'framework-generated'
    | 'test-code'
    | 'reachable-no-effects';
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


function buildLineageWriterSet(cas: CASOutput): Set<string> {
  const writers = new Set<string>();
  for (const entry of cas.data_lineage || []) {
    for (const w of entry.writers) writers.add(w.node_id);
  }
  return writers;
}





function collectEntryRoots(cas: CASOutput, nodesById: Map<string, CASNode>): string[] {
  const roots = new Set<string>();
  for (const ep of cas.entry_points || []) {
    const nid = ep.handler?.node_id || ep.source_node;
    if (nid && nodesById.has(nid)) roots.add(nid);
  }
  for (const cap of cas.capabilities || []) {
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








export function computeSemanticCoverage(
  cas: CASOutput,
  flows: FlowConcept[],
  _capabilities: SystemCapability[] = cas.capabilities || []
): SemanticCoverage {
  const nodesById = new Map((cas.nodes || []).map(n => [n.id, n]));
  const exitPointsByNode = buildExitPointIndex(cas);
  const lineageWriters = buildLineageWriterSet(cas);


  const traversal = buildTraversalIndex(cas);
  const roots = collectEntryRoots(cas, nodesById);
  const reachable = new Set<string>();
  for (const root of roots) {
    const chain = traceForwardChain(traversal, root, REACH_MAX_DEPTH, REACH_MAX_FUNCTIONS);
    for (const { node } of chain) {
      if (isExecutable(node)) reachable.add(node.id);
    }
  }


  const stepNodeIds = new Set<string>();
  let totalSteps = 0;
  const orphanSteps: UnmappedStep[] = [];
  for (const flow of flows) {
    for (const step of flow.steps || []) {
      totalSteps++;



      if (!flow.flow_id) {
        orphanSteps.push({ step_id: step.step_id, flow_id: '(none)', reason: 'step belongs to a flow with no flow_id' });
      }
      for (const f of step.functions || []) stepNodeIds.add(f.function_id);
    }
  }
  const mappedSteps = totalSteps - orphanSteps.length;


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
        ...(typeof node.structural_importance === 'number'
          ? { structural_importance: node.structural_importance }
          : {}),
        reason: classifyUnmappedReason(node, exitPointsByNode, lineageWriters),
      });
    }
  }



  unmappedCode.sort((a, b) =>
    ((b.structural_importance || 0) - (a.structural_importance || 0)) || a.id.localeCompare(b.id)
  );


  let mappedFlows = 0;
  const capablessFlows: UnmappedFlow[] = [];
  for (const flow of flows) {
    if ((flow.capability_relationships?.length || 0) > 0) {
      mappedFlows++;
    } else {








      const reason = flow.entities.length > 0
        ? `flow touches entities (${flow.entities.slice(0, 5).join(', ')}${flow.entities.length > 5 ? ', …' : ''}) but none belong to any capability's related_entities, and no capability operation references its entry point (no-capability-match)`
        : 'flow touches no entities this repo tracks, and no capability operation references its entry point (no-entity-evidence)';
      capablessFlows.push({
        flow_id: flow.flow_id,
        name: flow.name,
        reason,
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
