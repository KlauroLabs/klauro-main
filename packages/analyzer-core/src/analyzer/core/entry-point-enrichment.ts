/**
 * entry-point-enrichment.ts
 *
 * Pure, deterministic enrichment functions that JOIN data already present
 * elsewhere in the CAS (flows, capabilities, communication seams) onto
 * entry points. Nothing here re-derives facts from source code — it only
 * cross-references structures that other analyzers/builders already produced.
 *
 * Deliberately decoupled from `cas.types.ts` / the orchestrator: this module
 * defines its own minimal structural interfaces for the fields it actually
 * reads, so it can be dropped in without touching existing files. The real
 * `CASEntryPoint` type is a superset of `EntryPointLike` and is assignable
 * to/from it without casts once `capabilities?` / `interaction_reach?` are
 * added there (see PROPOSED type additions in the handoff report).
 */

// ---------------------------------------------------------------------------
// Minimal local input shapes (only the fields these functions read/write)
// ---------------------------------------------------------------------------

export interface EntryPointTrigger {
  method?: string;
  path?: string;
  event?: string;
  schedule?: string;
}

export interface EntryPointHandler {
  node_id?: string;
  method_name?: string;
  file?: string;
  line?: number;
}

/** Normalized shape written into `entryPoint.input` by {@link attachFlowContract}. */
export interface EntryPointInputField {
  /** Parameter/property name, when the source contract string was `"name: Type"`. */
  name?: string;
  /** Raw type text for this field (or the whole contract string when unnamed). */
  type: string;
}

export interface EntryPointInputShape {
  fields: EntryPointInputField[];
  /** True when none of the contract.input strings could be split into name:type pairs. */
  is_positional_only: boolean;
}

/** Normalized shape written into `entryPoint.output` by {@link attachFlowContract}. */
export interface EntryPointOutputShape {
  /** Bare type name when `is_named_type` is true, otherwise the raw (unwrapped) type text. */
  type: string;
  /** True when the resolved type is a single identifier that could reference a type definition. */
  is_named_type: boolean;
  is_void: boolean;
  status_codes?: number[];
}

export interface EntryPointCapabilityRef {
  capability_id: string;
  capability_name: string;
  /** Role of the flow that ties this entry point to the capability (e.g. 'primary' | 'supporting'). */
  role: string;
}

export type InteractionReach = 'external' | 'internal' | 'unknown';

/** The minimal entry-point shape these functions operate on. `CASEntryPoint` satisfies this. */
export interface EntryPointLike {
  id: string;
  source_node?: string;
  type?: string;
  trigger?: EntryPointTrigger;
  handler?: EntryPointHandler;
  input?: EntryPointInputShape;
  output?: EntryPointOutputShape;
  capabilities?: EntryPointCapabilityRef[];
  interaction_reach?: InteractionReach;
  connected_nodes?: string[];
}

/** The minimal flow shape these functions read. `ConceptualFlow` satisfies this. */
export interface FlowLike {
  flow_id: string;
  entry_point: string;
  role?: string;
  contract?: {
    input?: string[];
    output?: string[];
  };
}

/** A single capability -> flow relation. The real CAS stores this as an object
 *  (`{ flow_id, role, rationale }`), not a bare string — see report §4. Both
 *  shapes are accepted here for robustness. */
export type CapabilityRelatedFlow = string | { flow_id: string; role?: string };

/** The minimal capability shape these functions read. */
export interface CapabilityLike {
  id: string;
  name: string;
  related_flows?: CapabilityRelatedFlow[];
}

export interface CommunicationSeamLike {
  id?: string;
  modality?: string;
  kind?: string;
  source?: string;
  target?: string;
  evidence?: string;
}

export interface CommunicationSeamsLike {
  seams: CommunicationSeamLike[];
}

// ---------------------------------------------------------------------------
// 1. attachFlowContract
// ---------------------------------------------------------------------------

const VOID_TOKENS = new Set(['()', '', 'void', 'undefined']);
const PRIMITIVE_TYPE_NAMES = new Set([
  'string',
  'number',
  'boolean',
  'void',
  'any',
  'unknown',
  'never',
  'null',
  'undefined',
  'object',
  'symbol',
  'bigint',
]);
const NULLISH_UNION_MEMBERS = new Set(['null', 'undefined']);
const BARE_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NAMED_FIELD_RE = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(.+?)\s*$/;

/** Strip one or more `Promise<...>` wrappers, returning the innermost text. */
function unwrapPromise(typeText: string): string {
  let text = typeText.trim();
  // Matches `Promise<X>` where X is everything up to the matching closing `>`.
  const promiseRe = /^Promise<(.+)>$/;
  let match = promiseRe.exec(text);
  while (match) {
    text = match[1].trim();
    match = promiseRe.exec(text);
  }
  return text;
}

