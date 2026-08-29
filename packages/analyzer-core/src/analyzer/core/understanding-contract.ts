import type {
  CASEdge,
  CASNode,
  CASOutput,
  FacetConstraint,
  FlowICELOTContract,
  FacetProvenance,
  FlowStep,
  ICELOTContract,
  ProvenanceFacet,
} from '../../types/cas.types';

export const BEHAVIORAL_CODE_UNIT_TYPES = new Set([
  'function', 'method', 'controller', 'handler', 'route', 'resolver', 'gateway',
  'service', 'usecase', 'repository', 'repository_operation', 'interface_method', 'dao',
  'react_route', 'component', 'functional_component', 'class_component', 'page', 'view',
  'hook_usage', 'hook', 'zustand_store', 'store',
]);
export function deriveContractLogic(
  nodes: CASNode[],
  facts: {
    nodesById: Map<string, CASNode>;
    behaviorEdgesBySource: Map<string, CASEdge[]>;
  },
  sourceConstraintsByNode: Map<string, FacetConstraint[]>,
): { value: string; evidence: string; nodeIds: string[] } | undefined {
  const parts: string[] = [];
  const evidence: string[] = [];
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    const controlFlowKeys = Object.keys(node.implementation?.control_flow || {}).sort();
    if (controlFlowKeys.length > 0) {
      parts.push(`${node.name} control flow (${controlFlowKeys.join(', ')})`);
      evidence.push(`node ${node.id} implementation.control_flow`);
      nodeIds.add(node.id);
    }
    const conditions = sourceConstraintsByNode.get(node.id) || [];
    if (conditions.length > 0) {
      parts.push(`${node.name} evaluates ${conditions.map(item => item.rule).join('; ')}`);
      evidence.push(`node ${node.id} source conditions`);
      nodeIds.add(node.id);
    }
    const calls = facts.behaviorEdgesBySource.get(node.id) || [];
    if (calls.length > 0) {
      const targets = calls
        .map(edge => facts.nodesById.get(edge.target)?.name || edge.target)
        .filter((value, index, values) => values.indexOf(value) === index)
        .sort();
      parts.push(`${node.name} ${calls.some(edge => edge.type === 'branches_to') ? 'branches to' : 'calls'} ${targets.join(', ')}`);
      evidence.push(...calls.map(edge => `edge ${edge.id}`));
      nodeIds.add(node.id);
    }
  }
  if (parts.length === 0) return undefined;
  return {
    value: parts.join(' -> '),
    evidence: [...new Set(evidence)].sort().join(', '),
    nodeIds: [...nodeIds].sort(),
  };
}

export function facetAbstentions(contract: Omit<ICELOTContract, 'facet_abstentions'>): ICELOTContract['facet_abstentions'] {
  const abstentions: NonNullable<ICELOTContract['facet_abstentions']> = {};
  if (contract.input.length === 0) abstentions.input = 'no-source-evidence';
  if (contract.constraints.length === 0) abstentions.constraints = 'no-source-evidence';
  if (contract.side_effects.state_changes.length === 0 && contract.side_effects.external_integrations.length === 0) {
    abstentions.system_effects = 'no-source-evidence';
  }
  if (!contract.logic) abstentions.logic = 'no-source-evidence';
  if (contract.output.length === 0) abstentions.output = 'no-source-evidence';
  if (!contract.telemetry) abstentions.telemetry = 'no-runtime-observation';
  return Object.keys(abstentions).length > 0 ? abstentions : undefined;
}


