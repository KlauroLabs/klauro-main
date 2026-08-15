export type PassiveDataRole = 'provider' | 'consumer' | 'publisher' | 'listener' | 'shared';

export interface PassiveDataInterface {
  id: string;
  kind: string;
  role: PassiveDataRole;
  key: string;
}

interface LinkablePassiveDataInterface extends PassiveDataInterface {
  codebase_id: string;
  application_id: string;
  name: string;
  refs: Array<{ id: string; name?: string; file?: string }>;
}

export function passiveDataOperationRole(operation: string | undefined): PassiveDataRole {
  const normalized = String(operation || '').trim().toLowerCase();
  if (!normalized) return 'shared';
  const writes = /(?:create|insert|write|save|store|persist|update|upsert|patch|delete|remove|destroy|truncate|replace)/.test(normalized);
  const reads = /(?:read|select|query|find|fetch|get|list|load|search|scan|count|aggregate)/.test(normalized);
  return writes && !reads ? 'publisher' : reads && !writes ? 'listener' : 'shared';
}

export function passiveDataLifecycleRole(writers: string[], readers: string[]): PassiveDataRole {
  if (writers.length > 0 && readers.length === 0) return 'publisher';
  if (readers.length > 0 && writers.length === 0) return 'listener';
  return 'shared';
}

export function passiveDataInterfacePairs<T extends PassiveDataInterface>(interfaces: T[]): Array<{ source: T; target: T }> {
  const groups = new Map<string, T[]>();
  for (const item of interfaces) {
    if (item.kind !== 'passive-data') continue;
    const group = groups.get(item.key);
    if (group) group.push(item);
    else groups.set(item.key, [item]);
  }
  const pairs: Array<{ source: T; target: T }> = [];
  for (const group of groups.values()) {
    const sources = group.filter(item => item.role === 'publisher' || item.role === 'shared');
    const targets = group.filter(item => item.role === 'listener' || item.role === 'shared');
    for (const source of sources) {
      for (const target of targets) {
        if (source.id === target.id) continue;
        if (source.role === 'shared' && target.role === 'shared' && source.id.localeCompare(target.id) > 0) continue;
        pairs.push({ source, target });
      }
    }
  }
  return pairs;
}

export function buildPassiveDataLinks<T extends LinkablePassiveDataInterface, Q extends string>(
  interfaces: T[],
  canLinkWithinCodebase: (source: T, target: T) => boolean,
  evidenceQuality: (source: T, target: T) => Q,
  confidenceFor: (quality: Q) => number,
) {
  return passiveDataInterfacePairs(interfaces).flatMap(({ source, target }) => {
    if (source.codebase_id === target.codebase_id && !canLinkWithinCodebase(source, target)) return [];
    const quality = evidenceQuality(source, target);
    return [{
      id: `shared-data:${source.id}->${target.id}`,
      kind: 'shared-data' as const,
      mode: 'passive' as const,
      source_interface_id: source.id,
      target_interface_id: target.id,
      source_codebase_id: source.codebase_id,
      target_codebase_id: target.codebase_id,
      source_application_id: source.application_id,
      target_application_id: target.application_id,
      confidence: confidenceFor(quality),
      evidence_quality: quality,
      evidence: [
        `${quality}:${source.codebase_id}:${source.name}`,
        `${quality}:${target.codebase_id}:${target.name}`,
        ...source.refs.slice(0, 2).map(ref => `writer:${ref.file || ref.name || ref.id}`),
        ...target.refs.slice(0, 2).map(ref => `reader:${ref.file || ref.name || ref.id}`),
      ],
    }];
  });
}
