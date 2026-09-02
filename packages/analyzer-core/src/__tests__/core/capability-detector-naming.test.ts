import { CapabilityDetector } from '../../analyzer/core/capability-detector';
import {
  isBareNounCapabilityLabel,
  isCrudInventoryCapabilityLabel,
  isCrudLifecycleFragmentCapabilityLabel,
  isStructuralPlaceholderCapabilityDescription,
  isGenericManagementCapabilityLabel,
  normalizeCapabilityActionName
} from '../../analyzer/core/capability-naming';
import type { CASEntryPoint } from '../../types/cas.types';

/**
 * PRODUCER-level regression for the v1.0.126 flow_graph.capabilities defect:
 * CapabilityDetector.generateDescription emitted the literal template
 * "<Name>: <pattern> operation via <type>" and formatCapabilityName
 * title-cased raw group keys into bare nouns ("Active", "Hot", "Cas") —
 * 163/177 of the self-analysis flow-graph capabilities were this shape and
 * needed a finalize-time repair sweep (ba7f915a) to fix after the fact.
 *
 * The producer must now build evidence-grounded names/descriptions in the
 * first place (via the SAME shared implementation in capability-naming.ts the
 * orchestrator backstop uses), so:
 *  - a raw group key ("hot", "cas") must never surface title-cased as the
 *    shipped capability name;
 *  - the "<pattern> operation via <type>" / "N operations (...)" templates
 *    must never be emitted as a description.
 */

function entryPoint(overrides: Partial<CASEntryPoint> & { id: string; name: string }): CASEntryPoint {
  return {
    source_node: `node_${overrides.id}`,
    type: 'http',
    ...overrides
  } as CASEntryPoint;
}

function detect(entryPoints: CASEntryPoint[]) {
  return new CapabilityDetector().detectCapabilities(entryPoints, [], [], [], []);
}

