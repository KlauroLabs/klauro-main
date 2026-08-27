import type { CASDataEntity, SystemCapability } from '../../types/cas.types';
import {
  capabilityAudienceRepairFeedback,
  capabilityPublishabilityRepairFeedback,
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
      capabilityId: 'browse-products',
      capabilityIndex: 0,
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

  it('directs unsupported guarantees toward advisory truth instead of synonym replacement', () => {
    const feedback = capabilityAudienceRepairFeedback([{
      capabilityId: 'coordinate-overlapping-work',
      capabilityIndex: 0,
      name: 'Coordinate overlapping work',
      description: 'Prevents conflicts and ensures consistent state.',
      target: 'description',
      reasons: ['unsupported-exclusivity-claim'],
      flaggedTokens: ['prevents conflicts', 'ensures consistent state'],
    }]);

    expect(feedback).toContain('advisory detection or reporting');
    expect(feedback).toContain('never claim prevention');
    expect(feedback).toContain('unless cited evidence explicitly proves');
  });

  it('translates publishability failures into outcome-focused repair guidance', () => {
    const feedback = capabilityPublishabilityRepairFeedback([{
      name: 'Retrieve agent context',
      description: 'The workspace surfaces agent context, capability maps, and entity maps for codebase understanding.',
      reason: 'description-internal-analysis-vocabulary',
    }]);

    expect(feedback).toContain('description-internal-analysis-vocabulary');
    expect(feedback).toContain('concrete software behavior, risk, relationship, or change context');
    expect(feedback).toContain('Do not enumerate response objects');
    expect(feedback).toContain('only its cited evidence');
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

  it('rejects a many-family aggregate named after one source entity', () => {
    const subject = capability(
      'Analyze machine repository',
      'The analysis platform explains software structure and behavior for people and connected coding agents.',
    );
    subject.related_entities = ['entity_machine_repository', 'entity_behavior_graph', 'entity_analysis_history'];
    subject.criticality_factors = ['catalog-candidate:analysis', 'catalog-candidate:graph', 'catalog-candidate:history'];

    const evaluation = evaluateCapabilityCatalogAudience(
      [subject],
      [
        dataEntity('entity_machine_repository', 'MachineRepository', 'domain-shape'),
        dataEntity('entity_behavior_graph', 'BehaviorGraph', 'domain-shape'),
        dataEntity('entity_analysis_history', 'AnalysisHistory', 'domain-shape'),
      ],
      [],
      ['software analysis', 'behavior graph', 'analysis history'],
    );

    expect(evaluation.accepted).toEqual([]);
    expect(evaluation.rejections[0]).toEqual(expect.objectContaining({
      target: 'name',
      reasons: ['aggregate-name-narrows-to-entity'],
      flaggedTokens: ['MachineRepository'],
    }));
  });

  it('rejects unsupported exclusivity semantics from advisory coordination evidence', () => {
    const subject = capability(
      'Coordinate overlapping work',
      'The coordination service detects conflicts, claims work areas, and releases locked areas after contributors finish.',
    );
    subject.operations = [
      { entry_point_id: 'claim', entry_point_type: 'message', action: 'Claim work' },
      { entry_point_id: 'detect', entry_point_type: 'message', action: 'Detect conflicts' },
      { entry_point_id: 'release', entry_point_type: 'message', action: 'Release work' },
    ];

    const evaluation = evaluateCapabilityCatalogAudience(
      [subject], [], [], ['advisory coordination', 'parallel work'],
    );

    expect(evaluation.accepted).toEqual([]);
    expect(evaluation.rejections[0].reasons).toContain('unsupported-exclusivity-claim');
    expect(evaluation.descriptionRepairCandidates).toHaveLength(1);
  });

  it('rejects internal context labels and shortened product terminology', () => {
    const subject = capability(
      'Understand fab work context',
      'Fabric reports overlapping codebase work and the active claims associated with each area.',
    );
    subject.operations = [
      { entry_point_id: 'claim', entry_point_type: 'message', action: 'Claim work' },
      { entry_point_id: 'detect', entry_point_type: 'message', action: 'Detect collisions' },
      { entry_point_id: 'release', entry_point_type: 'message', action: 'Release work' },
    ];

    const evaluation = evaluateCapabilityCatalogAudience(
      [subject], [], [], ['Fabric collaboration across overlapping codebase areas'],
    );

    expect(evaluation.accepted).toEqual([]);
    expect(evaluation.rejections[0]).toEqual(expect.objectContaining({
      target: 'name',
      reasons: ['internal-context-name', 'shortened-product-term'],
      flaggedTokens: ['work context', 'fab'],
    }));
    expect(capabilityAudienceRepairFeedback(evaluation.rejections)).toContain('observable action and subject');
  });

  it('rejects invented reservation, assignment, and ownership semantics', () => {
    const subject = capability(
      'Coordinate overlapping work',
      'Lets collaborators reserve and assign work areas while maintaining clear ownership.',
    );
    subject.operations = [
      { entry_point_id: 'claim', entry_point_type: 'message', action: 'Claim work' },
      { entry_point_id: 'detect', entry_point_type: 'message', action: 'Detect conflicts' },
      { entry_point_id: 'release', entry_point_type: 'message', action: 'Release work' },
    ];

    const evaluation = evaluateCapabilityCatalogAudience(
      [subject], [], [], ['advisory coordination', 'parallel overlapping work'],
    );

    expect(evaluation.accepted).toEqual([]);
    expect(evaluation.rejections[0]).toEqual(expect.objectContaining({
      target: 'description',
      reasons: expect.arrayContaining(['unsupported-exclusivity-claim']),
      flaggedTokens: expect.arrayContaining(['reserve', 'assign', 'ownership']),
    }));
  });

  it('rejects conflict-prevention, consistency, and universal guarantees absent from evidence', () => {
    const coordination = capability(
      'Coordinate overlapping work',
      'Coordinates claims to prevent conflicts and ensure consistent state across every active task.',
    );
    coordination.operations = [
      { entry_point_id: 'claim', entry_point_type: 'message', action: 'Claim work' },
      { entry_point_id: 'detect', entry_point_type: 'message', action: 'Detect conflicts' },
      { entry_point_id: 'release', entry_point_type: 'message', action: 'Release work' },
    ];

    const evaluation = evaluateCapabilityCatalogAudience(
      [coordination], [], [], ['advisory coordination', 'parallel overlapping work'],
    );

    expect(evaluation.accepted).toEqual([]);
    expect(evaluation.rejections[0]).toEqual(expect.objectContaining({
      target: 'description',
      reasons: expect.arrayContaining(['unsupported-exclusivity-claim']),
      flaggedTokens: expect.arrayContaining(['prevent conflicts', 'ensure consistent state', 'every']),
    }));
  });

  it('rejects unsupported conflict reduction and alignment guarantees', () => {
    const coordination = capability(
      'Coordinate work across overlapping codebase areas',
      'Developers collaborate in real time on shared code, ensuring alignment and reducing conflicts.',
    );
    coordination.operations = [
      { entry_point_id: 'claim', entry_point_type: 'message', action: 'Claim work' },
      { entry_point_id: 'detect', entry_point_type: 'message', action: 'Detect conflicts' },
    ];

    const evaluation = evaluateCapabilityCatalogAudience(
      [coordination], [], [], ['advisory coordination', 'parallel overlapping work'],
    );

    expect(evaluation.accepted).toEqual([]);
    expect(evaluation.rejections[0]).toEqual(expect.objectContaining({
      reasons: expect.arrayContaining(['unsupported-exclusivity-claim']),
      flaggedTokens: expect.arrayContaining([
        'ensuring alignment',
        'reducing conflicts',
      ]),
    }));
  });

  it('rejects task management and synchronization claims absent from advisory evidence', () => {
    const coordination = capability(
      'Coordinate work across analysis agents',
      'Coordinate work across analysis agents lets users manage and synchronize tasks between different analysis agents.',
    );
    coordination.operations = [
      { entry_point_id: 'claim', entry_point_type: 'message', action: 'Claim work' },
      { entry_point_id: 'detect', entry_point_type: 'message', action: 'Detect collisions' },
      { entry_point_id: 'release', entry_point_type: 'message', action: 'Release work' },
    ];

    const evaluation = evaluateCapabilityCatalogAudience(
      [coordination], [], [], ['Fabric advisory coordination', 'overlapping codebase work'],
    );

    expect(evaluation.accepted).toEqual([]);
    expect(evaluation.rejections[0]).toEqual(expect.objectContaining({
      target: 'description',
      reasons: expect.arrayContaining(['unsupported-exclusivity-claim']),
      flaggedTokens: expect.arrayContaining(['manage', 'synchronize tasks']),
    }));
  });

  it('requires cited operations for synchronization and alignment guarantees', () => {
    const synchronized = capability(
      'Coordinate overlapping work',
      'Surfaces synchronized changes across overlapping work while ensuring participants remain aligned.',
    );
    synchronized.operations = [{ entry_point_id: 'observe', entry_point_type: 'message', action: 'Surface overlapping changes' }];
    const rejected = evaluateCapabilityCatalogAudience(
      [synchronized], [], [], ['real-time collaboration across overlapping concepts'],
    );
    expect(rejected.accepted).toEqual([]);
    expect(rejected.rejections[0]).toEqual(expect.objectContaining({
      reasons: expect.arrayContaining(['unsupported-exclusivity-claim']),
      flaggedTokens: expect.arrayContaining(['synchronized changes', 'ensuring participants remain aligned']),
    }));

    synchronized.description = 'Surfaces overlapping changes so participants can coordinate their work.';
    expect(evaluateCapabilityCatalogAudience(
      [synchronized], [], [], ['real-time collaboration across overlapping concepts'],
    ).accepted).toHaveLength(1);

    synchronized.description = 'Surfaces synchronized changes across overlapping work.';
    synchronized.operations = [{ entry_point_id: 'sync', entry_point_type: 'message', action: 'Synchronize changes' }];
    expect(evaluateCapabilityCatalogAudience([synchronized], [], [], []).accepted).toHaveLength(1);
  });

  it('rejects internal mechanisms in otherwise grounded product descriptions', () => {
    const evaluation = evaluateCapabilityCatalogAudience([
      capability(
        'Analyze codebases',
        'Analyze codebases registers tools to inspect software behavior and assess change risk.',
      ),
      capability(
        'Track codebase change history',
        'Tracks codebase changes as history entries, coordinates with the analyzer, and reads from storage.',
      ),
      capability(
        'Review codebase change history',
        'Records changes as history entries. The analyzer coordinates recording, and the storage reads the recorded changes.',
      ),
      capability(
        'Understand workspace relationships',
        'Shows workspace configuration, including its projects, analyzers, and source settings.',
      ),
      capability(
        'Assess agent readiness and task proof',
        'Assess agent readiness and task proof verifies task completion through message handling.',
      ),
    ], [], [], ['analyze codebases', 'change history', 'workspace relationships']);

    expect(evaluation.accepted).toEqual([]);
    expect(evaluation.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Analyze codebases', reasons: expect.arrayContaining(['internal-mechanism-language']) }),
      expect.objectContaining({ name: 'Track codebase change history', reasons: expect.arrayContaining(['internal-mechanism-language']) }),
      expect.objectContaining({ name: 'Review codebase change history', reasons: expect.arrayContaining(['internal-mechanism-language']) }),
      expect.objectContaining({ name: 'Understand workspace relationships', reasons: expect.arrayContaining(['internal-mechanism-language']) }),
      expect.objectContaining({ name: 'Assess agent readiness and task proof', reasons: expect.arrayContaining(['internal-mechanism-language']), flaggedTokens: ['message handling'] }),
    ]));
  });

  it('keeps message handling when first-party text establishes messaging as the product outcome', () => {
    const subject = capability(
      'Route customer messages',
      'Route customer messages directs message handling between customer support queues.',
    );
    const evaluation = evaluateCapabilityCatalogAudience(
      [subject], [], [], ['customer messaging and support queues'],
    );
    expect(evaluation.accepted).toEqual([subject]);
  });
});