export function mergeNodeContracts(nodes: CASNode[]): ICELOTContract {
  const input = [...new Set(nodes.flatMap(node => node.contract?.input || []))];
  const output = [...new Set(nodes.flatMap(node => node.contract?.output || []))];
  const stateChanges = [...new Set(nodes.flatMap(node => node.contract?.side_effects.state_changes || []))];
  const externalIntegrations = [...new Set(nodes.flatMap(node => node.contract?.side_effects.external_integrations || []))];
  const constraints = [...new Map(nodes.flatMap(node => node.contract?.constraints || [])
    .map(constraint => [`${constraint.kind}::${constraint.rule}`, constraint])).values()];
  const logic = nodes.map(node => node.contract?.logic || '').filter(Boolean).join(' -> ');
  const provenanceByKey = new Map<string, FacetProvenance>();
  for (const provenance of nodes.flatMap(node => node.contract?.facet_provenance || [])) {
    if (provenance.facet === 'logic') continue;
    const key = `${provenance.facet}\u0000${provenance.value}`;
    const existing = provenanceByKey.get(key);
    if (!existing) {
      provenanceByKey.set(key, { ...provenance, contributed_by_node_ids: [...(provenance.contributed_by_node_ids || [])] });
      continue;
    }
    existing.contributed_by_node_ids = [...new Set([
      ...(existing.contributed_by_node_ids || []),
      ...(provenance.contributed_by_node_ids || []),
    ])].sort();
    existing.evidence = mergeEvidence(existing.evidence, provenance.evidence);
  }
  if (logic) {
    const logicProvenance = nodes.flatMap(node =>
      (node.contract?.facet_provenance || []).filter(provenance => provenance.facet === 'logic'));
    provenanceByKey.set(`logic\u0000${logic}`, {
      facet: 'logic',
      value: logic,
      contributed_by_node_ids: [...new Set(logicProvenance.flatMap(provenance => provenance.contributed_by_node_ids || []))].sort(),
      source: 'deterministic',
      evidence: logicProvenance.map(provenance => provenance.evidence).reduce(mergeEvidence),
    });
  }
  const contract: ICELOTContract = {
    input,
    logic,
    side_effects: { state_changes: stateChanges, external_integrations: externalIntegrations },
    output,
    constraints,
    facet_provenance: sortFacetProvenance([...provenanceByKey.values()]),
  };
  contract.facet_abstentions = facetAbstentions(contract);
  return contract;
}

export function sortFacetProvenance(entries: FacetProvenance[]): FacetProvenance[] {
  return [...entries].sort((a, b) =>
    a.facet.localeCompare(b.facet) || a.value.localeCompare(b.value));
}

export function mergeEvidence(left: string, right: string): string {
  return [...new Set([
    ...left.split(' | ').filter(Boolean),
    ...right.split(' | ').filter(Boolean),
  ])].sort().join(' | ');
}

function stepFacetProvenance(step: FlowStep, facet: ProvenanceFacet, value: string): FacetProvenance | undefined {
  return step.contract.facet_provenance?.find(p => p.facet === facet && p.value === value);
}

