export type CapabilityCatalogResponse =
  | { ok: true; capabilities: Array<Record<string, unknown>>; rejectedMemberIndices?: number[] }
  | { ok: false; reason: string };

export class CapabilityCatalogResponseError extends Error {
  constructor(reason: string) {
    super(`Capability catalog response is unusable: ${reason}`);
    this.name = 'CapabilityCatalogResponseError';
  }
}

function firstBalancedJsonValue(raw: string): string | undefined {
  const start = raw.search(/[\[{]/);
  if (start < 0) return undefined;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') {
      stack.push(character);
      continue;
    }
    if (character !== '}' && character !== ']') continue;
    const expected = character === '}' ? '{' : '[';
    if (stack.pop() !== expected) return undefined;
    if (stack.length === 0) return raw.slice(start, index + 1);
  }
  return undefined;
}

export function parseCapabilityCatalogResponse(raw: string): CapabilityCatalogResponse {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty-response' };
  const balanced = firstBalancedJsonValue(raw);
  if (!balanced) return { ok: false, reason: 'incomplete-json' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(balanced);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  const envelope = parsed as Record<string, unknown> | null;
  const list = Array.isArray(parsed) ? parsed
    : envelope && Object.prototype.hasOwnProperty.call(envelope, 'capabilities') ? envelope.capabilities
    : envelope?.key_capabilities;
  if (!Array.isArray(list)) return { ok: false, reason: 'missing-capability-array' };
  const rejectedMemberIndices: number[] = [];
  const capabilities = list.filter((item, index) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) return true;
    rejectedMemberIndices.push(index);
    return false;
  }) as Array<Record<string, unknown>>;
  if (list.length > 0 && capabilities.length === 0) {
    return { ok: false, reason: 'invalid-capability-member' };
  }
  return { ok: true, capabilities, ...(rejectedMemberIndices.length ? { rejectedMemberIndices } : {}) };
}
