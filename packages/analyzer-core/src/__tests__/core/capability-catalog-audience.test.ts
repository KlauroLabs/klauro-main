import type { CASDataEntity, SystemCapability } from '../../types/cas.types';
import {
  capabilityAudienceRepairFeedback,
  capabilityPublishabilityRepairFeedback,
  capabilityCatalogIntegrationTerms,
  capabilityCatalogProductTerms,
  evaluateCapabilityCatalogAudience,
  groundedCapabilityAudience,
  normalizeCapabilityDescriptionForPublication,
  removeUnsupportedCapabilityAbsenceClaims,
} from '../../analyzer/core/capability-catalog-audience';
import { testCapabilityDescriptionAgainstAudience } from '../../analyzer/core/capability-audience-test';


it.each([
  ['retained public operation', 'api_get', 'node_get', 'api', false],
  ['removed operation', 'api_removed', 'node_removed', 'api', true],
  ['missing source reference', 'api_get', '', 'api', true],
  ['non-public operation', 'api_get', 'node_get', 'function', true],
] as const)('scopes audience vocabulary to source-linked evidence: %s', (_label, entryId, sourceId, entryType, rejected) => {
  const subject = capability('Define API endpoints', 'Developers declare HTTP path operations that route incoming requests to their handler functions.');
  subject.operations = [{ entry_point_id: 'api_get', entry_point_type: entryType, action: 'Define' }];
  subject.operation_evidence = [{ entry_point_id: entryId, source_node_id: sourceId, text: 'Define HTTP path operations.' }];
  if (rejected) subject.evidence_examples = ['HTTP from a previous broader candidate'];
  const evaluation = evaluateCapabilityCatalogAudience(
    [subject], [], ['httpx'], ['web framework', 'path operations'], { artifactType: 'library' },
  );
  expect(evaluation.rejections.some(rejection => rejection.reasons.includes('identifier-vocabulary'))).toBe(rejected);
});

it.each([
  ['library', 'api', 'send_response', 'response_node', false],
  ['client-sdk', 'rpc', 'send_response', 'response_node', false],
  ['app', 'api', 'send_response', 'response_node', true],
  ['library', 'page', 'send_response', 'response_node', true],
  ['library', 'message', 'send_response', 'response_node', true],
  ['library', 'cli', 'send_response', 'response_node', true],
  ['library', 'http', 'send_response', 'response_node', true],
  ['library', 'api', 'removed', 'response_node', true],
  ['library', 'api', 'send_response', '', true],
] as const)('evaluates public interface language in its actual audience: %s/%s/%s/%s', (artifactType, type, entryId, sourceId, rejected) => {
  const subject = capability('Send structured responses', 'The response body carries structured results back to the requesting client.');
  subject.operations = [{ entry_point_id: 'send_response', entry_point_type: type, action: 'Send responses' }];
  subject.operation_evidence = [{ entry_point_id: entryId, source_node_id: sourceId, text: 'Send structured responses to clients.' }];
  const evaluation = evaluateCapabilityCatalogAudience([subject], [], [], ['structured responses'], { artifactType });
  expect(evaluation.rejections.some(rejection => rejection.reasons.includes('internal-mechanism-language'))).toBe(rejected);
});

