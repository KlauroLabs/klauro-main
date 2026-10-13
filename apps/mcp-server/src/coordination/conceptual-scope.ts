




































import type { FlowConcept, FlowStep } from '../../../../packages/analyzer-core/src/analyzer/core/flow-concepts';
import type { ConceptualCoordinate } from './types';





interface StepIndexEntry {
  flow: FlowConcept;
  step: FlowStep;
}


export interface ConceptIndex {

  byFunctionId: Map<string, StepIndexEntry[]>;


  byEntryPoint: Map<string, FlowConcept>;
  byFile: Map<string, string[]>;
  flows: FlowConcept[];
}

export interface FunctionSource {
  id: string;
  source?: { file?: string };
}



export function buildConceptIndex(flows: FlowConcept[], nodes: FunctionSource[] = []): ConceptIndex {
  const byFunctionId = new Map<string, StepIndexEntry[]>();
  const byEntryPoint = new Map<string, FlowConcept>();
  const byFile = new Map<string, string[]>();

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

  for (const node of nodes) {
    const file = node.source?.file;
    if (!file || !byFunctionId.has(node.id)) continue;
    const held = byFile.get(normalizedPath(file)) ?? [];
    held.push(node.id);
    byFile.set(normalizedPath(file), held);
  }

  return { byFunctionId, byEntryPoint, byFile, flows };
}

function normalizedPath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function functionsInPath(claimed: string, index: ConceptIndex): string[] {
  const wanted = normalizedPath(claimed).replace(/\/$/, '');
  const found: string[] = [];
  for (const [file, functionIds] of index.byFile) {
    if (file === wanted || file.endsWith(`/${wanted}`) || wanted.endsWith(`/${file}`) || file.startsWith(`${wanted}/`)) {
      found.push(...functionIds);
    }
  }
  return found;
}






function tokenMatchesFunction(token: string, functionId: string): boolean {
  if (token === functionId) return true;



  const tail = functionId.split(/[:./]/).pop();
  return !!tail && tail === token;
}












export function deriveConceptualCoordinates(
  claim: { scope: { paths: string[]; symbols: string[] } },
  index: ConceptIndex
): ConceptualCoordinate[] {
  const found = new Map<string, ConceptualCoordinate>();

  const matched = new Set<string>();
  for (const token of [...claim.scope.symbols, ...claim.scope.paths]) {
    for (const functionId of index.byFunctionId.keys()) {
      if (tokenMatchesFunction(token, functionId)) matched.add(functionId);
    }
  }
  for (const path of claim.scope.paths) {
    for (const functionId of functionsInPath(path, index)) matched.add(functionId);
  }
  for (const functionId of matched) {
    for (const { flow, step } of index.byFunctionId.get(functionId) ?? []) {
      const key = `${flow.flow_id}::${step.step_id}`;
      if (found.has(key)) continue;
      found.set(key, {
        flow_id: flow.flow_id,
        step_id: step.step_id,
        capability_id: flow.capability_id ?? flow.capability_relationships?.find(relationship => relationship.role === 'primary')?.capability_id,
        entities: flow.entities.length ? flow.entities : undefined,
        source: 'derived',
      });
    }
  }

  return [...found.values()];
}




export function deriveConceptualCoordinate(
  claim: { scope: { paths: string[]; symbols: string[] } },
  index: ConceptIndex
): ConceptualCoordinate | undefined {
  return deriveConceptualCoordinates(claim, index)[0];
}





export type ConceptualScopeVerdict = 'unrelated' | 'awareness' | 'conceptual_conflict';

export interface ConceptualScopeComparison {
  verdict: ConceptualScopeVerdict;

  reason: string;
  shared_flow_id?: string;
  shared_step_id?: string;
  shared_entities?: string[];
}




















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





interface ScopeLike {
  paths: string[];
  symbols: string[];
  concept?: ConceptualCoordinate;
}









export function withDerivedConcept<T extends { scope: ScopeLike }>(
  claim: T,
  index: ConceptIndex
): T {
  if (claim.scope.concept) return claim;
  const derived = deriveConceptualCoordinate(claim, index);
  if (!derived) return claim;
  return { ...claim, scope: { ...claim.scope, concept: derived } };
}








export function compareClaimsConceptually(
  claimA: { scope: ScopeLike },
  claimB: { scope: ScopeLike },
  index?: ConceptIndex
): ConceptualScopeComparison {
  const coordA = claimA.scope.concept ?? (index ? deriveConceptualCoordinate(claimA, index) : undefined);
  const coordB = claimB.scope.concept ?? (index ? deriveConceptualCoordinate(claimB, index) : undefined);
  return compareConceptualCoordinates(coordA, coordB);
}
