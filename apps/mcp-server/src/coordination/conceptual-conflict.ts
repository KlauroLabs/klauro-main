



























export type SymbolChangeKind =
  | 'signature'
  | 'return_type'
  | 'nullability'
  | 'param'
  | 'rename'
  | 'split'
  | 'move'
  | 'delete'
  | 'body'
  | 'add';

export interface SymbolChangeShape {
  signature?: string;
  return_type?: string;
  nullable?: boolean;
  name?: string;

  split_into?: string[];


  body_tags?: BodyTag[];
}

export type BodyTag = 'early-return' | 'guard' | 'appends-after' | 'other';

export interface SymbolChange {
  symbol_id: string;
  name: string;
  file: string;
  change_kind: SymbolChangeKind;
  before?: SymbolChangeShape;
  after?: SymbolChangeShape;
}

export interface AgentInFlightState {
  agent_id: string;
  intent: string;
  changes: SymbolChange[];
}

export type ConceptualConflictKind =
  | 'contract-divergence'
  | 'duplicate-work'
  | 'structural-divergence'
  | 'invariant-conflict'
  | 'behavior-drift';

export interface ConceptualConflict {
  kind: ConceptualConflictKind;
  severity: 'high' | 'medium' | 'low';
  agents: string[];
  symbol: string;










  symbol_ids?: string[];
  file?: string;

  explanation: string;

  passes_textual_merge: boolean;
  evidence: string[];
}







export interface ConflictCasNode {
  id: string;
  name: string;
}

export interface ConflictCasEdge {
  source: string;
  target: string;
  type: string;
}

export interface ConflictCas {
  nodes: ConflictCasNode[];
  edges: ConflictCasEdge[];
}







export interface InvariantAssertion {
  symbol: string;
  invariant: 'idempotent' | 'immutable' | 'non-null' | string;
}




export type InvariantInterpreter = (intent: string, symbol: string) => InvariantAssertion[];







function getCallerIds(cas: ConflictCas, symbolNameOrId: string): string[] {
  const nodesById = new Map(cas.nodes.map((n) => [n.id, n]));
  const targetIds = new Set<string>();
  for (const n of cas.nodes) {
    if (n.id === symbolNameOrId || n.name === symbolNameOrId) targetIds.add(n.id);
  }
  if (targetIds.size === 0) targetIds.add(symbolNameOrId);

  const callerIds = new Set<string>();
  for (const edge of cas.edges) {
    if (edge.type !== 'calls') continue;
    if (targetIds.has(edge.target)) callerIds.add(edge.source);
  }


  const resolved = new Set<string>();
  for (const id of callerIds) {
    resolved.add(id);
    const node = nodesById.get(id);
    if (node) resolved.add(node.name);
  }
  return [...resolved];
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

const CONTRACT_KINDS = new Set<SymbolChangeKind>(['signature', 'return_type', 'nullability', 'param']);
const STRUCTURAL_KINDS = new Set<SymbolChangeKind>(['rename', 'split', 'move', 'delete']);

function contractShapeChanged(before?: SymbolChangeShape, after?: SymbolChangeShape): string[] {
  const notes: string[] = [];
  if (!before || !after) return notes;
  if (before.signature !== undefined && after.signature !== undefined && before.signature !== after.signature) {
    notes.push(`signature: ${before.signature} -> ${after.signature}`);
  }
  if (before.return_type !== undefined && after.return_type !== undefined && before.return_type !== after.return_type) {
    notes.push(`return_type: ${before.return_type} -> ${after.return_type}`);
  }
  if (before.nullable !== undefined && after.nullable !== undefined && before.nullable !== after.nullable) {
    notes.push(`nullable: ${before.nullable} -> ${after.nullable}`);
  }
  return notes;
}














function detectContractDivergence(
  states: AgentInFlightState[],
  cas: ConflictCas
): ConceptualConflict[] {
  const findings: ConceptualConflict[] = [];
  const seen = new Set<string>();

  for (const agentA of states) {
    for (const changeA of agentA.changes) {
      if (!CONTRACT_KINDS.has(changeA.change_kind)) continue;
      const shapeNotes = contractShapeChanged(changeA.before, changeA.after);
      if (shapeNotes.length === 0) continue;

      const callerIds = new Set(getCallerIds(cas, changeA.symbol_id));
      if (callerIds.size === 0) {
        for (const c of getCallerIds(cas, changeA.name)) callerIds.add(c);
      }

      for (const agentB of states) {
        if (agentB.agent_id === agentA.agent_id) continue;
        for (const changeB of agentB.changes) {
          const touchesCallSite =
            callerIds.has(changeB.symbol_id) || callerIds.has(changeB.name);
          if (!touchesCallSite) continue;

          const key = pairKey(agentA.agent_id, agentB.agent_id) + '|' + changeA.symbol_id + '|' + changeB.symbol_id;
          if (seen.has(key)) continue;
          seen.add(key);

          findings.push({
            kind: 'contract-divergence',
            severity: 'high',
            agents: [agentA.agent_id, agentB.agent_id],
            symbol: changeA.symbol_id,
            symbol_ids: [changeA.symbol_id, changeB.symbol_id],
            file: changeA.file,
            explanation:
              `${agentA.agent_id} changed ${changeA.name}'s contract (${shapeNotes.join(', ')}) ` +
              `while ${agentB.agent_id} is concurrently editing ${changeB.name}, a caller of ${changeA.name}, ` +
              `which likely still assumes the OLD contract. Each diff is locally valid and merges cleanly; ` +
              `together they are incoherent.`,
            passes_textual_merge: true,
            evidence: [
              `contract_change:${changeA.symbol_id}:${shapeNotes.join('|')}`,
              `caller_edit:${changeB.symbol_id}`,
              `cas_edge:calls:${changeB.symbol_id}->${changeA.symbol_id}`,
            ],
          });
        }
      }
    }
  }
  return findings;
}





const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'add', 'in', 'on', 'with',
  'is', 'are', 'be', 'this', 'that', 'it', 'as', 'at', 'by', 'so', 'we',
]);

