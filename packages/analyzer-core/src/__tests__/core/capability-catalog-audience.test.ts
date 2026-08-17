import type { CASDataEntity, SystemCapability } from '../../types/cas.types';
import {
  capabilityAudienceRepairFeedback,
  capabilityCatalogIntegrationTerms,
  capabilityCatalogProductTerms,
  evaluateCapabilityCatalogAudience,
} from '../../analyzer/core/capability-catalog-audience';
import { testCapabilityDescriptionAgainstAudience } from '../../analyzer/core/capability-audience-test';

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

function dataEntity(id: string, name: string, kind: CASDataEntity['kind']): CASDataEntity {
  return {
    id,
    name,
    kind,
    lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
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
    expect(evaluation.descriptionRepairCandidates.map(item => item.name)).toEqual([
      'Browse products',
      'Access user account',
    ]);
    expect(evaluation.descriptionRepairCandidates.every(item =>
      item.description === '' && item.description_generation?.status === 'ai_rejected')).toBe(true);
    expect(evaluation.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Browse products', reasons: expect.arrayContaining(['marketing-language']) }),
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
    expect(feedback).toContain('Remove every flagged token');
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

  it('trusts canonical domain shapes as product nouns', () => {
    const subject = capability(
      'Review accounts',
      'Company records connect each account to its current billing location and delivery terms.',
    );
    subject.related_entities = ['entity_company'];
    const evaluation = evaluateCapabilityCatalogAudience(
      [subject],
      [dataEntity('entity_company', 'Company', 'domain-shape')],
      ['company-client'],
      ['accounts', 'billing location', 'delivery terms'],
    );

    expect(evaluation.accepted).toHaveLength(1);
    expect(evaluation.rejections).toHaveLength(0);
  });

  it('trusts compound spellings of linked product entities', () => {
    const subject = capability(
      'Apply account credit',
      'CreditMemo records adjust the balance for the selected account.',
    );
    subject.related_entities = ['entity_credit_memo'];

    const evaluation = evaluateCapabilityCatalogAudience(
      [subject],
      [dataEntity('entity_credit_memo', 'Credit Memo', 'domain-shape')],
      [],
      ['account'],
    );

    expect(evaluation.accepted).toHaveLength(1);
    expect(evaluation.rejections).toHaveLength(0);
  });

  it('derives integration vocabulary from declared SDK and connector package shapes', () => {
    expect(capabilityCatalogIntegrationTerms([
      'AcmeCloudSDK',
      '@vendor/WarehouseConnector',
      'sdk-payment-network',
      'billing-api',
      'http-client',
      'openapi',
    ])).toEqual(['acmecloud', 'paymentnetwork', 'warehouse']);

    const evaluation = evaluateCapabilityCatalogAudience([
      capability(
        'Send scheduled invoices',
        'AcmeCloud receives each scheduled invoice for customer billing and payment processing.',
      ),
    ], [], ['AcmeCloudSDK'], ['scheduled invoices', 'customer billing']);

    expect(evaluation.accepted).toHaveLength(1);
    expect(evaluation.rejections).toHaveLength(0);
  });

  it('continues to reject transport shape identifiers', () => {
    const verdict = testCapabilityDescriptionAgainstAudience(
      'Review accounts',
      'CreateCompanyRequest carries the submitted account details into the review.',
      [],
      [{ name: 'CreateCompanyRequest', kind: 'request-dto' }],
      ['accounts'],
    );

    expect(verdict.failsAudienceTest).toBe(true);
    expect(verdict.reasons).toContain('identifier-vocabulary');
    expect(verdict.flaggedTokens).toContain('CreateCompanyRequest');
  });
});
