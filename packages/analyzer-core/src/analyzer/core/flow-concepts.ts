import type {
  CASOutput,
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASEntityLineage,
  SystemCapability,
} from '../../types/cas.types';
import { buildTerminalSignal } from './terminal-signal';

/**
 * FLOW CONCEPTS — the FLOW -> STEP tier of the conceptual understanding layer
 * (docs/SPEC-CONCEPTUAL-LAYER.md). Capabilities (already computed — CAS/WAS
 * product_map/system_capabilities) answer "what does it do". Flows answer
 * "how does a request/job move through it, step by step" — an ordered set of
 * semantic STEPS (Validate -> Charge -> Persist -> Notify), each carrying the
 * same I/L/S/O + Constraints contract used everywhere else in the product
 * (get_interface_signature's join), aggregated flow-level.
 *
 * DETERMINISTIC-FIRST: this module composes facts CAS already has —
 * entry_points (flow roots), call edges + method_calls (the chain),
 * exit_points + data_lineage (side-effect character, used both to segment
 * and to fill side_effects), data_entities.invariants + entry_point
 * validation/security guards (constraints), system_capabilities.operations
 * (capability linkage). AI is not used for facts; `opts.nameStep` is the only
 * seam, and it is fully inert when omitted.
 */

export interface ILSOContract {
  input: string[];
  logic: string;
  side_effects: {
    state_changes: string[];
    external_integrations: string[];
  };
  output: string[];
  /** Business rules / invariants / guards enforced here — from guard clauses,
   *  validation, assertions, gating conditionals. Deterministic extraction
   *  only; never fabricated. Empty when none could be derived. */
  constraints: string[];
}

export interface FlowStep {
  step_id: string;
  order: number;
  name: string;
  description: string;
  contract: ILSOContract;
  /** 1:1, 1:many, or a SUB-SECTION of a single function (section present
   *  when the step is only part of one function's body). */
  functions: Array<{
    function_id: string;
    section?: { start_line: number; end_line: number; label?: string };
  }>;
  /** Data entities this step's own functions read or write (by name), from
   *  data_lineage/data_entities.lifecycle membership restricted to just this
   *  step's nodes — the same derivation as FlowConcept.entities, scoped
   *  down. Empty (not omitted) when this step genuinely touches no known
   *  entity. */
  entities: string[];
}

export interface FlowConcept {
  flow_id: string;
  name: string;
  intent: string;
  entry_point: string;
  /** The capability this flow realizes, if derivable from CAS
   *  system_capabilities.operations[].entry_point_id. Omitted (not
   *  fabricated) when no capability references this entry point. */
  capability_id?: string;
  /** Data entities the flow's functions read or write (by name), from
   *  data_lineage membership across all of the flow's functions. */
  entities: string[];
  /** Flow-level I/L/S/O + Constraints, aggregated over steps. */
  contract: ILSOContract;
  steps: FlowStep[];
  /** Honest caveats about this specific flow's segmentation/derivation. */
  gaps?: string[];
}

export interface ComputeFlowConceptsOptions {
  /** Bound on forward call-chain traversal depth from the entry point. */
  maxDepth?: number;
  /** Cap on number of distinct functions traced per flow (dedupe applies). */
  maxFunctionsPerFlow?: number;
  /** Cap on number of flows returned (one per entry point, by default all). */
  maxFlows?: number;
  /** Restrict to entry points matching this id, name, or route path substring. */
  target?: string;
  /**
   * Optional AI/naming hook: given a deterministic step (already named),
   * may return a replacement name/description. Never called for anything
   * else — segmentation, I/L/S/O aggregation, constraint extraction, and
   * function refs are always deterministic. Fully inert (no-op) when
   * omitted.
   */
  nameStep?: (step: FlowStep, ctx: { flowEntryPoint: CASEntryPoint }) => { name?: string; description?: string } | undefined;
}

type StepCharacter = 'validate' | 'logic' | 'persist' | 'external' | 'respond';

