import { CapabilityDetector } from '../../analyzer/core/capability-detector';
import {
  isBareNounCapabilityLabel,
  isStructuralPlaceholderCapabilityDescription
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
});