export function aggregateFlowContract(steps: FlowStep[]): FlowICELOTContract {
  const provenanceByKey = new Map<string, FacetProvenance & { contributed_by_step_ids: string[] }>();
  const record = (facet: ProvenanceFacet, value: string, stepId: string, provenance?: FacetProvenance) => {
    const key = `${facet}\u0000${value}`;
    const existing = provenanceByKey.get(key);
    if (existing) {
      if (!existing.contributed_by_step_ids.includes(stepId)) existing.contributed_by_step_ids.push(stepId);
      existing.contributed_by_node_ids = [...new Set([
        ...(existing.contributed_by_node_ids || []),
        ...(provenance?.contributed_by_node_ids || []),
      ])].sort();
      existing.evidence = mergeEvidence(existing.evidence, provenance?.evidence || `step ${stepId} contract`);
      return;
    }
    provenanceByKey.set(key, {
      facet,
      value,
      contributed_by_step_ids: [stepId],
      contributed_by_node_ids: [...(provenance?.contributed_by_node_ids || [])].sort(),
      source: 'deterministic',
      evidence: provenance?.evidence || `step ${stepId} contract`,
    });
  };

  const lastIdx = steps.length - 1;
  const initiating = steps[0];
  const terminal = steps[lastIdx];

  const input = [...initiating.contract.input];
  const inputSet = new Set(input);
  for (const v of input) {
    record('input', v, initiating.step_id, stepFacetProvenance(initiating, 'input', v));
  }
  const interiorInputs = new Set<string>();
  for (const step of steps.slice(1)) {
    for (const v of step.contract.input) if (!inputSet.has(v)) interiorInputs.add(v);
  }

  const output = [...terminal.contract.output];
  const outputSet = new Set(output);
  for (const v of output) {
    record('output', v, terminal.step_id, stepFacetProvenance(terminal, 'output', v));
  }
  const interiorOutputs = new Set<string>();
  for (const step of steps.slice(0, lastIdx)) {
    for (const v of step.contract.output) if (!outputSet.has(v)) interiorOutputs.add(v);
  }

  const stateChanges = new Set<string>();
  const externalIntegrations = new Set<string>();
  for (const step of steps) {
    for (const v of step.contract.side_effects.state_changes) {
      stateChanges.add(v);
      record('state_change', v, step.step_id, stepFacetProvenance(step, 'state_change', v));
    }
    for (const v of step.contract.side_effects.external_integrations) {
      externalIntegrations.add(v);
      record('external_integration', v, step.step_id, stepFacetProvenance(step, 'external_integration', v));
    }
  }

  const constraints: FacetConstraint[] = [];
  const constraintKeys = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const gatesDownstream = i < lastIdx || steps.length === 1;
    for (const c of step.contract.constraints) {
      if (c.kind !== 'error' && !gatesDownstream) continue;
      const key = `${c.kind}::${c.rule}`;
      if (!constraintKeys.has(key)) {
        constraintKeys.add(key);
        constraints.push(c);
      }
      record('constraint', c.rule, step.step_id, stepFacetProvenance(step, 'constraint', c.rule));
    }
  }

  const logicParts = steps.map(step => step.contract.logic).filter(Boolean);
  const logic = logicParts.join(' -> ');
  for (const step of steps) {
    if (step.contract.logic) record('logic', logic, step.step_id, stepFacetProvenance(step, 'logic', step.contract.logic));
  }
  const contract: FlowICELOTContract = {
    input,
    logic,
    side_effects: {
      state_changes: [...stateChanges],
      external_integrations: [...externalIntegrations],
    },
    output,
    constraints,
    ...(interiorInputs.size > 0 ? { internal_inputs_count: interiorInputs.size } : {}),
    ...(interiorOutputs.size > 0 ? { internal_outputs_count: interiorOutputs.size } : {}),
    ...(provenanceByKey.size > 0
      ? {
          facet_provenance: sortFacetProvenance(
            [...provenanceByKey.values()].map(p => ({ ...p, contributed_by_step_ids: [...p.contributed_by_step_ids].sort() }))
          ),
        }
      : {}),
  };
  contract.facet_abstentions = facetAbstentions(contract);
  return contract;
}


export interface LifecycleContractEvidence {
  facet: 'input' | 'state_change';
  value: string;
  evidence: string;
  entityKey?: string;
}

export function buildLifecycleEvidenceByNode(
  entities: NonNullable<CASOutput['entities']>,
  normalizeEntityKey: (value: string) => string,
): Map<string, LifecycleContractEvidence[]> {
  const byNode = new Map<string, LifecycleContractEvidence[]>();
  const add = (nodeId: string, item: LifecycleContractEvidence) => {
    const entries = byNode.get(nodeId) || [];
    entries.push(item);
    byNode.set(nodeId, entries);
  };
  for (const entity of entities) {
    const lifecycle = entity.lifecycle;
    if (!lifecycle) continue;
    const entityKey = normalizeEntityKey(entity.name);
    for (const [action, sources] of [
      ['created', lifecycle.created_by],
      ['updated', lifecycle.updated_by],
      ['deleted', lifecycle.deleted_by],
    ] as const) {
      for (const nodeId of sources) {
        add(nodeId, {
          facet: 'state_change',
          value: `${entity.name} ${action}`,
          entityKey,
          evidence: `data entity ${entity.id} lifecycle.${action}_by`,
        });
      }
    }
    for (const nodeId of lifecycle.read_by) {
      add(nodeId, {
        facet: 'input',
        value: `reads ${entity.name}`,
        evidence: `data entity ${entity.id} lifecycle.read_by`,
      });
    }
  }
  return byNode;
}