interface ChainNode {
  node: CASNode;
  depth: number;
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_FUNCTIONS = 40;

const TRACEABLE_NODE_TYPES = new Set([
  'function', 'method', 'controller', 'handler', 'route', 'resolver', 'gateway',
  'service', 'usecase', 'repository', 'dao',
  // frontend / SPA route->view chains (reached via 'renders'/'uses' edges):
  // a react_route renders a functional_component/component, which uses hook
  // nodes (useQuery/useMutation are the actual data-fetch/persist step —
  // this is where the flow's real side effects live in a React app).
  'react_route', 'component', 'functional_component', 'class_component', 'page', 'view',
  'hook_usage', 'hook',
]);

const VALIDATE_NAME_RE = /\b(validate|guard|check|assert|sanitize|verify|authoriz|authentic)/i;
const RESPOND_NAME_RE = /\b(respond|render|reply|serialize|format|toJson|toResponse|present)/i;

/**
 * Classify a function node's dominant side-effect character using facts
 * already on the CAS: its own exit_points (by source_node), whether it
 * writes/reads a data_lineage entity, and a light name-based fallback for
 * validate/respond framing (the same kind of name-signal capability-detector
 * already relies on for semantic grouping — not a new heuristic category).
 */
function classifyStepCharacter(
  node: CASNode,
  exitPointsByNode: Map<string, CASExitPoint[]>,
  lineageByNode: Map<string, { writes: CASEntityLineage[]; reads: CASEntityLineage[] }>
): StepCharacter {
  const ownExits = exitPointsByNode.get(node.id) || [];
  const lineage = lineageByNode.get(node.id);

  if (ownExits.some(ep => ep.type === 'database' || ep.type === 'cache')) return 'persist';
  if (lineage && lineage.writes.length > 0) return 'persist';
  if (ownExits.some(ep => ['api', 'webhook', 'sdk', 'message', 'event', 'analytics'].includes(ep.type))) return 'external';
  if (VALIDATE_NAME_RE.test(node.name)) return 'validate';
  if (RESPOND_NAME_RE.test(node.name)) return 'respond';
  return 'logic';
}

const CHARACTER_LABEL: Record<StepCharacter, string> = {
  validate: 'Validate',
  logic: 'Process',
  persist: 'Persist',
  external: 'Call',
  respond: 'Respond',
};

/** Layer used as a secondary segmentation boundary (in addition to side-effect
 *  character): a jump between architectural layers is itself a step boundary
 *  even when the side-effect character doesn't change (e.g. controller ->
 *  service, both "logic", still worth separating as distinct semantic units
 *  when the node `category`/`type` signals a layer change). */
export function layerOf(node: CASNode): string {
  if (node.category) return node.category;
  if (['controller', 'handler', 'route', 'resolver', 'gateway', 'react_route'].includes(node.type)) return 'entry';
  if (['repository', 'dao', 'model'].includes(node.type)) return 'data';
  if (['service', 'usecase', 'interactor'].includes(node.type)) return 'business';
  if (['component', 'functional_component', 'class_component', 'page', 'view'].includes(node.type)) return 'presentation';
  if (['hook_usage', 'hook'].includes(node.type)) return 'business';
  return 'unknown';
}

/**
 * Trace the forward call chain from an entry point's handler node, bounded
 * by depth, deduped by node id (a diamond-shaped call graph must not be
 * walked twice or produce duplicate steps).
 */
function traceForwardChain(
  cas: CASOutput,
  rootId: string,
  maxDepth: number,
  maxFunctions: number
): ChainNode[] {
  const nodesById = new Map(cas.nodes.map(n => [n.id, n]));
  // Traversable edge kinds: function-call edges (backend/service chains) AND
  // 'renders'/'uses' (frontend route -> component chains, e.g. React Router
  // handler nodes are 'react_route' entities connected to their view via
  // 'renders', not a call edge). Both are "how the flow moves forward" —
  // segmentation still only fires on side-effect/layer character, so this
  // does not change what counts as a step boundary, only what is reachable.
  const TRAVERSABLE_EDGE_TYPES = new Set(['renders', 'uses']);
  const outgoingEdges = new Map<string, CASEdge[]>();
  for (const edge of cas.edges) {
    const traversable = edge.type === 'calls' || edge.type === 'invokes' || edge.type.includes('call') || TRAVERSABLE_EDGE_TYPES.has(edge.type);
    if (!traversable) continue;
    if (!outgoingEdges.has(edge.source)) outgoingEdges.set(edge.source, []);
    outgoingEdges.get(edge.source)!.push(edge);
  }
  const outgoingMethodCalls = new Map<string, string[]>();
  for (const mc of cas.method_calls || []) {
    if (!mc.caller_node || !mc.target_node) continue;
    if (!outgoingMethodCalls.has(mc.caller_node)) outgoingMethodCalls.set(mc.caller_node, []);
    outgoingMethodCalls.get(mc.caller_node)!.push(mc.target_node);
  }

  const visited = new Set<string>([rootId]);
  const chain: ChainNode[] = [];
  const rootNode = nodesById.get(rootId);
  if (rootNode) chain.push({ node: rootNode, depth: 0 });

  // BFS to preserve call-order-ish breadth-first ordering; ties broken by
  // discovery order (stable, deterministic).
  let frontier: string[] = [rootId];
  let depth = 0;
  while (frontier.length > 0 && depth < maxDepth && chain.length < maxFunctions) {
    const next: string[] = [];
    for (const id of frontier) {
      const targets = [
        ...(outgoingEdges.get(id) || []).map(e => e.target),
        ...(outgoingMethodCalls.get(id) || []),
      ];
      for (const targetId of targets) {
        if (visited.has(targetId)) continue;
        const targetNode = nodesById.get(targetId);
        if (!targetNode) continue;
        // only trace through callable/renderable node types — skip data/type
        // nodes that are call-graph noise, not semantic flow steps. Includes
        // frontend route/component types (react_route, component, page) so
        // SPA route->view chains are traceable via 'renders'/'uses' edges,
        // not just backend call chains.
        if (!TRACEABLE_NODE_TYPES.has(targetNode.type)) continue;
        visited.add(targetId);
        next.push(targetId);
        chain.push({ node: targetNode, depth: depth + 1 });
        if (chain.length >= maxFunctions) break;
      }
      if (chain.length >= maxFunctions) break;
    }
    frontier = next;
    depth++;
  }

  return chain;
}

/**
 * Segment a traced chain into cohesive steps: draw a boundary whenever the
 * side-effect CHARACTER changes, or the architectural LAYER changes. A run
 * of contiguous nodes with the same (character, layer) pair is one step.
 */
function segmentIntoSteps(
  chain: ChainNode[],
  exitPointsByNode: Map<string, CASExitPoint[]>,
  lineageByNode: Map<string, { writes: CASEntityLineage[]; reads: CASEntityLineage[] }>
): Array<{ character: StepCharacter; layer: string; nodes: CASNode[] }> {
  const segments: Array<{ character: StepCharacter; layer: string; nodes: CASNode[] }> = [];

  for (const { node } of chain) {
    const character = classifyStepCharacter(node, exitPointsByNode, lineageByNode);
    const layer = layerOf(node);
    const last = segments[segments.length - 1];
    if (last && last.character === character && last.layer === layer) {
      last.nodes.push(node);
    } else {
      segments.push({ character, layer, nodes: [node] });
    }
  }

  return segments;
}

/**
 * SUB-SECTION detection: within a single large function whose body spans
 * multiple side-effect phases, split it into contiguous line-range sections
 * using guard-clause / assignment / call boundaries visible in raw source —
 * a lightweight, deterministic line-scan (no re-parse), only attempted when
 * the node's own raw source is present and long enough to plausibly contain
 * more than one phase. Conservative: emits at most a validate-prefix split
 * (early guard clauses) followed by the remaining body, since that is the
 * one sub-section boundary derivable from text alone without a real AST
 * walk of the function body. Never fabricates line ranges — omitted when
 * `source.raw`/`source.line`/`source.end_line` aren't all present.
 */
function detectSubSections(
  node: CASNode
): Array<{ start_line: number; end_line: number; label: string }> | undefined {
  const raw = node.source?.raw;
  const startLine = node.source?.line;
  const endLine = node.source?.end_line;
  if (!raw || !startLine || !endLine || endLine <= startLine) return undefined;
  if (endLine - startLine < 6) return undefined; // too small to sub-section meaningfully

  const lines = raw.split('\n');
  if (lines.length < 6) return undefined;

  // find the last contiguous leading guard-clause line (if/throw/return-early
  // pattern) starting from the top of the body.
  let lastGuardLineIdx = -1;
  const GUARD_RE = /\b(if|throw|require|assert)\s*\(/;
  const RETURN_EARLY_RE = /\breturn\b/;
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    const line = lines[i];
    if (GUARD_RE.test(line) || (RETURN_EARLY_RE.test(line) && i < 15)) {
      lastGuardLineIdx = i;
    } else if (lastGuardLineIdx >= 0 && line.trim() !== '' && !line.trim().startsWith('}') && !line.trim().startsWith('//')) {
      // first substantive non-guard line after guards seen — stop scanning.
      break;
    }
  }
  if (lastGuardLineIdx < 0 || lastGuardLineIdx >= lines.length - 2) return undefined;

  const guardEndLine = startLine + lastGuardLineIdx;
  return [
    { start_line: startLine, end_line: guardEndLine, label: 'guard clauses' },
    { start_line: guardEndLine + 1, end_line: endLine, label: 'body' },
  ];
}

/** Dominant terminal-entity name touched by a step's functions, via
 *  data_lineage writer/reader membership — used only for step naming. */
function dominantEntityForNodes(
  nodeIds: Set<string>,
  lineage: CASEntityLineage[]
): string | undefined {
  const counts = new Map<string, number>();
  for (const entry of lineage) {
    const touches = [...entry.writers, ...entry.readers].some(a => nodeIds.has(a.node_id));
    if (touches) counts.set(entry.entity_name, (counts.get(entry.entity_name) || 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

function externalServiceForNodes(nodeIds: Set<string>, exitPointsByNode: Map<string, CASExitPoint[]>): string | undefined {
  for (const id of nodeIds) {
    const eps = exitPointsByNode.get(id) || [];
    const ext = eps.find(ep => ['api', 'webhook', 'sdk'].includes(ep.type));
    if (ext) return ext.target?.service_id || ext.target?.sdk || ext.name;
  }
  return undefined;
}

function nameStepDeterministically(
  character: StepCharacter,
  nodes: CASNode[],
  exitPointsByNode: Map<string, CASExitPoint[]>,
  lineage: CASEntityLineage[]
): { name: string; description: string } {
  const nodeIds = new Set(nodes.map(n => n.id));
  const label = CHARACTER_LABEL[character];

  if (character === 'persist') {
    const entity = dominantEntityForNodes(nodeIds, lineage);
    const name = entity ? `Persist ${entity}` : 'Persist Data';
    return { name, description: entity
      ? `Writes ${entity} to storage (${nodes.map(n => n.name).join(', ')}).`
      : `Persists state via ${nodes.map(n => n.name).join(', ')}.` };
  }
  if (character === 'external') {
    const service = externalServiceForNodes(nodeIds, exitPointsByNode);
    const name = service ? `Call ${service}` : 'Call External Service';
    return { name, description: service
      ? `Calls external service ${service} via ${nodes.map(n => n.name).join(', ')}.`
      : `Reaches outside the process via ${nodes.map(n => n.name).join(', ')}.` };
  }
  if (character === 'validate') {
    return { name: 'Validate Request', description: `Guards/validates input via ${nodes.map(n => n.name).join(', ')}.` };
  }
  if (character === 'respond') {
    return { name: 'Respond', description: `Formats/returns the result via ${nodes.map(n => n.name).join(', ')}.` };
  }
  const entity = dominantEntityForNodes(nodeIds, lineage);
  const name = entity ? `Process ${entity}` : `${label} (${nodes[0]?.name || 'step'})`;
  return { name, description: `Core logic via ${nodes.map(n => n.name).join(', ')}.` };
}

function buildLineageIndex(cas: CASOutput): Map<string, { writes: CASEntityLineage[]; reads: CASEntityLineage[] }> {
  const index = new Map<string, { writes: CASEntityLineage[]; reads: CASEntityLineage[] }>();
  for (const entry of cas.data_lineage || []) {
    for (const w of entry.writers) {
      if (!index.has(w.node_id)) index.set(w.node_id, { writes: [], reads: [] });
      index.get(w.node_id)!.writes.push(entry);
    }
    for (const r of entry.readers) {
      if (!index.has(r.node_id)) index.set(r.node_id, { writes: [], reads: [] });
      index.get(r.node_id)!.reads.push(entry);
    }
  }
  return index;
}

function buildExitPointIndex(cas: CASOutput): Map<string, CASExitPoint[]> {
  const index = new Map<string, CASExitPoint[]>();
  for (const ep of cas.exit_points || []) {
    if (!index.has(ep.source_node)) index.set(ep.source_node, []);
    index.get(ep.source_node)!.push(ep);
  }
  return index;
}

/** Constraints from a node's own raw source: guard clauses, throws, asserts,
 *  and require()-style gating conditionals, translated into a plain-English
 *  business rule where the condition is legible, or the raw guarded
 *  condition text otherwise. Deterministic text-pattern extraction only —
 *  never invents rules that aren't textually present. */
function extractConstraintsFromSource(node: CASNode): string[] {
  const raw = node.source?.raw;
  if (!raw) return [];
  const constraints: string[] = [];

  // require(expr) / assert(expr) -> "expr" as a stated invariant.
  const callGuardRe = /\b(?:require|assert)\s*\(\s*([^,)]+?)\s*(?:,|\))/g;
  let m: RegExpExecArray | null;
  while ((m = callGuardRe.exec(raw))) {
    const expr = m[1].trim();
    if (expr) constraints.push(`must satisfy: ${expr}`);
  }

  // if (!cond) throw ... -> "cond must hold" (negated guard -> positive rule).
  const negatedThrowRe = /if\s*\(\s*!\s*([^)]+?)\s*\)\s*(?:\{[^}]*)?throw/g;
  while ((m = negatedThrowRe.exec(raw))) {
    const cond = m[1].trim();
    if (cond) constraints.push(`must hold: ${cond}`);
  }

  // if (cond) throw ... (direct gating conditional guarding via throw).
  const directThrowRe = /if\s*\(\s*([^)!][^)]*?)\s*\)\s*(?:\{[^}]*)?throw/g;
  while ((m = directThrowRe.exec(raw))) {
    const cond = m[1].trim();
    if (cond && !constraints.some(c => c.includes(cond))) constraints.push(`must NOT hold: ${cond}`);
  }

  return [...new Set(constraints)];
}

/** Constraints derivable from CAS structural facts rather than raw-source
 *  text: entry-point security guards/roles, entry-point input validation
 *  rules, and data-entity invariants whose enforced_by includes a node in
 *  this step. All are already-computed facts (never inferred here). */
function extractStructuralConstraints(
  nodeIds: Set<string>,
  cas: CASOutput,
  ownEntryPoints: CASEntryPoint[]
): string[] {
  const constraints: string[] = [];

  for (const ep of ownEntryPoints) {
    if (ep.security?.authenticated) constraints.push('caller must be authenticated');
    for (const role of ep.security?.authorized_roles || ep.security?.roles || []) {
      constraints.push(`caller must have role: ${role}`);
    }
    for (const guard of ep.security?.guards || []) {
      constraints.push(`guarded by: ${guard}`);
    }
    for (const rule of ep.input?.validation || []) {
      constraints.push(rule);
    }
  }

  for (const entity of cas.data_entities || []) {
    for (const inv of entity.invariants || []) {
      if (inv.enforced_by.some(id => nodeIds.has(id))) {
        constraints.push(inv.description);
      }
    }
  }

  return [...new Set(constraints)];
}

/** Build the ILSOContract for a set of functions (a step, or the whole flow
 *  when aggregating). Reuses the same fact sources getInterfaceSignature
 *  joins in query.ts: params/entry_points for input, return types +
 *  produced entities for output, exit_points + data_lineage external
 *  recipients for side_effects.external_integrations, data_lineage writes
 *  for side_effects.state_changes, and guard/validation/invariant facts for
 *  constraints — applied over a SET of functions instead of one node. */
function buildContract(
  nodes: CASNode[],
  cas: CASOutput,
  exitPointsByNode: Map<string, CASExitPoint[]>,
  entryPointsByNode: Map<string, CASEntryPoint[]>
): ILSOContract {
  const input = new Set<string>();
  const output = new Set<string>();
  const stateChanges = new Set<string>();
  const externalIntegrations = new Set<string>();
  const constraints = new Set<string>();

  const nodeIds = new Set(nodes.map(n => n.id));

  for (const node of nodes) {
    for (const p of node.signature?.parameters || []) {
      input.add(p.type ? `${p.name}: ${p.type}` : p.name);
    }
    if (node.signature?.return_type) output.add(node.signature.return_type);

    for (const ep of exitPointsByNode.get(node.id) || []) {
      const label = ep.target?.service_id || ep.target?.resource || `${ep.type}:${ep.name}`;
      if (ep.type === 'database' || ep.type === 'cache' || ep.type === 'file') {
        stateChanges.add(label);
      } else {
        externalIntegrations.add(label);
      }
    }

    for (const c of extractConstraintsFromSource(node)) constraints.add(c);
  }

  // entity-level side effects (writes/reads), named by entity rather than by
  // accessor node id, joined the same way getInterfaceSignature does via
  // data_lineage external_recipients. writes -> state_changes; recipients
  // external to the process -> external_integrations.
  for (const entry of cas.data_lineage || []) {
    const writesHere = entry.writers.some(w => nodeIds.has(w.node_id));
    const readsHere = entry.readers.some(r => nodeIds.has(r.node_id));
    if (writesHere) stateChanges.add(`${entry.entity_name} updated`);
    if (readsHere) input.add(`reads ${entry.entity_name}`);
    if (writesHere || readsHere) {
      for (const rec of entry.external_recipients) externalIntegrations.add(rec.service);
    }
  }

  const ownEntryPoints = nodes.flatMap(n => entryPointsByNode.get(n.id) || []);
  for (const c of extractStructuralConstraints(nodeIds, cas, ownEntryPoints)) constraints.add(c);

  const logicNames = nodes.map(n => n.name);
  return {
    input: [...input],
    logic: logicNames.length > 1 ? logicNames.join(' -> ') : (logicNames[0] || ''),
    side_effects: {
      state_changes: [...stateChanges],
      external_integrations: [...externalIntegrations],
    },
    output: [...output],
    constraints: [...constraints],
  };
}

/** Aggregate step contracts up to a flow-level contract: union I/O/side
 *  effects/constraints, logic = ordered step name summary. */
function aggregateFlowContract(steps: FlowStep[]): ILSOContract {
  const input = new Set<string>();
  const output = new Set<string>();
  const stateChanges = new Set<string>();
  const externalIntegrations = new Set<string>();
  const constraints = new Set<string>();

  for (const step of steps) {
    for (const v of step.contract.input) input.add(v);
    for (const v of step.contract.output) output.add(v);
    for (const v of step.contract.side_effects.state_changes) stateChanges.add(v);
    for (const v of step.contract.side_effects.external_integrations) externalIntegrations.add(v);
    for (const v of step.contract.constraints) constraints.add(v);
  }

  return {
    input: [...input],
    logic: steps.map(s => s.name).join(' -> '),
    side_effects: {
      state_changes: [...stateChanges],
      external_integrations: [...externalIntegrations],
    },
    output: [...output],
    constraints: [...constraints],
  };
}

/**
 * Data entities any node in `nodeIds` genuinely touches. Two independent CAS
 * signals are consulted — data_lineage (writers/readers keyed by node_id)
 * AND data_entities[].lifecycle (created_by/read_by/updated_by/deleted_by,
 * also keyed by node_id) — since either can carry membership the other
 * lacks depending on which analyzer pass populated it, and both already key
 * on the same node-id namespace as `cas.nodes` (verified: these are the
 * literal ids traceForwardChain visits, not a separate id scheme — no
 * cross-namespace translation is needed, only checking both sources so a
 * flow whose traced set intersects EITHER one is credited). Never attaches
 * an entity without a real touching node in `nodeIds` — no name-similarity,
 * no capability-co-membership shortcut.
 */
function entitiesForNodes(nodeIds: Set<string>, cas: CASOutput): string[] {
  const names = new Set<string>();
  for (const entry of cas.data_lineage || []) {
    const touches = [...entry.writers, ...entry.readers].some(a => nodeIds.has(a.node_id));
    if (touches) names.add(entry.entity_name);
  }
  for (const entity of cas.data_entities || []) {
    const touchers = [
      ...(entity.lifecycle?.created_by || []),
      ...(entity.lifecycle?.read_by || []),
      ...(entity.lifecycle?.updated_by || []),
      ...(entity.lifecycle?.deleted_by || []),
    ];
    if (touchers.some(id => nodeIds.has(id))) names.add(entity.name);
  }
  return [...names];
}

/** The capability this flow realizes, if a system_capabilities entry
 *  references this entry point in its operations. Never guessed by
 *  name-similarity — only a direct entry_point_id membership match.
 *  Operation entry_point_id values come in two shapes: a plain
 *  cas.entry_points[].id, or a `node:<node id>` reference straight at a
 *  handler/method node (see deriveCapabilityOperationRoots) — both are
 *  checked since a synthesized root's synthetic id won't itself appear in
 *  any operation, only its underlying node id does. */
function capabilityForEntryPoint(ep: CASEntryPoint, capabilities: SystemCapability[]): string | undefined {
  const rootNodeId = ep.handler?.node_id || ep.source_node;
  const match = capabilities.find(c => (c.operations || []).some(op =>
    op.entry_point_id === ep.id ||
    op.entry_point_id === `node:${rootNodeId}` ||
    op.entry_point_id === rootNodeId
  ));
  return match?.id;
}

/** entry_point_type values on a capability operation don't necessarily line
 *  up with CASEntryPoint's stricter type union (e.g. 'internal' isn't a
 *  valid CASEntryPoint.type) — map to the closest real type, defaulting to
 *  the always-valid 'message' for anything unrecognized rather than
 *  fabricating a category. */
const CAPABILITY_ENTRY_TYPE_MAP: Record<string, CASEntryPoint['type']> = {
  http: 'http', websocket: 'websocket', cli: 'cli', event: 'event',
  schedule: 'schedule', page: 'page', route: 'route', message: 'message',
  file: 'file', test: 'test', lifecycle: 'lifecycle',
};

/**
 * Bridge gap: `cas.entry_points` is the flow-root source, but on backend
 * services whose route/controller entry points aren't (yet, or ever, for
 * some frameworks) surfaced there, `system_capabilities[].operations[]`
 * already names the real handler/method node directly via a `node:<id>`
 * reference — the CAS's own capability-detection pass already resolved
 * "what operation this is" against real nodes, independent of entry-point
 * extraction. When such an operation's node exists in the graph and isn't
 * already covered by a real entry_points root, synthesize a minimal
 * CASEntryPoint-shaped root for it so computeFlowConcepts can trace a flow
 * from it too — this is not a guess: the node id, and the capability that
 * names it, both come straight off the CAS. The synthesized id is tagged
 * `synthflow:` so it never collides with a real entry_points id, and the
 * flow's `gaps` records that its root was synthesized this way (honest, not
 * hidden).
 */
function deriveCapabilityOperationRoots(
  cas: CASOutput,
  capabilities: SystemCapability[],
  nodesById: Map<string, CASNode>,
  existingRootNodeIds: Set<string>
): Array<{ ep: CASEntryPoint; synthesized: true }> {
  const seen = new Set<string>();
  const roots: Array<{ ep: CASEntryPoint; synthesized: true }> = [];

  for (const cap of capabilities) {
    for (const op of cap.operations || []) {
      if (!op.entry_point_id.startsWith('node:')) continue; // only the direct-node-reference shape is a candidate root; plain ids already resolve via cas.entry_points.
      const nodeId = op.entry_point_id.slice('node:'.length);
      if (existingRootNodeIds.has(nodeId)) continue; // already traceable as a real entry point — no synthetic root needed.
      if (seen.has(nodeId)) continue;
      const node = nodesById.get(nodeId);
      if (!node) continue; // capability references a node id the CAS no longer has — never fabricate a root for it.
      if (!TRACEABLE_NODE_TYPES.has(node.type) && node.type !== 'method') continue;
      seen.add(nodeId);

      const type = CAPABILITY_ENTRY_TYPE_MAP[op.entry_point_type] || 'message';
      roots.push({
        synthesized: true,
        ep: {
          id: `synthflow:${nodeId}`,
          source_node: nodeId,
          type,
          name: node.name,
          description: `Operation "${op.action}" of capability "${cap.name}" (no dedicated entry_points root — traced directly from the capability's referenced node).`,
          trigger: op.path_or_command ? { pattern: op.path_or_command } : undefined,
          handler: { node_id: nodeId, method_name: node.name },
        },
      });
    }
  }

  return roots;
}

function flowNameForEntryPoint(ep: CASEntryPoint): string {
  if (ep.trigger?.path) {
    const parts = ep.trigger.path.split('/').filter(Boolean).filter(p => !p.startsWith(':') && !p.startsWith('{'));
    const last = parts[parts.length - 1] || ep.name;
    const words = last.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    const title = words.split(' ').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    return title || ep.name;
  }
  const words = ep.name.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return words.split(' ').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || ep.name;
}

function flowIntentForEntryPoint(ep: CASEntryPoint): string {
  const method = ep.trigger?.method ? `${ep.trigger.method} ` : '';
  const path = ep.trigger?.path || ep.trigger?.pattern || ep.trigger?.event || ep.trigger?.schedule || '';
  const via = path ? `${method}${path}`.trim() : ep.name;
  return `Handles ${ep.type} entry "${via}"${ep.description ? `: ${ep.description}` : ''}`;
}

/**
 * computeFlowConcepts — one FlowConcept per (matching) entry point.
 * Deterministic-first: composes entry_points, call edges/method_calls,
 * exit_points, data_lineage, data_entities.invariants, entry_point
 * security/validation, and system_capabilities already on the CAS.
 * `opts.nameStep` is the only AI seam and is fully inert when omitted.
 */
export function computeFlowConcepts(cas: CASOutput, opts: ComputeFlowConceptsOptions = {}): FlowConcept[] {
  const maxDepth = opts.maxDepth && opts.maxDepth > 0 ? opts.maxDepth : DEFAULT_MAX_DEPTH;
  const maxFunctions = opts.maxFunctionsPerFlow && opts.maxFunctionsPerFlow > 0 ? opts.maxFunctionsPerFlow : DEFAULT_MAX_FUNCTIONS;

  const nodesById = new Map(cas.nodes.map(n => [n.id, n]));
  const capabilities = cas.system_capabilities || [];

  const realEntryPoints = cas.entry_points || [];
  const realRootNodeIds = new Set(realEntryPoints.map(ep => ep.handler?.node_id || ep.source_node));
  const synthesizedRoots = deriveCapabilityOperationRoots(cas, capabilities, nodesById, realRootNodeIds);
  const synthesizedRootIds = new Set(synthesizedRoots.map(r => r.ep.id));

  let entryPoints: CASEntryPoint[] = [...realEntryPoints, ...synthesizedRoots.map(r => r.ep)];
  if (opts.target) {
    const t = opts.target.toLowerCase();
    entryPoints = entryPoints.filter(ep =>
      ep.id.toLowerCase() === t ||
      ep.name.toLowerCase().includes(t) ||
      (ep.trigger?.path || '').toLowerCase().includes(t) ||
      ep.source_node.toLowerCase() === t
    );
  }
  if (opts.maxFlows && opts.maxFlows > 0) entryPoints = entryPoints.slice(0, opts.maxFlows);

  const exitPointsByNode = buildExitPointIndex(cas);
  const lineageByNode = buildLineageIndex(cas);

  const entryPointsByNode = new Map<string, CASEntryPoint[]>();
  for (const ep of cas.entry_points || []) {
    const nodeId = ep.handler?.node_id || ep.source_node;
    if (!entryPointsByNode.has(nodeId)) entryPointsByNode.set(nodeId, []);
    entryPointsByNode.get(nodeId)!.push(ep);
  }

  const allLineage = [...(cas.data_lineage || [])];

  // terminal-signal is used ONLY as an optional naming aid downstream (via
  // dominantEntityForNodes -> data_lineage, not terminal-signal directly);
  // kept here so a future naming refinement can rank steps against it
  // without another CAS-wide pass. Computed once, lazily unused otherwise.
  void buildTerminalSignal; // referenced for future step-naming refinement; not required for correctness today.

  const flows: FlowConcept[] = [];

  for (const ep of entryPoints) {
    const rootNode = nodesById.get(ep.handler?.node_id || ep.source_node);
    if (!rootNode) continue;

    const chain = traceForwardChain(cas, rootNode.id, maxDepth, maxFunctions);
    if (chain.length === 0) continue;

    const segments = segmentIntoSteps(chain, exitPointsByNode, lineageByNode);

    const gaps: string[] = [];
    if (synthesizedRootIds.has(ep.id)) {
      gaps.push('Root synthesized from a system_capabilities operation node reference — this codebase\'s entry-point extraction did not surface a dedicated entry point for this handler.');
    }
    if (chain.length >= maxFunctions) {
      gaps.push(`Call chain truncated at maxFunctionsPerFlow=${maxFunctions}; some downstream steps may be missing.`);
    }
    if (segments.length === 1) {
      gaps.push('Entire chain classified as a single step — no side-effect or layer boundary detected; segmentation is coarse for this flow.');
    }

    const steps: FlowStep[] = segments.map((seg, i) => {
      const { name, description } = nameStepDeterministically(seg.character, seg.nodes, exitPointsByNode, allLineage);
      const contract = buildContract(seg.nodes, cas, exitPointsByNode, entryPointsByNode);

      // sub-section detection: only meaningful when the step maps to a
      // SINGLE function (a multi-function step is already segmented at
      // function granularity — sub-sectioning is for splitting the inside
      // of one large function).
      let functions: FlowStep['functions'];
      if (seg.nodes.length === 1) {
        const sections = detectSubSections(seg.nodes[0]);
        functions = sections
          ? sections.map(s => ({ function_id: seg.nodes[0].id, section: s }))
          : [{ function_id: seg.nodes[0].id }];
      } else {
        functions = seg.nodes.map(n => ({ function_id: n.id }));
      }

      const stepNodeIds = new Set(seg.nodes.map(n => n.id));
      const step: FlowStep = {
        step_id: `${ep.id}::step${i}`,
        order: i,
        name,
        description,
        contract,
        functions,
        entities: entitiesForNodes(stepNodeIds, cas),
      };
      if (opts.nameStep) {
        const override = opts.nameStep(step, { flowEntryPoint: ep });
        if (override?.name) step.name = override.name;
        if (override?.description) step.description = override.description;
      }
      return step;
    });

    const allNodeIds = new Set(chain.map(c => c.node.id));
    const capabilityId = capabilityForEntryPoint(ep, capabilities);
    if (!capabilityId) {
      gaps.push('No system_capabilities entry references this entry point — capability_id omitted rather than guessed.');
    }

    flows.push({
      flow_id: `flow::${ep.id}`,
      name: flowNameForEntryPoint(ep),
      intent: flowIntentForEntryPoint(ep),
      entry_point: ep.id,
      capability_id: capabilityId,
      entities: entitiesForNodes(allNodeIds, cas),
      contract: aggregateFlowContract(steps),
      steps,
      gaps: gaps.length ? gaps : undefined,
    });
  }

  return flows;
}
