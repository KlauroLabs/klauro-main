import type { SystemCapability } from '../../types/cas.types';
import { mergeCapabilityCatalogRepairResults } from '../../analyzer/core/capability-catalog-scheduling';

const followIdentity: SystemCapability = {
  id: 'follow-users',
  name: 'Follow users',
  name_source: 'ai',
  description: '',
  description_generation: { status: 'ai_rejected', attempted: true, reason: 'catalog-audience:unrelated-entity-vocabulary' },
  category: 'core',
  criticality: 'high',
  criticality_factors: ['catalog-candidate:cap_follow_management'],
  related_domains: [],
  related_entities: [],
  operations: [
    { entry_point_id: 'follow', entry_point_type: 'http', action: 'Follow', path_or_command: '/profiles/:username/follow' },
    { entry_point_id: 'unfollow', entry_point_type: 'http', action: 'Unfollow', path_or_command: '/profiles/:username/follow' },
  ],
};

describe('capability catalog description repair identity', () => {
  it('replaces a contaminated description without changing its evidence family', () => {
    const repaired: SystemCapability = {
      ...followIdentity,
      id: 'repair-output',
      description: 'Profiles can be followed to establish a connection and unfollowed to remove it.',
      description_source: 'ai',
      description_generation: { status: 'ai_applied', attempted: true },
    };

    const result = mergeCapabilityCatalogRepairResults([followIdentity], [repaired]);
    expect(result).toEqual([repaired]);
    expect(result[0].criticality_factors).toContain('catalog-candidate:cap_follow_management');
  });
});