describe('CapabilityDetector producer naming (evidence-grounded, no bare-noun group keys)', () => {
  it('never ships a title-cased raw group key as the capability name', () => {
    // "get_hot_spots" over an event trigger groups on the raw token "hot".
    const caps = detect([
      entryPoint({
        id: 'ep_hot',
        name: 'get_hot_spots',
        type: 'event',
        trigger: { event: 'hot.spots.requested' }
      })
    ]);
    expect(caps).toHaveLength(1);
    // The group key itself still keys the id (stable references)...
    expect(caps[0].id).toBe('capability_hot');
    // ...but the NAME is derived from the real operation, never "Hot".
    expect(caps[0].name).toBe('Get Hot Spots');
    expect(isBareNounCapabilityLabel(caps[0].name)).toBe(false);
  });

  it('adopts a verb-headed humanized operation label from camelCase names', () => {
    const caps = detect([
      entryPoint({
        id: 'ep_cas',
        name: 'validateCasContract',
        type: 'event',
        trigger: { event: 'cas.validate' }
      })
    ]);
    expect(caps).toHaveLength(1);
    expect(caps[0].name).toBe('Validate Cas Contract');
    expect(caps[0].name).not.toBe('Cas');
  });

  it('falls back to "Manage <subject>" when no operation label is verb-headed', () => {
    const caps = detect([
      entryPoint({
        id: 'ep_active',
        name: 'active',
        type: 'message',
        trigger: { event: 'active' }
      })
    ]);
    expect(caps).toHaveLength(1);
    expect(caps[0].name).toBe('Manage Active');
    expect(isBareNounCapabilityLabel(caps[0].name)).toBe(false);
  });

  it('keeps an already purpose-headed group label as-is', () => {
    // resource_action group key "users_create" -> subject "Users Create" is
    // bare (noun-first) so it re-derives; but an action-headed key like
    // "users_search" merged under "search_..." style stays purpose-headed.
    const caps = detect([
      entryPoint({
        id: 'ep_search_users',
        name: 'searchUsers',
        type: 'http',
        trigger: { method: 'GET', path: '/api/users/search' }
      })
    ]);
    expect(caps).toHaveLength(1);
    expect(isBareNounCapabilityLabel(caps[0].name)).toBe(false);
  });

  it('recognizes browse as a product-purpose verb', () => {
    expect(isBareNounCapabilityLabel('Browse products')).toBe(false);
  });

  it('recognizes publish as a product-purpose verb without accepting noun-only labels', () => {
    expect(isBareNounCapabilityLabel('Publish articles')).toBe(false);
    expect(isBareNounCapabilityLabel('Settle invoices')).toBe(false);
    expect(isBareNounCapabilityLabel('Categorize transactions')).toBe(false);
    expect(isBareNounCapabilityLabel('Article management')).toBe(true);
  });

  it('distinguishes generic management labels from specific product outcomes', () => {
    expect(isGenericManagementCapabilityLabel('Manage categories')).toBe(true);
    expect(isGenericManagementCapabilityLabel('Handling accounts')).toBe(true);
    expect(isGenericManagementCapabilityLabel('Process transactions')).toBe(true);
    expect(isGenericManagementCapabilityLabel('Track budgets')).toBe(false);
    expect(isGenericManagementCapabilityLabel('Organize transaction categories')).toBe(false);
  });

  it('rejects CRUD inventories while preserving compound outcomes', () => {
    expect(isCrudInventoryCapabilityLabel('Review and delete transactions')).toBe(true);
    expect(isCrudInventoryCapabilityLabel('Record, view, and delete financial transactions')).toBe(true);
    expect(isCrudInventoryCapabilityLabel('Create and manage spending categories')).toBe(true);
    expect(isCrudInventoryCapabilityLabel('Find and compare places to stay')).toBe(false);
    expect(isCrudInventoryCapabilityLabel('Review codebase change risk')).toBe(false);
    expect(isCrudInventoryCapabilityLabel('Review change impact')).toBe(false);
    expect(isCrudInventoryCapabilityLabel('Track and delete transactions')).toBe(true);
    expect(isCrudInventoryCapabilityLabel('Connect bank accounts via Plaid')).toBe(false);
    expect(isCrudInventoryCapabilityLabel('Import financial data from CSV')).toBe(false);
  });

  it('rejects one CRUD action as the name of a complete lifecycle without blacklisting outcome verbs globally', () => {
    const lifecycle = ['create', 'read', 'update', 'delete'];
    expect(isCrudLifecycleFragmentCapabilityLabel('Create category', lifecycle)).toBe(true);
    expect(isCrudLifecycleFragmentCapabilityLabel('View categories', lifecycle)).toBe(true);
    expect(isCrudLifecycleFragmentCapabilityLabel('Organize spending categories', lifecycle)).toBe(false);
    expect(isCrudLifecycleFragmentCapabilityLabel('Create category', ['create'])).toBe(false);
    expect(isCrudLifecycleFragmentCapabilityLabel('Open an account', lifecycle)).toBe(false);
  });

  it('never emits the "<pattern> operation via <type>" single-op template', () => {
    const caps = detect([
      entryPoint({
        id: 'ep_hot',
        name: 'get_hot_spots',
        type: 'event',
        trigger: { event: 'hot.spots.requested' }
      })
    ]);
    expect(caps[0].description).toBe('Covers 1 event operation: Get Hot Spots.');
    expect(isStructuralPlaceholderCapabilityDescription(caps[0].description)).toBe(false);
    expect(caps[0].description).not.toMatch(/operation via/i);
  });

  it('does not match a generic action name inside an unrelated entity name', () => {
    const ep = entryPoint({ id: 'budget-edit', name: 'GET /budgets/:id/edit', trigger: { method: 'GET', path: '/budgets/:id/edit' } });
    const chain: any = {
      id: 'budget-edit-chain',
      entry_point: { entry_point_id: ep.id },
      call_path: [{ node_id: 'budget-edit-method', method_name: 'edit', depth: 0 }],
      characteristics: { max_depth: 1, total_calls: 0 },
    };
    const nodes: any[] = [
      { id: 'budget-edit-method', name: 'edit', type: 'method' },
    ];
    const entities: any[] = [
      { id: 'entity_creditcard', name: 'CreditCard' },
      { id: 'entity_budget', name: 'Budget' },
    ];
    const [capability] = new CapabilityDetector().detectCapabilities([ep], [chain], nodes, [], [], entities);
    expect(capability.entities_touched).toEqual([]);
  });

  it('uses HTTP semantics before substrings inside resource names', () => {
    const caps = detect([
      entryPoint({
        id: 'budget-update',
        name: 'PATCH /budgets/:id',
        trigger: { method: 'PATCH', path: '/budgets/:id' },
      }),
      entryPoint({
        id: 'budget-edit-form',
        name: 'GET /budgets/:id/edit',
        trigger: { method: 'GET', path: '/budgets/:id/edit' },
      }),
    ]);
    const actions = new Map(caps.flatMap(capability =>
      capability.operations.map(operation => [operation.entry_point_id, operation.pattern])));
    expect(actions.get('budget-update')).toBe('update');
    expect(actions.get('budget-edit-form')).toBe('read');
  });

  it('never emits the "N operations (patterns)" multi-op template', () => {
    const caps = detect([
      entryPoint({
        id: 'ep_users_list',
        name: 'listUsers',
        type: 'http',
        trigger: { method: 'GET', path: '/api/users' }
      }),
      entryPoint({
        id: 'ep_users_create',
        name: 'createUser',
        type: 'http',
        trigger: { method: 'POST', path: '/api/users' }
      })
    ]);
    expect(caps).toHaveLength(1);
    expect(isStructuralPlaceholderCapabilityDescription(caps[0].description)).toBe(false);
    expect(caps[0].description).toMatch(/^Covers 2 http operations: /);
    expect(caps[0].description).toContain('List Users');
    expect(caps[0].description).toContain('Create User');
  });

  it('every produced capability passes the finalize backstop predicates (backstop finds nothing to repair)', () => {
    const caps = detect([
      entryPoint({ id: 'ep_1', name: 'get_hot_spots', type: 'event', trigger: { event: 'hot.spots' } }),
      entryPoint({ id: 'ep_2', name: 'active', type: 'message', trigger: { event: 'active' } }),
      entryPoint({ id: 'ep_3', name: 'listUsers', type: 'http', trigger: { method: 'GET', path: '/api/users' } }),
      entryPoint({ id: 'ep_4', name: 'createUser', type: 'http', trigger: { method: 'POST', path: '/api/users' } }),
      entryPoint({ id: 'ep_5', name: 'sync', type: 'cli', trigger: { pattern: 'sync' } }),
      entryPoint({ id: 'ep_6', name: 'nightly_cleanup_job', type: 'schedule', trigger: { schedule: '0 0 * * *' } })
    ]);
    expect(caps.length).toBeGreaterThan(0);
    for (const cap of caps) {
      expect(isBareNounCapabilityLabel(cap.name)).toBe(false);
      expect(isStructuralPlaceholderCapabilityDescription(cap.description)).toBe(false);
    }
  });

  it('preserves distinct source-positioned event operations with the same display name', () => {
    const caps = detect([
      entryPoint({ id: 'event_change_10_2', name: 'EditJobModal change', type: 'event', trigger: { pattern: 'change' } }),
      entryPoint({ id: 'event_change_20_2', name: 'EditJobModal change', type: 'event', trigger: { pattern: 'change' } }),
    ]);
    expect(caps).toHaveLength(1);
    expect(caps[0].operations.map(operation => operation.entry_point_id))
      .toEqual(['event_change_10_2', 'event_change_20_2']);
  });

  it('uses RPC method semantics before the shared POST transport', () => {
    const caps = detect([
      entryPoint({ id: 'rpc_get', name: 'gRPC MemoService.GetMemo', trigger: { method: 'POST', path: '/memos.api.v1.MemoService/GetMemo' } }),
      entryPoint({ id: 'rpc_list', name: 'gRPC MemoService.ListMemos', trigger: { method: 'POST', path: '/memos.api.v1.MemoService/ListMemos' } }),
      entryPoint({ id: 'rpc_update', name: 'gRPC MemoService.UpdateMemo', trigger: { method: 'POST', path: '/memos.api.v1.MemoService/UpdateMemo' } }),
      entryPoint({ id: 'rpc_delete', name: 'gRPC MemoService.DeleteMemo', trigger: { method: 'POST', path: '/memos.api.v1.MemoService/DeleteMemo' } }),
      entryPoint({ id: 'rpc_test', name: 'gRPC InstanceService.TestEmailSetting', trigger: { method: 'POST', path: '/memos.api.v1.InstanceService/TestEmailSetting' } }),
      entryPoint({ id: 'rpc_decline', name: 'gRPC SpaceService.DeclineInvitation', trigger: { method: 'POST', path: '/memos.api.v1.SpaceService/DeclineInvitation' } }),
    ]);
    const patterns = new Map(caps.flatMap(capability => capability.operations.map(operation => [operation.name, operation.pattern] as const)));
    expect(patterns.get('gRPC MemoService.GetMemo')).toBe('read');
    expect(patterns.get('gRPC MemoService.ListMemos')).toBe('query');
    expect(patterns.get('gRPC MemoService.UpdateMemo')).toBe('update');
    expect(patterns.get('gRPC MemoService.DeleteMemo')).toBe('delete');
    expect(patterns.get('gRPC InstanceService.TestEmailSetting')).toBe('action');
    expect(patterns.get('gRPC SpaceService.DeclineInvitation')).toBe('action');
  });

  it('normalizes third-person generated action headings to imperative names', () => {
    expect(normalizeCapabilityActionName('Updates user profile')).toBe('Update user profile');
    expect(normalizeCapabilityActionName('Creates and updates articles')).toBe('Create and update articles');
    expect(normalizeCapabilityActionName('Manages account settings')).toBe('Manage account settings');
    expect(normalizeCapabilityActionName('Processes events')).toBe('Process events');
    expect(normalizeCapabilityActionName('Access control')).toBe('Access control');
  });
});
