import { describe, it, expect } from 'vitest';
import { scopeEntryPoints, scopeCapabilities, scopeFiles, scopeEntities, buildNodesById } from './dasScope';
import type { DasUnitSummary } from './dasIndex';
import type { EntryPoint } from '../../hooks/useEntryPoints';

const unit: DasUnitSummary = {
  id: 'das:container:services-api:api',
  name: 'api',
  root_path: 'services/api',
  member_root_paths: ['services/api/bin'],
  tier: 1,
  kind: 'container',
  boundary_evidence: [],
  member_deployable_ids: ['dep:container:services-api:api', 'dep:bin:services-api-bin:bin-api'],
};

const inScope: EntryPoint = {
  id: 'ep1',
  source_node: 'n1',
  type: 'http',
  name: 'createWidget',
  deployable_id: 'dep:container:services-api:api',
  capabilities: [{ capability_id: 'cap1', capability_name: 'Widgets', role: 'primary' }],
};
const outOfScope: EntryPoint = {
  id: 'ep2',
  source_node: 'n2',
  type: 'http',
  name: 'listOrders',
  deployable_id: 'dep:container:services-worker:worker',
};

describe('scopeEntryPoints', () => {
  it('keeps only entry points whose deployable_id matches the unit or its bundled members', () => {
    expect(scopeEntryPoints([inScope, outOfScope], unit)).toEqual([inScope]);
  });

  it('drops entry points with no deployable_id (unresolved attribution)', () => {
    const unresolved: EntryPoint = { ...inScope, id: 'ep3', deployable_id: undefined };
    expect(scopeEntryPoints([unresolved], unit)).toEqual([]);
  });
});

describe('scopeCapabilities', () => {
  it('dedupes capabilities across scoped entry points', () => {
    const twice: EntryPoint = { ...inScope, id: 'ep4' };
    expect(scopeCapabilities([inScope, twice])).toEqual([{ capability_id: 'cap1', capability_name: 'Widgets', role: 'primary' }]);
  });

  it('returns empty for no scoped entry points', () => {
    expect(scopeCapabilities([])).toEqual([]);
  });
});

describe('scopeFiles / scopeEntities', () => {
  const nodes = [
    { id: 'n1', source: { file: 'services/api/handler.ts' } },
    { id: 'n2', source: { file: 'services/worker/handler.ts' } },
    { id: 'n3', source: { file: 'services/api/bin/main.go' } },
  ];

  it('scopes files by root + member root path prefix', () => {
    expect(scopeFiles(nodes, unit)).toEqual(['services/api/bin/main.go', 'services/api/handler.ts']);
  });

  it('scopes entities whose lifecycle touches a node under the unit roots', () => {
    const entities = [
      { id: 'e1', name: 'Widget', lifecycle: { created_by: ['n1'], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'e2', name: 'Order', lifecycle: { created_by: ['n2'], read_by: [], updated_by: [], deleted_by: [] } },
    ];
    const result = scopeEntities(entities, buildNodesById(nodes), unit);
    expect(result.map(e => e.id)).toEqual(['e1']);
  });
});
