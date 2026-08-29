import { isDeepStrictEqual } from 'node:util';
import type {
  CASNode,
  CASOutput,
  FacetProvenance,
  FlowStep,
  ICELOTContract,
  UnderstandingContractFacet,
} from '../../types/cas.types';
import { deriveNodeUnderstandingContracts } from './flow-concepts';
import {
  aggregateFlowContract,
  BEHAVIORAL_CODE_UNIT_TYPES,
  mergeNodeContracts,
} from './understanding-contract';

export interface UnderstandingContractIntegrityIssue {
  code:
    | 'missing-node-contract'
    | 'contract-on-nonbehavioral-node'
    | 'contract-on-capability'
    | 'missing-facet-provenance'
    | 'missing-facet-abstention'
    | 'populated-facet-abstained'
    | 'dangling-node-provenance'
    | 'dangling-step-provenance'
    | 'misattributed-facet-provenance'
    | 'deterministic-contract-mismatch';
  owner_id: string;
  facet?: UnderstandingContractFacet;
  evidence_id?: string;
}

function populatedFacets(
  contract: ICELOTContract,
): Array<[UnderstandingContractFacet, string[], FacetProvenance['facet'][]]> {
  return [
    ['input', contract.input, ['input']],
    ['constraints', contract.constraints.map(constraint => constraint.rule), ['constraint']],
    ['system_effects', [...contract.side_effects.state_changes, ...contract.side_effects.external_integrations], ['state_change', 'external_integration']],
    ['logic', contract.logic ? [contract.logic] : [], ['logic']],
    ['output', contract.output, ['output']],
    ['telemetry', contract.telemetry ? [contract.telemetry.static_id] : [], ['telemetry']],
  ];
}

function validateContract(
  ownerId: string,
  contract: ICELOTContract,
  nodeIds: Set<string>,
  allowedNodeIds?: Set<string>,
  allowedStepIds?: Set<string>,
): UnderstandingContractIntegrityIssue[] {
  const issues: UnderstandingContractIntegrityIssue[] = [];
  const provenance = contract.facet_provenance || [];
  for (const [facet, values, provenanceFacets] of populatedFacets(contract)) {
    if (values.length === 0) {
      if (!contract.facet_abstentions?.[facet]) {
        issues.push({ code: 'missing-facet-abstention', owner_id: ownerId, facet });
      }
      continue;
    }
    if (contract.facet_abstentions?.[facet]) {
      issues.push({ code: 'populated-facet-abstained', owner_id: ownerId, facet });
    }
    for (const value of values) {
      const matching = provenance.filter(entry =>
        entry.value === value && provenanceFacets.includes(entry.facet));
      if (matching.length === 0 || matching.every(entry => (entry.contributed_by_node_ids || []).length === 0)) {
        issues.push({ code: 'missing-facet-provenance', owner_id: ownerId, facet });
        continue;
      }
      for (const entry of matching) {
        for (const nodeId of entry.contributed_by_node_ids || []) {
          if (!nodeIds.has(nodeId) || (allowedNodeIds && !allowedNodeIds.has(nodeId))) {
            issues.push({ code: 'dangling-node-provenance', owner_id: ownerId, facet, evidence_id: nodeId });
          }
        }
        for (const stepId of entry.contributed_by_step_ids || []) {
          if (allowedStepIds && !allowedStepIds.has(stepId)) {
            issues.push({ code: 'dangling-step-provenance', owner_id: ownerId, facet, evidence_id: stepId });
          }
        }
      }
    }
  }
  return issues;
}

function stepNodeIds(step: FlowStep): Set<string> {
  return new Set((step.functions || []).map(reference => reference.function_id));
}

function nodesWithExpectedContracts(
  ids: Iterable<string>,
  nodesById: ReadonlyMap<string, CASNode>,
  expectedNodeContracts: ReadonlyMap<string, ICELOTContract>,
): CASNode[] {
  const result: CASNode[] = [];
  for (const id of ids) {
    const node = nodesById.get(id);
    const contract = expectedNodeContracts.get(id);
    if (node && contract) result.push({ ...node, contract });
  }
  return result;
}

function validateCas(cas: CASOutput): UnderstandingContractIntegrityIssue[] {
  const issues: UnderstandingContractIntegrityIssue[] = [];
  const nodes = cas.nodes || [];
  const nodeIds = new Set(nodes.map(node => node.id));
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const expectedNodeContracts = deriveNodeUnderstandingContracts(cas);

  for (const node of nodes) {
    const behavioral = BEHAVIORAL_CODE_UNIT_TYPES.has(node.type);
    const expected = expectedNodeContracts.get(node.id);
    if (behavioral && !node.contract) {
      issues.push({ code: 'missing-node-contract', owner_id: node.id });
    } else if (!behavioral && node.contract) {
      issues.push({ code: 'contract-on-nonbehavioral-node', owner_id: node.id });
    } else if (node.contract) {
      issues.push(...validateContract(node.id, node.contract, nodeIds, new Set([node.id])));
      if (!expected || !isDeepStrictEqual(node.contract, expected)) {
        issues.push({ code: 'deterministic-contract-mismatch', owner_id: node.id });
      }
    }
  }

  for (const capability of cas.capabilities || []) {
    if ('contract' in capability) issues.push({ code: 'contract-on-capability', owner_id: capability.id });
  }

  for (const flow of cas.flows || []) {
    const steps = flow.steps || [];
    const stepIds = new Set(steps.map(step => step.step_id));
    const flowNodeIds = new Set(steps.flatMap(step => [...stepNodeIds(step)]));
    const expectedSteps: FlowStep[] = [];
    for (const step of steps) {
      const allowedNodeIds = stepNodeIds(step);
      issues.push(...validateContract(step.step_id, step.contract, nodeIds, allowedNodeIds));
      const expectedContract = mergeNodeContracts(
        nodesWithExpectedContracts(allowedNodeIds, nodesById, expectedNodeContracts),
      );
      expectedSteps.push({ ...step, contract: expectedContract });
      if (!isDeepStrictEqual(step.contract, expectedContract)) {
        issues.push({ code: 'deterministic-contract-mismatch', owner_id: step.step_id });
        issues.push({ code: 'misattributed-facet-provenance', owner_id: step.step_id });
      }
    }
    issues.push(...validateContract(flow.flow_id, flow.contract, nodeIds, flowNodeIds, stepIds));
    if (expectedSteps.length > 0) {
      const expectedFlowContract = aggregateFlowContract(expectedSteps);
      if (!isDeepStrictEqual(flow.contract, expectedFlowContract)) {
        issues.push({ code: 'deterministic-contract-mismatch', owner_id: flow.flow_id });
        issues.push({ code: 'misattributed-facet-provenance', owner_id: flow.flow_id });
      }
    }
  }

  for (const child of cas.children || []) issues.push(...validateCas(child));
  return issues;
}

export function validateUnderstandingContractIntegrity(cas: CASOutput): UnderstandingContractIntegrityIssue[] {
  return validateCas(cas);
}

export function assertUnderstandingContractIntegrity(cas: CASOutput): void {
  const issues = validateUnderstandingContractIntegrity(cas);
  if (issues.length > 0) {
    throw new Error(`ICELOT integrity failed: ${JSON.stringify(issues.slice(0, 20))}`);
  }
}
