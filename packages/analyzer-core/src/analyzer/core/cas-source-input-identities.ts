import type { CASOutput, CASSourceInputIdentity } from '../../types/cas.types';

type SourceInputCatalog = Pick<CASOutput, 'analyzer_contributions' | 'source_input_identities' | 'source_input_root' | 'source_input_catalog'> & Partial<Pick<CASOutput, 'system'>>;

function isIdentity(value: unknown): value is CASSourceInputIdentity {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function sourceInputIdentityAt(table: unknown, index: unknown): CASSourceInputIdentity | undefined {
  if (!Array.isArray(table) || !Number.isSafeInteger(index) || (index as number) < 0
    || (index as number) >= table.length || !Object.prototype.hasOwnProperty.call(table, index as number)) return undefined;
  const identity = table[index as number];
  return isIdentity(identity) ? identity : undefined;
}

function identityKey(identity: CASSourceInputIdentity): string {
  const record = identity as unknown as Record<string, unknown>;
  return JSON.stringify([identity.path, Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]))]);
}

export function compactCasSourceInputIdentities(cas: SourceInputCatalog): void {
  const incomplete = (reason: string) => { cas.source_input_catalog = { status: 'unnormalized', reason }; };
  if (!Array.isArray(cas.analyzer_contributions)) return incomplete('contributions-unavailable');
  if (cas.source_input_identities !== undefined && !Array.isArray(cas.source_input_identities)) return incomplete('invalid-identity-table');
  const unique = new Map<string, { key: string; identity: CASSourceInputIdentity }>();
  for (const identity of cas.source_input_identities || []) {
    if (!isIdentity(identity)) return incomplete('invalid-identity-table-row');
    const key = identityKey(identity);
    if (!unique.has(key)) unique.set(key, { key, identity });
  }
  const observations: Array<string[] | undefined> = [];
  let hasEvidence = false;
  for (const contribution of cas.analyzer_contributions) {
    const inputs = contribution?.source_inputs;
    if (!inputs) { observations.push(undefined); continue; }
    hasEvidence = true;
    if (inputs.version !== 1 && inputs.version !== 2) return incomplete('unsupported-input-version');
    const rows = inputs.version === 1 ? inputs.files : inputs.identity_indices;
    if (!Array.isArray(rows)) return incomplete('input-observations-unavailable');
    const keys: string[] = [];
    for (const row of rows) {
      const identity = inputs.version === 1 ? row : sourceInputIdentityAt(cas.source_input_identities, row);
      if (!isIdentity(identity)) return incomplete(inputs.version === 1 ? 'invalid-input-identity' : 'invalid-input-reference');
      const key = identityKey(identity);
      if (!unique.has(key)) unique.set(key, { key, identity });
      keys.push(unique.get(key)!.key);
    }
    observations.push(keys);
  }
  if (!hasEvidence) { cas.source_input_catalog = { status: 'not-recorded' }; return; }
  const keys = [...unique.keys()].sort();
  const indices = new Map(keys.map((key, index) => [key, index]));
  const contributions = cas.analyzer_contributions.map((contribution, index) => {
    const inputs = contribution?.source_inputs;
    const observed = observations[index];
    if (!inputs || !observed) return contribution;
    const identityIndices = observed.map(key => indices.get(key)!);
    if (inputs.version === 1) {
      const { files, ...metadata } = inputs;
      return { ...contribution, source_inputs: { ...metadata, version: 2 as const, identity_indices: identityIndices } };
    }
    return { ...contribution, source_inputs: { ...inputs, identity_indices: identityIndices } };
  });
  if (cas.source_input_root === undefined && cas.system?.root_path !== undefined) cas.source_input_root = cas.system.root_path;
  cas.source_input_identities = keys.map(key => ({ ...unique.get(key)!.identity }));
  cas.analyzer_contributions = contributions;
  cas.source_input_catalog = { status: 'shared' };
}