function intentTokens(intent: string): Set<string> {
  return new Set(
    intent
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

function intentOverlaps(a: string, b: string): boolean {
  const ta = intentTokens(a);
  const tb = intentTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const smaller = Math.min(ta.size, tb.size);
  return smaller > 0 && shared / smaller >= 0.34;
}





function detectDuplicateWork(states: AgentInFlightState[]): ConceptualConflict[] {
  const findings: ConceptualConflict[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < states.length; i++) {
    for (let j = i + 1; j < states.length; j++) {
      const a = states[i];
      const b = states[j];
      for (const changeA of a.changes) {
        for (const changeB of b.changes) {
          const sameSymbol = changeA.symbol_id === changeB.symbol_id;
          const bothAdd =
            changeA.change_kind === 'add' &&
            changeB.change_kind === 'add' &&
            changeA.name === changeB.name;
          if (!sameSymbol && !bothAdd) continue;
          if (!intentOverlaps(a.intent, b.intent)) continue;

          const key = pairKey(a.agent_id, b.agent_id) + '|' + changeA.symbol_id + '|' + changeB.symbol_id;
          if (seen.has(key)) continue;
          seen.add(key);

          findings.push({
            kind: 'duplicate-work',
            severity: 'medium',
            agents: [a.agent_id, b.agent_id],
            symbol: changeA.symbol_id,
            symbol_ids: [changeA.symbol_id, changeB.symbol_id],
            file: changeA.file,
            explanation:
              `${a.agent_id} ("${a.intent}") and ${b.agent_id} ("${b.intent}") are both ` +
              `${bothAdd ? 'adding' : 'changing'} ${changeA.name} with overlapping intent — the fleet ` +
              `is likely doing the same work twice.`,
            passes_textual_merge: true,
            evidence: [
              `shared_symbol:${changeA.symbol_id}`,
              `intent_overlap:${a.agent_id}~${b.agent_id}`,
            ],
          });
        }
      }
    }
  }
  return findings;
}










function detectStructuralDivergence(states: AgentInFlightState[]): ConceptualConflict[] {
  const findings: ConceptualConflict[] = [];
  const seen = new Set<string>();

  for (const agentA of states) {
    for (const changeA of agentA.changes) {
      if (!STRUCTURAL_KINDS.has(changeA.change_kind)) continue;



      const dissolvedNames = new Set<string>([changeA.name]);
      if (changeA.before?.name) dissolvedNames.add(changeA.before.name);

      for (const agentB of states) {
        if (agentB.agent_id === agentA.agent_id) continue;
        for (const changeB of agentB.changes) {
          if (changeB.change_kind !== 'add') continue;



          const referencesOld =
            changeB.symbol_id === changeA.symbol_id ||
            (changeB.after?.signature ? [...dissolvedNames].some((n) => changeB.after!.signature!.includes(n)) : false);
          if (!referencesOld) continue;

          const key = pairKey(agentA.agent_id, agentB.agent_id) + '|' + changeA.symbol_id + '|' + changeB.symbol_id;
          if (seen.has(key)) continue;
          seen.add(key);

          findings.push({
            kind: 'structural-divergence',
            severity: 'high',
            agents: [agentA.agent_id, agentB.agent_id],
            symbol: changeA.symbol_id,
            symbol_ids: [changeA.symbol_id, changeB.symbol_id],
            file: changeA.file,
            explanation:
              `${agentA.agent_id} is ${changeA.change_kind === 'split' ? 'splitting' : changeA.change_kind === 'delete' ? 'deleting' : changeA.change_kind === 'move' ? 'moving' : 'renaming'} ` +
              `${changeA.name}${changeA.after?.split_into?.length ? ` into ${changeA.after.split_into.join(', ')}` : ''}, ` +
              `while ${agentB.agent_id} adds ${changeB.name}, which references the OLD structure ` +
              `("${changeA.name}") that A is dissolving. Each diff merges cleanly; the composed result ` +
              `references a structure that no longer exists in the intended shape.`,
            passes_textual_merge: true,
            evidence: [
              `structural_change:${changeA.change_kind}:${changeA.symbol_id}`,
              `new_reference_to_old_structure:${changeB.symbol_id}`,
            ],
          });
        }
      }
    }
  }
  return findings;
}














function detectBehaviorDrift(states: AgentInFlightState[]): ConceptualConflict[] {
  const findings: ConceptualConflict[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < states.length; i++) {
    for (let j = i + 1; j < states.length; j++) {
      const a = states[i];
      const b = states[j];
      for (const changeA of a.changes) {
        if (changeA.change_kind !== 'body') continue;
        const tagsA = changeA.after?.body_tags ?? [];
        const addsGuard = tagsA.includes('early-return') || tagsA.includes('guard');
        if (!addsGuard) continue;

        for (const changeB of b.changes) {
          if (changeB.change_kind !== 'body') continue;
          if (changeB.symbol_id !== changeA.symbol_id) continue;
          const tagsB = changeB.after?.body_tags ?? [];
          if (!tagsB.includes('appends-after')) continue;

          const key = pairKey(a.agent_id, b.agent_id) + '|' + changeA.symbol_id;
          if (seen.has(key)) continue;
          seen.add(key);

          findings.push({
            kind: 'behavior-drift',
            severity: 'medium',
            agents: [a.agent_id, b.agent_id],
            symbol: changeA.symbol_id,
            symbol_ids: [changeA.symbol_id, changeB.symbol_id],
            file: changeA.file,
            explanation:
              `${a.agent_id} adds an early-return/guard to ${changeA.name}'s body while ${b.agent_id} ` +
              `appends code assumed to run unconditionally after it. Composed, B's code may become dead ` +
              `on the path A now short-circuits. HEURISTIC (tag-based body diffing) — confirm by reading ` +
              `both diffs; this detector does not parse control flow.`,
            passes_textual_merge: true,
            evidence: [
              `body_tag:${a.agent_id}:early-return-or-guard`,
              `body_tag:${b.agent_id}:appends-after`,
            ],
          });
        }
      }
    }
  }
  return findings;
}













function detectInvariantConflicts(
  states: AgentInFlightState[],
  interpreter?: InvariantInterpreter
): ConceptualConflict[] {
  if (!interpreter) return [];
  const findings: ConceptualConflict[] = [];
  const seen = new Set<string>();

  for (const agentA of states) {
    for (const changeA of agentA.changes) {
      const assertions = interpreter(agentA.intent, changeA.name) ?? [];
      if (assertions.length === 0) continue;

      for (const agentB of states) {
        if (agentB.agent_id === agentA.agent_id) continue;
        for (const changeB of agentB.changes) {
          if (changeB.symbol_id !== changeA.symbol_id) continue;
          const bAssertsSame = (interpreter(agentB.intent, changeB.name) ?? []).some((x) =>
            assertions.some((y) => y.invariant === x.invariant)
          );
          if (bAssertsSame) continue;

          for (const assertion of assertions) {
            const key = pairKey(agentA.agent_id, agentB.agent_id) + '|' + changeA.symbol_id + '|' + assertion.invariant;
            if (seen.has(key)) continue;
            seen.add(key);
            findings.push({
              kind: 'invariant-conflict',
              severity: 'medium',
              agents: [agentA.agent_id, agentB.agent_id],
              symbol: changeA.symbol_id,
              symbol_ids: [changeA.symbol_id, changeB.symbol_id],
              file: changeA.file,
              explanation:
                `${agentA.agent_id}'s intent asserts ${changeA.name} is now "${assertion.invariant}", ` +
                `but ${agentB.agent_id} concurrently changes the same symbol without upholding that ` +
                `invariant. AI-interpreted (intent-level), not structurally verified.`,
              passes_textual_merge: true,
              evidence: [`invariant_assertion:${assertion.invariant}`, `concurrent_change:${changeB.symbol_id}`],
            });
          }
        }
      }
    }
  }
  return findings;
}





export interface DetectConceptualConflictsOptions {


  invariantInterpreter?: InvariantInterpreter;
}







export function detectConceptualConflicts(
  states: AgentInFlightState[],
  cas: ConflictCas,
  options: DetectConceptualConflictsOptions = {}
): ConceptualConflict[] {
  return [
    ...detectContractDivergence(states, cas),
    ...detectDuplicateWork(states),
    ...detectStructuralDivergence(states),
    ...detectBehaviorDrift(states),
    ...detectInvariantConflicts(states, options.invariantInterpreter),
  ];
}