/** Strip trailing `[]` (possibly repeated) from an array type, e.g. `Foo[][]` -> `Foo`. */
function unwrapArraySuffix(typeText: string): string {
  let text = typeText.trim();
  while (text.endsWith('[]')) {
    text = text.slice(0, -2).trim();
  }
  return text;
}

/**
 * Split a top-level `|` union (no attempt at nested generic awareness beyond
 * what CAS contracts actually emit: flat unions of simple identifiers/null).
 */
function splitUnion(typeText: string): string[] {
  return typeText
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Normalize a raw CAS contract output type string (e.g. `"Promise<CASOutput>"`,
 * `"Promise<CASOutput | null>"`, `"()"`, `"boolean"`, `"Promise<{ stdout: string; code: number }>"`)
 * into an {@link EntryPointOutputShape}.
 */
function normalizeOutputType(rawTypeText: string): EntryPointOutputShape {
  const raw = rawTypeText.trim();
  if (VOID_TOKENS.has(raw)) {
    return { type: 'void', is_named_type: false, is_void: true };
  }

  const unwrapped = unwrapArraySuffix(unwrapPromise(raw));
  if (VOID_TOKENS.has(unwrapped)) {
    return { type: 'void', is_named_type: false, is_void: true };
  }

  const unionMembers = splitUnion(unwrapped).filter((m) => !NULLISH_UNION_MEMBERS.has(m));

  if (unionMembers.length === 1) {
    const candidate = unionMembers[0];
    if (BARE_IDENTIFIER_RE.test(candidate) && !PRIMITIVE_TYPE_NAMES.has(candidate)) {
      return { type: candidate, is_named_type: true, is_void: false };
    }
    // Primitive or non-identifier (e.g. an inline `{ stdout: string }` object type,
    // or a string-literal union like `'' | '.zst' | '.br'`).
    return { type: candidate, is_named_type: false, is_void: false };
  }

  // Multiple non-nullish union members: not a single named type; keep the raw
  // (nullish-stripped) union text for documentation purposes.
  return { type: unionMembers.join(' | ') || unwrapped, is_named_type: false, is_void: false };
}

/** Normalize a raw CAS contract input string into an {@link EntryPointInputField}. */
function normalizeInputField(rawFieldText: string): EntryPointInputField {
  const match = NAMED_FIELD_RE.exec(rawFieldText);
  if (match) {
    return { name: match[1], type: match[2] };
  }
  return { type: rawFieldText.trim() };
}

/**
 * Attach `input`/`output` to each entry point by joining its flow's `contract`.
 * Never overwrites a pre-existing `input`/`output` on the entry point.
 *
 * Join key: `flow.entry_point === entryPoint.id`. When multiple flows share an
 * entry point, the flow with `role === 'primary'` is preferred; otherwise the
 * first match (stable input order) is used.
 */
export function attachFlowContract<T extends EntryPointLike>(entryPoints: T[], flows: FlowLike[]): T[] {
  const flowsByEntryId = new Map<string, FlowLike[]>();
  for (const flow of flows) {
    if (!flow.entry_point) continue;
    const list = flowsByEntryId.get(flow.entry_point);
    if (list) {
      list.push(flow);
    } else {
      flowsByEntryId.set(flow.entry_point, [flow]);
    }
  }

  return entryPoints.map((ep) => {
    const candidates = flowsByEntryId.get(ep.id);
    if (!candidates || candidates.length === 0) {
      return ep;
    }
    const flow = candidates.find((f) => f.role === 'primary') ?? candidates[0];
    const contract = flow.contract;
    if (!contract) {
      return ep;
    }

    let next: T = ep;

    if (ep.input === undefined && contract.input && contract.input.length > 0) {
      const fields = contract.input.map(normalizeInputField);
      const inputShape: EntryPointInputShape = {
        fields,
        is_positional_only: fields.every((f) => f.name === undefined),
      };
      next = { ...next, input: inputShape };
    }

    if (ep.output === undefined && contract.output && contract.output.length > 0) {
      const combinedRaw = contract.output.join(' | ');
      next = { ...next, output: normalizeOutputType(combinedRaw) };
    }

    return next;
  });
}

// ---------------------------------------------------------------------------
// 2. attachCapability
// ---------------------------------------------------------------------------

const ROLE_PRIORITY: Record<string, number> = {
  primary: 3,
  supporting: 2,
  infrastructure: 1,
};

function rolePriority(role: string): number {
  return ROLE_PRIORITY[role] ?? 0;
}

function relatedFlowId(rel: CapabilityRelatedFlow): string {
  return typeof rel === 'string' ? rel : rel.flow_id;
}

function relatedFlowRole(rel: CapabilityRelatedFlow): string | undefined {
  return typeof rel === 'string' ? undefined : rel.role;
}

/**
 * Attach `capabilities` to each entry point by joining `capability.related_flows`
 * (cap -> flow) through `flow.entry_point` (flow -> entry). An entry point may
 * end up with zero, one, or many capability refs (cross-cutting capabilities
 * like auth commonly touch many entry points). De-duped by `capability_id`;
 * when the same capability reaches an entry point via multiple flows with
 * different roles, the highest-priority role wins (primary > supporting >
 * infrastructure > other). Pre-existing `capabilities` entries are preserved
 * and merged with, not replaced by, newly derived ones.
 */
export function attachCapability<T extends EntryPointLike>(
  entryPoints: T[],
  flows: FlowLike[],
  capabilities: CapabilityLike[],
): T[] {
  const flowById = new Map<string, FlowLike>();
  for (const flow of flows) {
    flowById.set(flow.flow_id, flow);
  }

  // entryId -> capability_id -> ref (accumulate best role per capability)
  const derived = new Map<string, Map<string, EntryPointCapabilityRef>>();

  for (const cap of capabilities) {
    for (const rel of cap.related_flows ?? []) {
      const flowId = relatedFlowId(rel);
      const flow = flowById.get(flowId);
      if (!flow || !flow.entry_point) continue;

      const role = relatedFlowRole(rel) ?? flow.role ?? 'supporting';
      const entryId = flow.entry_point;

      let byCapId = derived.get(entryId);
      if (!byCapId) {
        byCapId = new Map();
        derived.set(entryId, byCapId);
      }

      const existing = byCapId.get(cap.id);
      if (!existing || rolePriority(role) > rolePriority(existing.role)) {
        byCapId.set(cap.id, { capability_id: cap.id, capability_name: cap.name, role });
      }
    }
  }

  return entryPoints.map((ep) => {
    const byCapId = derived.get(ep.id);
    if (!byCapId || byCapId.size === 0) {
      return ep;
    }

    const merged = new Map<string, EntryPointCapabilityRef>();
    for (const existingRef of ep.capabilities ?? []) {
      merged.set(existingRef.capability_id, existingRef);
    }
    for (const [capId, ref] of byCapId) {
      if (!merged.has(capId)) {
        merged.set(capId, ref);
      }
    }

    return { ...ep, capabilities: Array.from(merged.values()) };
  });
}

// ---------------------------------------------------------------------------
// 3. attachInteractionReach
// ---------------------------------------------------------------------------

const EXTERNALLY_REACHABLE_TYPES = new Set(['http', 'webhook', 'graphql', 'websocket']);
const INTERNALLY_TRIGGERED_TYPES = new Set(['event', 'message', 'schedule']);

/** True if any seam's evidence/source/target string references this node identifier. */
function seamReferencesNode(seam: CommunicationSeamLike, nodeIds: string[]): boolean {
  const haystacks = [seam.evidence, seam.source, seam.target];
  return nodeIds.some(
    (id) => id !== undefined && haystacks.some((h) => h !== undefined && h.includes(id)),
  );
}

/**
 * Set `interaction_reach` on each entry point ('external' | 'internal' | 'unknown').
 * Evidence-gated: only set 'external'/'internal' when a concrete signal exists,
 * otherwise leaves 'unknown'. Two evidence sources are consulted:
 *
 *  1. Communication seams whose evidence/source/target mention this entry
 *     point's `id`, `source_node`, or `handler.node_id` — an inbound seam from
 *     outside the system's own module tree implies 'external' reachability.
 *  2. The entry point's own `type` (+ presence of a `trigger`) as a fallback:
 *     http/webhook/graphql/websocket with a trigger is publicly reachable
 *     ('external'); event/message/schedule are internally triggered
 *     ('internal'); cli/test have no reachability signal ('unknown').
 */
export function attachInteractionReach<T extends EntryPointLike>(
  entryPoints: T[],
  communicationSeams: CommunicationSeamsLike | undefined,
): T[] {
  const seams = communicationSeams?.seams ?? [];

  return entryPoints.map((ep) => {
    const nodeIds = [ep.id, ep.source_node, ep.handler?.node_id].filter(
      (v): v is string => v !== undefined,
    );

    const matchingSeams = nodeIds.length > 0 ? seams.filter((s) => seamReferencesNode(s, nodeIds)) : [];

    let reach: InteractionReach = 'unknown';

    if (matchingSeams.length > 0) {
      const hasMessaging = matchingSeams.some((s) => s.kind === 'messaging' || s.kind === 'passive_state');
      const hasExitPointOnly = matchingSeams.every((s) => s.kind === 'exit_point');
      if (!hasExitPointOnly) {
        reach = hasMessaging ? 'internal' : 'external';
      }
    }

    if (reach === 'unknown' && ep.type) {
      if (EXTERNALLY_REACHABLE_TYPES.has(ep.type) && ep.trigger) {
        reach = 'external';
      } else if (INTERNALLY_TRIGGERED_TYPES.has(ep.type)) {
        reach = 'internal';
      }
    }

    return { ...ep, interaction_reach: reach };
  });
}
