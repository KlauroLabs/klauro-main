import type { SystemCapability } from '../../types/cas.types';
import {
  capabilityAudienceRepairFeedback,
  capabilityCatalogProductTerms,
  evaluateCapabilityCatalogAudience,
} from '../../analyzer/core/capability-catalog-audience';

function capability(name: string, description = ''): SystemCapability {
  return {
    id: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    description,
    name_source: 'ai',
    description_source: 'ai',
    category: 'core',
    operations: [{
      entry_point_id: `entry_${name.toLowerCase().replace(/\s+/g, '_')}`,
      entry_point_type: 'page',
      action: 'view',
    }],
    related_entities: [],
    related_domains: [],
    criticality: 'high',
    criticality_factors: [],
  };
}

describe('capability catalog audience evaluation', () => {
  it('returns accepted capabilities and structured rejection evidence', () => {
    const evaluation = evaluateCapabilityCatalogAudience([
      capability('View industry reports', 'Lets analysts review published industry reports before making decisions.'),
      capability('Browse products', 'Provides seamless insights into the available products.'),
      capability('Access user account'),
    ], [], [], ['industry reports', 'products', 'user account']);

    expect(evaluation.accepted.map(item => item.name)).toEqual(['View industry reports']);
    expect(evaluation.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Browse products', reasons: ['marketing-language'] }),
      expect.objectContaining({ name: 'Access user account', reasons: ['missing'] }),
    ]));
  });

  it('builds bounded corrective feedback with evidence-preserving instructions', () => {
    const feedback = capabilityAudienceRepairFeedback([{
      name: 'Browse products',
      description: 'Provides seamless insights into available products.',
      target: 'description',
      reasons: ['marketing-language'],
      flaggedTokens: [],
    }]);

    expect(feedback).toContain('Browse products');
    expect(feedback).toContain('marketing-language');
    expect(feedback).toContain('concrete user outcome');
    expect(feedback).toContain('only cited evidence');
  });

  it('excludes AI-authored purpose text from trusted product grounding', () => {
    expect(capabilityCatalogProductTerms({
      primary_domain: 'commerce',
      inferred_description: 'Invented platform narrative',
      description_source: 'ai',
      core_concepts: ['Invented concept'],
    } as any, {
      concepts: ['Catalog'],
      productDocTitle: 'Product Guide',
    })).toEqual(['commerce', 'Product Guide', 'Catalog']);
  });
});
