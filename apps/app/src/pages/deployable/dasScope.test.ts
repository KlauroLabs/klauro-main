import { describe, it, expect } from 'vitest';
import { scopeCapabilities } from './dasScope';
import type { EntryPoint } from '../../hooks/useEntryPoints';

const inScope: EntryPoint = {
  id: 'ep1',
  source_node: 'n1',
  type: 'http',
  name: 'createWidget',
  deployable_id: 'dep:container:services-api:api',
  capabilities: [{ capability_id: 'cap1', capability_name: 'Widgets', role: 'primary' }],
};

describe('scopeCapabilities', () => {
  it('dedupes capabilities across scoped entry points', () => {
    const twice: EntryPoint = { ...inScope, id: 'ep4' };
    expect(scopeCapabilities([inScope, twice])).toEqual([{ capability_id: 'cap1', capability_name: 'Widgets', role: 'primary' }]);
  });

  it('returns empty for no scoped entry points', () => {
    expect(scopeCapabilities([])).toEqual([]);
  });

  it('sorts capabilities by name', () => {
    const b: EntryPoint = { ...inScope, id: 'ep5', capabilities: [{ capability_id: 'cap2', capability_name: 'Billing', role: 'primary' }] };
    expect(scopeCapabilities([inScope, b]).map(c => c.capability_name)).toEqual(['Billing', 'Widgets']);
  });
});
