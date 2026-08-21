import { ENTRY_POINT_TYPE_REACH, type CASEntryPointType } from '../../types/cas.types';



















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


export interface EntryPointInputField {

  name?: string;

  type: string;
}

export interface EntryPointInputShape {
  fields: EntryPointInputField[];

  is_positional_only: boolean;
}


export interface EntryPointOutputShape {

  type: string;

  is_named_type: boolean;
  is_void: boolean;
  status_codes?: number[];
}

export interface EntryPointCapabilityRef {
  capability_id: string;
  capability_name: string;

  role: string;
}

export type InteractionReach = 'external' | 'internal' | 'unknown';


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


export interface FlowLike {
  flow_id: string;
  entry_point: string;
  role?: string;
  contract?: {
    input?: string[];
    output?: string[];
  };
}




export type CapabilityRelatedFlow = string | { flow_id: string; role?: string };


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


function unwrapPromise(typeText: string): string {
  let text = typeText.trim();

  const promiseRe = /^Promise<(.+)>$/;
  let match = promiseRe.exec(text);
  while (match) {
    text = match[1].trim();
    match = promiseRe.exec(text);
  }
  return text;
}


function unwrapArraySuffix(typeText: string): string {
  let text = typeText.trim();
  while (text.endsWith('[]')) {
    text = text.slice(0, -2).trim();
  }
  return text;
}





function splitUnion(typeText: string): string[] {
  return typeText
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}






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


    return { type: candidate, is_named_type: false, is_void: false };
  }



  return { type: unionMembers.join(' | ') || unwrapped, is_named_type: false, is_void: false };
}


function normalizeInputField(rawFieldText: string): EntryPointInputField {
  const match = NAMED_FIELD_RE.exec(rawFieldText);
  if (match) {
    return { name: match[1], type: match[2] };
  }
  return { type: rawFieldText.trim() };
}









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











export function attachCapability<T extends EntryPointLike>(
  entryPoints: T[],
  flows: FlowLike[],
  capabilities: CapabilityLike[],
): T[] {
  const flowById = new Map<string, FlowLike>();
  for (const flow of flows) {
    flowById.set(flow.flow_id, flow);
  }


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





function seamReferencesNode(seam: CommunicationSeamLike, nodeIds: string[]): boolean {
  const haystacks = [seam.evidence, seam.source, seam.target];
  return nodeIds.some(
    (id) => id !== undefined && haystacks.some((h) => h !== undefined && h.includes(id)),
  );
}














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
      const typeReach = ENTRY_POINT_TYPE_REACH[ep.type as CASEntryPointType];
      if (typeReach === 'external' && ep.trigger) {
        reach = 'external';
      } else if (typeReach === 'internal') {
        reach = 'internal';
      }
    }

    return { ...ep, interaction_reach: reach };
  });
}