it('does not let public library evidence excuse generated candidate placeholders', () => {
  const subject = capability('Send structured responses', 'The response body from candidate_42 carries structured results back to the requesting client.');
  subject.operations = [{ entry_point_id: 'send_response', entry_point_type: 'api', action: 'Send responses' }];
  subject.operation_evidence = [{ entry_point_id: 'send_response', source_node_id: 'response_node', text: 'Send structured responses to clients.' }];
  const evaluation = evaluateCapabilityCatalogAudience([subject], [], [], ['structured responses'], { artifactType: 'library' });
  expect(evaluation.rejections.some(rejection => rejection.flaggedTokens.includes('candidate_42'))).toBe(true);
});

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


  it('rejects an incomplete modifier at the end of a capability name', () => {
    const evaluation = evaluateCapabilityCatalogAudience([
      capability('Organize merchant families with custom', 'Users organize merchant families with colors, icons, logos, and website details.'),
    ], [], [], ['merchant families', 'custom']);

    expect(evaluation.accepted).toEqual([]);
    expect(evaluation.rejections).toEqual([
      expect.objectContaining({
        target: 'name',
        reasons: ['incomplete-modifier-tail'],
        flaggedTokens: ['custom'],
      }),
    ]);
  });

  it('accepts entity vocabulary directly grounded by the cited operation path', () => {
    const sync = capability(
      'Sync financial accounts via Plaid',
      'Financial accounts synchronize balances and transactions from Plaid connections.',
    );
    sync.operations = [{
      entry_point_id: 'entry_accounts_sync',
      entry_point_type: 'http',
      action: 'update',
      path_or_command: '/accounts/sync',
    }];
    sync.related_entities = ['entity_plaid_item'];

    const evaluation = evaluateCapabilityCatalogAudience(
      [sync],
      [
        dataEntity('entity_account', 'Account', 'persisted-entity'),
        dataEntity('entity_plaid_item', 'PlaidItem', 'persisted-entity'),
      ],
      [],
      ['financial', 'Plaid'],
    );

    expect(evaluation.accepted.map(item => item.name)).toEqual(['Sync financial accounts via Plaid']);
  });

  it('accepts entity vocabulary grounded by owned schema fields and relations', () => {
    const imported = capability(
      'Import financial data from CSV',
      'Users import account and category data from CSV files for later review.',
    );
    imported.operations = [{ entry_point_id: 'imports', entry_point_type: 'http', action: 'Create', path_or_command: '/imports' }];
    imported.related_entities = ['entity_import'];
    const importEntity = dataEntity('entity_import', 'Import', 'persisted-entity');
    importEntity.fields = [{ name: 'category_col_label', type: 'string', is_sensitive: false }];
    importEntity.relations = [{
      target_name: 'Account',
      relation_type: 'ManyToOne',
      kind: 'data',
      evidence_source: 'orm-declaration',
      evidence: 'Import.account',
    }];

    const evaluation = evaluateCapabilityCatalogAudience(
      [imported],
      [
        importEntity,
        dataEntity('entity_account', 'Account', 'persisted-entity'),
        dataEntity('entity_category', 'Category', 'persisted-entity'),
      ],
      [],
      ['financial', 'CSV'],
    );
    expect(evaluation.accepted.map(item => item.name)).toEqual(['Import financial data from CSV']);
  });

  it('grounds entities connected through a one-hop junction schema', () => {
    const capabilityUnderTest = capability(
      'Organize budgets by category',
      'Users organize budgets by category for financial planning.',
    );
    capabilityUnderTest.related_entities = ['entity_category'];

    const category = dataEntity('entity_category', 'Category', 'persisted-entity');
    const budgetCategory = dataEntity('entity_budget_category', 'BudgetCategory', 'persisted-entity');
    budgetCategory.fields = [
      { name: 'category_id', type: 'uuid', is_sensitive: false },
      { name: 'budget_id', type: 'uuid', is_sensitive: false },
    ];

    const evaluation = evaluateCapabilityCatalogAudience(
      [capabilityUnderTest],
      [category, budgetCategory, dataEntity('entity_budget', 'Budget', 'persisted-entity')],
      [],
      ['financial planning'],
    );

    expect(evaluation.accepted.map(item => item.name)).toEqual(['Organize budgets by category']);
  });

  it('does not confuse ordinary action language with an unrelated Action entity', () => {
    const capabilityUnderTest = capability(
      'Track transactions',
      'Users track transaction lifecycle actions across their financial records.',
    );
    capabilityUnderTest.related_entities = ['entity_transaction'];

    const evaluation = evaluateCapabilityCatalogAudience(
      [capabilityUnderTest],
      [
        dataEntity('entity_transaction', 'Transaction', 'persisted-entity'),
        dataEntity('entity_action', 'Action', 'persisted-entity'),
      ],
      [],
      ['financial records'],
    );

    expect(evaluation.accepted.map(item => item.name)).toEqual(['Track transactions']);
  });

  it('rejects marketing language in capability names and does not let a name launder its description', () => {
    const evaluation = evaluateCapabilityCatalogAudience([
      capability(
        'Categorize and Seamlessly Manage Job Applications',
        'Users group job applications into named categories.',
      ),
      capability(
        'Categorize Job Applications',
        'Users seamlessly group job applications into named categories.',
      ),
    ], [], [], ['job applications', 'named categories']);

    expect(evaluation.accepted).toEqual([]);
    expect(evaluation.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'Categorize and Seamlessly Manage Job Applications',
        target: 'name',
        reasons: expect.arrayContaining(['marketing-language']),
      }),
      expect.objectContaining({
        name: 'Categorize Job Applications',
        target: 'description',
        reasons: expect.arrayContaining(['marketing-language']),
      }),
    ]));
  });

  it('accepts a cross-entity outcome only when first-party product text explicitly relates the entities', () => {
    const job = dataEntity('entity_job', 'job', 'domain-shape');
    const category = dataEntity('entity_category', 'category', 'domain-shape');
    const grounded = capability(
      'Manage Job Applications',
      'Users categorize job applications by creating categories for them.',
    );
    grounded.related_entities = [job.id];
    const unsupported = capability(
      'Manage Job Applications',
      'Users attach unrelated categories to job applications.',
    );
    unsupported.related_entities = [job.id];

    const productText = [
      'Users categorize job applications by creating categories and adding applications to a category.',
    ];
    expect(evaluateCapabilityCatalogAudience(
      [grounded],
      [job, category],
      [],
      productText,
    ).accepted.map(item => item.name)).toEqual(['Manage Job Applications']);
    expect(evaluateCapabilityCatalogAudience(
      [unsupported],
      [job, category],
      [],
      ['Users manage job applications. Categories configure reports.'],
    ).rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasons: expect.arrayContaining(['unrelated-entity-vocabulary']) }),
    ]));
  });

  it('trusts entity subjects grounded by cited operations for deterministic and authored outcomes', () => {
    const category = dataEntity('entity_category', 'category', 'domain-shape');
    const atomic = capability(
      'Update categories',
      'Users can update categories; they can also update the same categories when needed.',
    );
    atomic.name_source = 'deterministic';
    atomic.description_source = 'deterministic';
    atomic.related_domains = ['category'];
    atomic.criticality_factors = [
      'catalog-deterministic-atomic-closure',
      'catalog-candidate:operation-obligation:category:update',
    ];
    expect(evaluateCapabilityCatalogAudience([atomic], [category], [], []).accepted).toHaveLength(1);

    const authored = {
      ...atomic,
      id: 'authored-update-categories',
      name_source: 'ai' as const,
      description_source: 'ai' as const,
    };
    expect(evaluateCapabilityCatalogAudience([authored], [category], [], []).accepted).toHaveLength(1);
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

  it('trusts the capability\'s own entity name even when a longer product word starts with it', () => {
    const subject = capability('Toggle post', 'Post authors change the published state of their posts to control whether readers can see them.');
    subject.related_entities = ['entity_post'];
    subject.operations = [{ entry_point_id: 'publish', entry_point_type: 'http', action: 'Update Post' }];

    const evaluation = evaluateCapabilityCatalogAudience(
      [subject], [dataEntity('entity_post', 'Post', 'persisted-entity')], [], ['postgres', 'blog posts'],
    );

    expect(evaluation.rejections.filter(rejection => rejection.reasons.includes('shortened-product-term'))).toEqual([]);
  });

  it('trusts words from the capability\'s own evidence examples in the identifier-vocabulary test', () => {
    const subject = capability('Define API endpoints with path operations', 'Developers declare HTTP path operations that route incoming requests to their handler functions.');
    subject.operations = [{ entry_point_id: 'api_get', entry_point_type: 'api', action: 'Define' }];
    subject.evidence_examples = ['get: get path operation http route handler'];
    const evaluation = evaluateCapabilityCatalogAudience([subject], [], ['httpx', 'starlette'], ['web framework', 'path operations']);
    expect(evaluation.rejections.filter(rejection => rejection.reasons.includes('identifier-vocabulary'))).toEqual([]);
  });

  it('accepts an exact first-party noun even when it prefixes a longer trusted identifier', () => {
    const subject = capability(
      'View memo views',
      'Users can view memo views as part of their normal workflow whenever needed.',
    );

    const evaluation = evaluateCapabilityCatalogAudience(
      [subject], [], [], ['memo', 'memo view', 'memos-v1-memoviewservice'],
    );

    expect(evaluation.accepted.map(item => item.name)).toEqual(['View memo views']);
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

describe('operation semantic grounding', () => {
  it('rejects account creation claims inferred solely from a POST login route', () => {
    const authentication = capability(
      'Authenticate user account',
      'User account records are created upon successful authentication to establish a persistent identity.',
    );
    authentication.operations = [{
      entry_point_id: 'login',
      entry_point_type: 'http',
      action: 'Create',
      path_or_command: '/api/users/login',
      trigger: { method: 'POST', path: '/api/users/login' },
    }];

    const evaluation = evaluateCapabilityCatalogAudience(
      [authentication], [], [], ['Users authenticate accounts.'],
    );
    expect(evaluation.accepted).toEqual([]);
    expect(evaluation.rejections[0]).toEqual(expect.objectContaining({
      target: 'description',
      reasons: expect.arrayContaining(['operation-semantic-contradiction']),
    }));

    authentication.description = 'Validates user credentials and creates a secure session for protected features.';
    expect(evaluateCapabilityCatalogAudience(
      [authentication], [], [], ['Users authenticate accounts.'],
    ).accepted).toHaveLength(1);
  });
});

describe('unsupported absence claims', () => {
  it('rejects claims that authentication, authorization, or dependencies are absent without proof', () => {
    const articles = capability(
      'Create articles',
      'Users create articles without requiring authentication or external dependencies.',
    );
    articles.operations = [{
      entry_point_id: 'create-article',
      entry_point_type: 'http',
      action: 'Create article',
      trigger: { method: 'POST', path: '/articles' },
    }];

    const evaluation = evaluateCapabilityCatalogAudience(
      [articles], [], [], ['Users create and publish articles.'],
    );

    expect(evaluation.accepted).toEqual([]);
    expect(evaluation.rejections[0]).toEqual(expect.objectContaining({
      target: 'description',
      reasons: expect.arrayContaining(['unsupported-absence-claim']),
      flaggedTokens: expect.arrayContaining([
        'without requiring authentication or external dependencies',
      ]),
    }));
  });
});

it('rejects unsupported workflow and security-state absence claims', () => {
  const article = capability(
    'Update articles',
    'Authors update articles without intermediate workflows.',
  );
  const account = capability(
    'Update user profile',
    'Users update their profile without altering authentication state or permissions.',
  );
  const evaluation = evaluateCapabilityCatalogAudience(
    [article, account], [], [], ['Users update articles and user profiles.'],
  );

  expect(evaluation.accepted).toEqual([]);
  expect(evaluation.rejections.map(rejection => rejection.reasons)).toEqual([
    expect.arrayContaining(['unsupported-absence-claim']),
    expect.arrayContaining(['unsupported-absence-claim']),
  ]);
});

it('rejects unsupported access-enforcement guarantees', () => {
  const auth = capability(
    'Authenticate user accounts',
    'Credential validation establishes sessions, enforcing identity verification before access to protected resources.',
  );
  const evaluation = evaluateCapabilityCatalogAudience(
    [auth], [], [], ['Users authenticate accounts.'],
  );

  expect(evaluation.accepted).toEqual([]);
  expect(evaluation.rejections[0].reasons).toContain('unsupported-exclusivity-claim');
});

it('rejects unsupported immutability guarantees and accepts directly evidenced immutability', () => {
  const unsupported = capability(
    'Create and update articles',
    'Articles are persisted as immutable state changes visible to readers.',
  );
  unsupported.operations = [{
    entry_point_id: 'update-article',
    entry_point_type: 'http',
    action: 'Update article',
    trigger: { method: 'PUT', path: '/articles/:slug' },
  }];
  expect(evaluateCapabilityCatalogAudience(
    [unsupported], [], [], ['Users create and update articles.'],
  ).rejections[0].reasons).toContain('unsupported-exclusivity-claim');

  const supported = capability(
    'Record article revisions',
    'Article revisions are persisted as immutable records.',
  );
  supported.operations = [{
    entry_point_id: 'record-revision',
    entry_point_type: 'message',
    action: 'Persist immutable article revision',
  }];
  expect(evaluateCapabilityCatalogAudience(
    [supported], [], [], ['Article revisions preserve immutable history.'],
  ).accepted).toEqual([supported]);
});

it('rejects unsupported latency guarantees but accepts first-party real-time claims', () => {
  const comments = capability(
    'Post and delete comments',
    'Comment changes appear immediately in the article discussion.',
  );
  expect(evaluateCapabilityCatalogAudience(
    [comments], [], [], ['Users discuss articles.'],
  ).rejections[0].reasons).toContain('unsupported-exclusivity-claim');

  comments.description = 'Comment changes appear in real time in the article discussion.';
  expect(evaluateCapabilityCatalogAudience(
    [comments], [], [], ['The product provides real-time article discussions.'],
  ).accepted).toEqual([comments]);
});

it('removes only unsupported absence clauses while preserving the positive product statement', () => {
  expect(removeUnsupportedCapabilityAbsenceClaims(
    'User profile details can be changed and saved without altering authentication state or permissions.',
  )).toBe('User profile details can be changed and saved.');
  expect(removeUnsupportedCapabilityAbsenceClaims(
    'Authors update articles without intermediate workflows.',
  )).toBe('Authors update articles.');
  expect(removeUnsupportedCapabilityAbsenceClaims(
    'Articles change without intermediate record abstraction.',
  )).toBe('Articles change.');
  expect(removeUnsupportedCapabilityAbsenceClaims(
    'Login establishes a session without exposing password data.',
  )).toBe('Login establishes a session.');
  expect(removeUnsupportedCapabilityAbsenceClaims(
    'Authentication verifies submitted credentials for account access.',
  )).toBe('Authentication verifies submitted credentials for account access.');
});
it('normalizes unsupported timing and transport mechanics while preserving product behavior', () => {
  expect(normalizeCapabilityDescriptionForPublication(
    'Users update their profile after a PUT request to /api/user, reflecting modified account details without altering authentication state.',
  )).toBe('Users update their profile, reflecting modified account details.');
  expect(normalizeCapabilityDescriptionForPublication(
    "Users favorite articles using the article's slug as an identifier, with changes reflected immediately in their favorites.",
  )).toBe('Users favorite articles, with changes reflected in their favorites.');
  expect(normalizeCapabilityDescriptionForPublication(
    'An article comment can be permanently removed by its author, reflecting the deletion action observed in the API endpoint DELETE /api/articles/{slug}/comments/{comment_id}.',
  )).toBe('An article comment can be removed by its author.');
  expect(normalizeCapabilityDescriptionForPublication(
    'Comments appear in real time in the article discussion.',
    ['The product provides real-time article discussions.'],
  )).toBe('Comments appear in real time in the article discussion.');
  expect(normalizeCapabilityDescriptionForPublication(
    'Axum maps incoming HTTP requests to handler functions using a macro-free routing system.',
  )).toBe('Axum maps incoming HTTP requests to handler functions using a macro-free routing system.');
  expect(normalizeCapabilityDescriptionForPublication(
    'Axum produces HTTP responses from handler outputs using built-in conversion traits.',
  )).toBe('Axum produces HTTP responses from handler outputs using built-in conversion traits.');
});


it('rejects opaque catalog prompt identifiers from published descriptions', () => {
  const auth = capability(
    'Authenticate user accounts',
    'User accounts establish session identity using the required subject term in candidate_1.',
  );
  const evaluation = evaluateCapabilityCatalogAudience(
    [auth], [], [], ['Users authenticate accounts.'],
  );

  expect(evaluation.accepted).toEqual([]);
  expect(evaluation.rejections[0].reasons).toContain('internal-mechanism-language');
});

it('rejects HTTP transport mechanics from published descriptions', () => {
  const comments = capability(
    'Post and delete comments',
    'Users submit a request payload to the comments endpoint before a DELETE operation removes a comment.',
  );
  const evaluation = evaluateCapabilityCatalogAudience(
    [comments], [], [], ['Users post and delete comments.'],
  );

  expect(evaluation.accepted).toEqual([]);
  expect(evaluation.rejections[0].reasons).toContain('internal-mechanism-language');
});

it('rejects source-level URL slugs from published descriptions', () => {
  const comments = capability(
    'Comment on articles',
    'Users post comments on an article selected via its slug.',
  );
  const evaluation = evaluateCapabilityCatalogAudience(
    [comments], [], [], ['Users comment on articles.'],
  );

  expect(evaluation.accepted).toEqual([]);
  expect(evaluation.rejections[0].reasons).toContain('internal-mechanism-language');
});

it('allows a parent resource named by every nested operation without merging entity ownership', () => {
  const comment = dataEntity('entity_comment', 'Comment', 'persisted-entity');
  const article = dataEntity('entity_article', 'Article', 'persisted-entity');
  comment.relations = [{ target_name: 'Article', relation_type: 'ManyToOne', kind: 'data', evidence_source: 'orm-declaration', evidence: 'Comment.article' }];
  article.relations = [{ target_name: 'Comment', relation_type: 'OneToMany', kind: 'data', evidence_source: 'orm-declaration', evidence: 'Article.comments' }];
  const comments = capability(
    'Create and delete comments',
    'Comments can be created on articles and deleted from their article discussions.',
  );
  comments.related_entities = [comment.id];
  comments.operations = [
    { entry_point_id: 'create-comment', entry_point_type: 'http', action: 'Create', path_or_command: '/articles/:slug/comments' },
    { entry_point_id: 'delete-comment', entry_point_type: 'http', action: 'Delete', path_or_command: '/articles/:slug/comments/:id' },
  ];

  const entryPoints = comments.operations.map(operation => ({
    id: operation.entry_point_id, source_node: `node-${operation.entry_point_id}`, type: 'http' as const,
    name: operation.entry_point_id,
    trigger: { method: operation.action === 'Create' ? 'POST' : 'DELETE', path: operation.path_or_command },
  }));
  comments.operations.forEach((operation, index) => { operation.trigger = entryPoints[index].trigger; });
  const evaluation = evaluateCapabilityCatalogAudience([comments], [comment, article], [], [], { entryPoints });
  expect(evaluation.accepted).toEqual([comments]);
  expect(evaluation.accepted[0].related_entities).toEqual([comment.id]);
});

it('rejects a foreign entity that is absent from any operation scope', () => {
  const profile = dataEntity('entity_profile', 'Profile', 'persisted-entity');
  const article = dataEntity('entity_article', 'Article', 'persisted-entity');
  const follow = capability(
    'Follow profiles',
    'Profiles can be followed to include their articles in a personalized feed.',
  );
  follow.related_entities = [profile.id];
  profile.relations = [{ target_name: 'User', relation_type: 'OneToOne', kind: 'data', evidence_source: 'orm-declaration', evidence: 'Profile.user' }];
  follow.operations = [
    { entry_point_id: 'follow-profile', entry_point_type: 'http', action: 'Follow', path_or_command: '/profiles/:username/follow' },
    { entry_point_id: 'unfollow-profile', entry_point_type: 'http', action: 'Unfollow', path_or_command: '/profiles/:username/follow' },
  ];

  const entryPoints = follow.operations.map(operation => ({
    id: operation.entry_point_id, source_node: `node-${operation.entry_point_id}`, type: 'http' as const,
    name: operation.entry_point_id,
    trigger: { method: operation.action === 'Follow' ? 'POST' : 'DELETE', path: operation.path_or_command },
  }));
  follow.operations.forEach((operation, index) => { operation.trigger = entryPoints[index].trigger; });
  const evaluation = evaluateCapabilityCatalogAudience([follow], [profile, article], [], [], { entryPoints });
  expect(evaluation.accepted).toEqual([]);
  expect(evaluation.rejections).toEqual(expect.arrayContaining([
    expect.objectContaining({ reasons: expect.arrayContaining(['unrelated-entity-vocabulary']), flaggedTokens: ['Article'] }),
  ]));
});

it('carries a first-party audience into description repair without inventing one', () => {
  const feed = capability('Read articles from the feed', 'Users read articles without requiring manual refresh.');
  feed.operations = [{ entry_point_id: 'feed', entry_point_type: 'http', action: 'List' }];
  const grounded = evaluateCapabilityCatalogAudience(
    [feed], [], [], [], { productText: { productDocSummary: 'Users read articles from a personalized feed.' } },
  );
  expect(grounded.rejections[0]).toEqual(expect.objectContaining({
    missingAudience: 'Users',
    missingAudienceLocations: ['description'],
  }));

  const ungrounded = evaluateCapabilityCatalogAudience([feed], [], [], []);
  expect(ungrounded.rejections[0].missingAudience).toBeUndefined();
});

it('derives a generic user audience only from a matching user-facing journey', () => {
  const feed = capability('Read articles from the feed', 'Articles are listed without requiring manual refresh.');
  feed.operations = [{ entry_point_id: 'feed', entry_point_type: 'http', action: 'List' }];
  const journey = {
    id: 'journey-feed', name: 'Read feed', journey_kind: 'user-facing' as const, entry_point_id: 'feed',
    entry: { type: 'http', name: 'GET /feed' }, steps: [],
    terminal_effects: { entities_written: [], entities_read: [], external_services: [], messages_emitted: [] },
    terminal_entities: [], security_boundaries: [], tests_covering: [], criticality: 'low' as const,
    call_chain_ids: [], exit_point_ids: [],
  };
  const grounded = evaluateCapabilityCatalogAudience([feed], [], [], [], { userJourneys: [journey] });
  expect(grounded.rejections[0].missingAudience).toBe('Users');

  const unrelated = evaluateCapabilityCatalogAudience([feed], [], [], [], {
    userJourneys: [{ ...journey, entry_point_id: 'other' }],
  });
  expect(unrelated.rejections[0].missingAudience).toBeUndefined();
});

it('requires one unambiguous first-party audience for deterministic description repair', () => {
  const feed = capability('Read articles from the feed');
  expect(groundedCapabilityAudience(feed, { productDocSummary: 'Users read articles from a personalized feed.' }, [])).toBe('Users');
  expect(groundedCapabilityAudience(feed, { productDocSummary: 'You can read articles from your personalized feed.' }, [])).toBe('Users');
  expect(groundedCapabilityAudience(feed, { productDocSummary: 'Operators curate feeds while customers read articles.' }, [])).toBeUndefined();
  expect(groundedCapabilityAudience(feed, undefined, [])).toBeUndefined();
  const eventCapability = {
    ...feed,
    operations: [{ entry_point_id: 'fetch-record', entry_point_type: 'event' as const, action: 'read' }],
  };
  expect(groundedCapabilityAudience(eventCapability, undefined, [], [{
    id: 'fetch-record',
    type: 'event',
    name: 'Details click',
    description: 'User click event handled by fetchRecord',
    source_node: 'component',
    source_analyzer: 'react',
    metadata: { source_analyzer: 'react', interaction_label: 'Fetch record', handler_binding_node_ids: ['fetch-record-handler'] },
  }])).toBe('Users');
  const pageCapability = {
    ...feed,
    operations: [{ entry_point_id: 'statistics-page', entry_point_type: 'page' as const, action: 'view' }],
  };
  const exactPage = {
    id: 'statistics-page', type: 'page' as const, name: 'Page Statistics', source_node: 'statistics-component',
    source_analyzer: 'react', handler: { node_id: 'statistics-component', method_name: 'StatisticsView', file: 'StatisticsView.tsx' },
    metadata: { source_analyzer: 'react', trigger_kind: 'page-component', component: 'StatisticsView' },
  };
  expect(groundedCapabilityAudience(pageCapability, undefined, [], [exactPage])).toBe('Users');
  expect(groundedCapabilityAudience(pageCapability, undefined, [], [{
    ...exactPage,
    handler: { ...exactPage.handler, node_id: 'different-component' },
  }])).toBeUndefined();
  expect(groundedCapabilityAudience(pageCapability, undefined, [], [{
    ...exactPage,
    source_analyzer: 'generic',
    metadata: { ...exactPage.metadata, source_analyzer: 'generic' },
  }])).toBeUndefined();
  for (const type of ['http', 'schedule', 'cli'] as const) {
    expect(groundedCapabilityAudience({ ...eventCapability, operations: [{ entry_point_id: `non-ui-${type}`, entry_point_type: type, action: 'read' }] }, undefined, [], [{
      id: `non-ui-${type}`,
      type,
      name: 'Fetch records',
      description: 'User fetch operation',
      source_node: 'handler',
      metadata: { interaction_label: 'Fetch records', handler_binding_node_ids: ['handler'] },
    }])).toBeUndefined();
  }
});


it('accepts cross-entity product language only when a verified flow dependency grounds it', () => {
  const categorize = capability(
    'Automate transaction categorization',
    'Transaction rules assign categories during bulk financial updates for later review.',
  );
  categorize.related_entities = ['entity_rule'];
  categorize.depends_on = [{
    from_capability: 'bulk-transactions', to_capability: 'rules', dependency_type: 'shares-data', strength: 'common',
    evidence: { shared_services: [], shared_nodes: [], shared_entities: ['Rule', 'Transaction', 'Category'] },
    description: 'Bulk transaction updates share rule and category data',
  }];
  const entities = [
    dataEntity('entity_rule', 'Rule', 'persisted-entity'),
    dataEntity('entity_transaction', 'Transaction', 'persisted-entity'),
    dataEntity('entity_category', 'Category', 'persisted-entity'),
  ];

  expect(evaluateCapabilityCatalogAudience([categorize], entities, [], ['financial']).accepted).toEqual([categorize]);
  expect(evaluateCapabilityCatalogAudience([{ ...categorize, depends_on: [] }], entities, [], ['financial']).accepted).toEqual([]);
});



it('accepts product subjects preserved from cited candidate domains', () => {
  const importUpload = capability('Import uploads', 'Users import uploads through the observed upload workflow.');
  importUpload.operations = [{ entry_point_id: 'upload-view', entry_point_type: 'http', action: 'read', path_or_command: '/upload' }];
  importUpload.related_domains = ['import-upload'];
  const entities = [
    dataEntity('entity_import', 'Import', 'persisted-entity'),
    dataEntity('entity_upload', 'Upload', 'persisted-entity'),
  ];

  expect(evaluateCapabilityCatalogAudience([importUpload], entities, [], []).accepted).toEqual([importUpload]);
  expect(evaluateCapabilityCatalogAudience([{ ...importUpload, related_domains: [] }], entities, [], []).accepted).toEqual([]);
});
