import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { aiService } from '../../ai/ai-service';
import { validateElementDescription } from '../../ai/element-description-validator';
import { filterPlausibleExternalServices, isPlausibleExternalServiceName } from '../../ai/external-service-plausibility';

// These exercise internal heuristics of the orchestrator. They are private by
// design (not part of the public CAS contract) so the tests reach them via a
// typed `any` handle rather than widening the class surface.
const orch = new AnalyzerOrchestrator() as any;

describe('shared element description validator', () => {
  const subject = { name: 'Session Authentication', relatedDomains: ['session'] };

  it('accepts domain-correct bare verbs like handles and processes', () => {
    expect(validateElementDescription(
      'Session Authentication handles session keepalive frames and processes authentication packets between gateway peers.',
      subject,
    ).ok).toBe(true);
  });

  it('rejects generic filler phrasing instead of bare verbs', () => {
    const result = validateElementDescription(
      'Session Authentication facilitates the interaction between session services and protocol modules to support secure data transmission.',
      subject,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('generic-structural-phrase');
  });

  it('rejects structural house-style operation lists', () => {
    const result = validateElementDescription(
      'Session Authentication covers read, process, and delete paths for session records inside the gateway modules.',
      subject,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('generic-structural-phrase');
  });

  it('rejects descriptions that never reference the target subject', () => {
    const result = validateElementDescription(
      'This area maintains records and relationships used by the rest of the product so workflows stay consistent over time.',
      subject,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('target-not-grounded');
  });

  it('rejects ungrounded marketing language but allows subject-grounded matches', () => {
    const compliance = { name: 'Compliance Management', relatedDomains: ['compliance'] };
    expect(validateElementDescription(
      'Compliance Management tracks compliance records and inspection events tied to each vehicle in the fleet system.',
      compliance,
    ).ok).toBe(true);

    const result = validateElementDescription(
      'Session Authentication delivers a seamless and robust experience for compliant session workflows in the gateway.',
      subject,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unsupported-marketing-language');
  });

  it('is the validator used by both the combined path and the orchestrator wrapper', () => {
    const target = { id: 'cap_0', name: 'Session Authentication', kind: 'capability', relatedDomains: ['session'], fields: [] };
    const text = 'Session Authentication facilitates the interaction between session services and protocol modules to support secure data transmission.';
    expect(orch.validateElementDescription(text, target).reason).toBe('generic-structural-phrase');
    expect(orch.validateElementDescription(
      'Session Authentication handles session keepalive and renegotiation between gateway peers before traffic is allowed through.',
      target,
    ).ok).toBe(true);
  });
});

describe('curated capability fallback honesty', () => {
  it('suppresses the product-voice template for code-identifier subjects', () => {
    for (const name of ['Fmt Management', 'Lib Management', 'Mod Management']) {
      expect(orch.curatedElementDescription({
        id: 'cap_x',
        name,
        kind: 'capability',
        operations: [],
        relatedEntities: ['entity_x'],
        relatedDomains: [],
      })).toBeUndefined();
    }
  });

  it('suppresses the template when no related entities ground the records claim', () => {
    expect(orch.curatedElementDescription({
      id: 'cap_x',
      name: 'Payment Management',
      kind: 'capability',
      operations: [],
      relatedEntities: [],
      relatedDomains: ['payment'],
    })).toBeUndefined();
  });

  it('keeps the entity-grounded template for real management capabilities', () => {
    expect(orch.curatedElementDescription({
      id: 'cap_x',
      name: 'Payment Management',
      kind: 'capability',
      operations: [],
      relatedEntities: ['entity_payment'],
      relatedDomains: ['payment'],
    })).toBe('Payment Management maintains payment records, workflows, and relationships used by payment behavior.');
  });

  it('does not relabel non-management capabilities as Management', () => {
    const description = orch.curatedElementDescription({
      id: 'cap_x',
      name: 'Session Authentication',
      kind: 'capability',
      operations: [],
      relatedEntities: ['entity_session'],
      relatedDomains: ['session'],
    });
    expect(description || '').not.toContain('Session Management');
    if (description) {
      expect(description).toContain('Session Authentication');
    }
  });
});

describe('external service plausibility filter', () => {
  it('drops Rust types and self references that poisoned exit-point extraction', () => {
    const poisoned = ['socket', 'FuturesUnorderedBounded', 'SliceBuffer', 'Packet', 'pool', 'OffsetDateTime', 'BufferPool', 'zerac'];
    expect(filterPlausibleExternalServices(poisoned, ['poc', 'zerac'])).toEqual([]);
  });

  it('keeps known services, domain-shaped names, and service-shaped integration wrappers', () => {
    expect(isPlausibleExternalServiceName('Stripe', ['soon-sync'])).toBe(true);
    expect(isPlausibleExternalServiceName('api.telematics.example.com', ['fleet-api'])).toBe(true);
    expect(isPlausibleExternalServiceName('CollectService', ['soon-sync'])).toBe(true);
    expect(isPlausibleExternalServiceName('MeshPortfolioService', ['soon-sync'])).toBe(true);
  });

  it('feeds only plausible names into the combined interpretation prompt facts', () => {
    const previousPath = orch.activeAnalysisProjectPath;
    orch.activeAnalysisProjectPath = '/Users/example/dev/zerac/poc';
    try {
      const facts = orch.buildAIInterpretationFacts(
        'poc',
        ['Rust'],
        [],
        [],
        ['socket', 'Packet', 'BufferPool', 'zerac', 'Stripe'],
        orch.emptyFlowGraph(),
        [],
        [],
        [],
      );
      expect(facts.externalServices).toEqual(['Stripe']);
    } finally {
      orch.activeAnalysisProjectPath = previousPath;
    }
  });
});

describe('AI interpretation budgets for local providers', () => {
  const localEnvKeys = ['KLAURO_OLLAMA_AUTO', 'OLLAMA_BASE_URL', 'LOCAL_OPENAI_BASE_URL', 'OPENAI_BASE_URL', 'AI_TIMEOUT'];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(localEnvKeys.map(key => [key, process.env[key]]));
    for (const key of localEnvKeys) delete process.env[key];
  });

  afterEach(() => {
    for (const key of localEnvKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults the per-request timeout to 120s for local ollama and 30s for cloud', () => {
    const { getAIConfig } = require('../../config/ai.config');
    expect(getAIConfig().openai.timeout).toBe(30000);
    process.env.KLAURO_OLLAMA_AUTO = 'true';
    expect(getAIConfig().openai.timeout).toBe(120000);
    process.env.AI_TIMEOUT = '45000';
    expect(getAIConfig().openai.timeout).toBe(45000);
  });

  it('sizes the interpretation wall budget to fit a local call plus one repair', async () => {
    process.env.KLAURO_OLLAMA_AUTO = 'true';
    const previousLocal = process.env.AI_LOCAL_ENABLED;
    const previousForce = process.env.KLAURO_AI_INTERPRETATION_FORCE;
    const previousBudget = process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS;
    process.env.AI_LOCAL_ENABLED = 'true';
    process.env.KLAURO_AI_INTERPRETATION_FORCE = '1';
    delete process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS;

    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      system_description: 'A code analysis service that builds CAS relationship graphs from repositories and exposes analysis context so coding agents can navigate code structure safely.',
      domain: '',
      descriptions: [],
    }));
    const purpose: any = {
      primary_type: 'developer-tool',
      confidence: 0.9,
      evidence: [],
      primary_domain: 'code-analysis',
      core_concepts: ['code', 'analysis'],
      inferred_description: 'A code analysis service.',
      supporting_workflow_ids: [],
    };

    try {
      await orch.applyAIInterpretation(purpose, 'analysis-api', [], [], [], [], orch.emptyFlowGraph(), []);
    } finally {
      spy.mockRestore();
      if (previousLocal === undefined) delete process.env.AI_LOCAL_ENABLED;
      else process.env.AI_LOCAL_ENABLED = previousLocal;
      if (previousForce === undefined) delete process.env.KLAURO_AI_INTERPRETATION_FORCE;
      else process.env.KLAURO_AI_INTERPRETATION_FORCE = previousForce;
      if (previousBudget === undefined) delete process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS;
      else process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS = previousBudget;
    }

    expect(purpose.description_generation.budget_ms).toBe(240000);
    expect(purpose.description_generation.status).toBe('ai_applied');
  });
});

describe('keep-better policy and rejection-reason telemetry in the combined path', () => {
  const envKeys = ['AI_LOCAL_ENABLED', 'KLAURO_AI_INTERPRETATION_FORCE', 'KLAURO_AI_INTERPRETATION_BUDGET_MS'];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    process.env.AI_LOCAL_ENABLED = 'true';
    process.env.KLAURO_AI_INTERPRETATION_FORCE = '1';
    process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS = '20000';
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function flowGraphWith(capabilityName: string) {
    return {
      ...orch.emptyFlowGraph(),
      capabilities: [{ id: 'cap-0', name: capabilityName, signals: { total_score: 10 } }],
    };
  }

  it('retains a stronger deterministic system description with reason deterministic-retained-stronger', async () => {
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      system_description: 'A payment and order coordination system built for account workflows that manages payment connections through HTTP endpoints and database operations in the platform.',
      domain: '',
      descriptions: [],
    }));
    const purpose: any = {
      primary_type: 'backend-service',
      confidence: 0.9,
      evidence: [],
      primary_domain: 'order-payment-management',
      core_concepts: ['payment', 'order', 'spending', 'cancellation feedback', 'decision log'],
      inferred_description: 'An order payment management system that coordinates payment, order, spending, cancellation feedback, and decision log workflows, integrating with CollectService and MeshPortfolioService for portfolio operations across accounts.',
      supporting_workflow_ids: [],
    };
    const deterministicBefore = purpose.inferred_description;

    try {
      await orch.applyAIInterpretation(
        purpose,
        'soon-sync',
        ['NestJS'],
        [{ type: 'http', count: 12 }],
        ['Payment', 'Order', 'Spending', 'DecisionLog'],
        ['CollectService', 'MeshPortfolioService'],
        flowGraphWith('Payment Management'),
        [{ id: 'c1', name: 'payment', classification: 'core', frequency: 9 }],
      );
    } finally {
      spy.mockRestore();
    }

    expect(purpose.inferred_description).toBe(deterministicBefore);
    expect(purpose.description_source).toBe('deterministic');
    expect(purpose.description_generation).toEqual(expect.objectContaining({
      status: 'deterministic_kept',
      attempted: true,
      reason: 'deterministic-retained-stronger',
    }));
  });

  it('still applies AI when it is at least as grounded as the deterministic description', async () => {
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      system_description: 'An order payment management system that records payment, order, spending, and decision log activity, and links CollectService and MeshPortfolioService portfolio operations to account workflows over HTTP.',
      domain: '',
      descriptions: [],
    }));
    const purpose: any = {
      primary_type: 'backend-service',
      confidence: 0.9,
      evidence: [],
      primary_domain: 'order-payment-management',
      core_concepts: ['payment', 'order'],
      inferred_description: 'An order payment management backend for payment workflows.',
      supporting_workflow_ids: [],
    };

    try {
      await orch.applyAIInterpretation(
        purpose,
        'soon-sync',
        ['NestJS'],
        [{ type: 'http', count: 12 }],
        ['Payment', 'Order', 'Spending', 'DecisionLog'],
        ['CollectService', 'MeshPortfolioService'],
        flowGraphWith('Payment Management'),
        [{ id: 'c1', name: 'payment', classification: 'core', frequency: 9 }],
      );
    } finally {
      spy.mockRestore();
    }

    expect(purpose.description_source).toBe('ai');
    expect(purpose.description_generation.status).toBe('ai_applied');
  });

  it('preserves the original validator rejection reason when the curated fallback replaces a capability description', async () => {
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      system_description: 'An order payment management system that coordinates payment and order workflows for accounts, exercised through HTTP endpoints and backed by payment and order records.',
      domain: '',
      descriptions: [
        { id: 'cap-0', description: 'This area facilitates the interaction between services to support secure data transmission across the platform.' },
      ],
    }));
    const purpose: any = {
      primary_type: 'backend-service',
      confidence: 0.9,
      evidence: [],
      primary_domain: 'order-payment-management',
      core_concepts: ['payment', 'order'],
      inferred_description: 'An order payment backend.',
      supporting_workflow_ids: [],
    };
    const capabilities: any[] = [{
      id: 'cap-0',
      name: 'Payment Management',
      description: 'Payment Management covers create, read paths; spans payment.',
      description_source: 'deterministic',
      description_generation: { status: 'deterministic_initial', attempted: false },
      category: 'core',
      operations: [],
      related_entities: ['entity_payment'],
      related_domains: ['payment'],
      criticality: 'high',
      criticality_factors: [],
    }];

    try {
      await orch.applyAIInterpretation(
        purpose,
        'soon-sync',
        ['NestJS'],
        [{ type: 'http', count: 12 }],
        ['Payment', 'Order'],
        [],
        flowGraphWith('Payment Management'),
        [{ id: 'c1', name: 'payment', classification: 'core', frequency: 9 }],
        capabilities,
      );
    } finally {
      spy.mockRestore();
    }

    expect(capabilities[0].description).toBe('Payment Management maintains payment records, workflows, and relationships used by payment behavior.');
    expect(capabilities[0].description_generation.reason).toBe('curated-product-capability-description (was: generic-structural-phrase)');
  });

  it('keeps the honest deterministic line when the curated template is suppressed for identifier subjects', async () => {
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      system_description: 'A zero trust security gateway that manages session and packet workflows for network access decisions, exercised through socket entry points and policy checks.',
      domain: '',
      descriptions: [
        { id: 'cap-0', description: 'This area facilitates the interaction between modules to support secure data transmission for the gateway.' },
      ],
    }));
    const purpose: any = {
      primary_type: 'backend-service',
      confidence: 0.9,
      evidence: [],
      primary_domain: 'zero-trust-security',
      core_concepts: ['session', 'packet', 'gateway'],
      inferred_description: 'A zero trust gateway.',
      supporting_workflow_ids: [],
    };
    const deterministicLine = 'Fmt Management covers process, read, send paths; spans fmt.';
    const capabilities: any[] = [{
      id: 'cap-0',
      name: 'Fmt Management',
      description: deterministicLine,
      description_source: 'deterministic',
      description_generation: { status: 'deterministic_initial', attempted: false },
      category: 'supporting',
      operations: [],
      related_entities: [],
      related_domains: [],
      criticality: 'low',
      criticality_factors: [],
    }];

    try {
      await orch.applyAIInterpretation(
        purpose,
        'poc',
        ['Rust'],
        [{ type: 'socket', count: 3 }],
        [],
        [],
        flowGraphWith('Fmt Management'),
        [{ id: 'c1', name: 'session', classification: 'core', frequency: 9 }],
        capabilities,
      );
    } finally {
      spy.mockRestore();
    }

    expect(capabilities[0].description).toBe(deterministicLine);
    expect(capabilities[0].description_generation.status).toBe('ai_rejected');
    expect(capabilities[0].description_generation.reason).toBe('generic-structural-phrase');
  });
});

describe('element description grounding parity with the system validator', () => {
  it('allows marketing-flagged words grounded in the system domain vocabulary', () => {
    const subject = {
      name: 'Policy Management',
      relatedDomains: ['policy'],
      domainVocabulary: [
        'order-card-carrier-management',
        'policy', 'card', 'carrier', 'compliance',
        'A payments and fuel-card client managing order, card, carrier, and policy compliance workflows.',
      ],
    };
    expect(validateElementDescription(
      'Policy Management maintains policy records and compliance rules applied to card and carrier workflows.',
      subject,
    ).ok).toBe(true);
  });

  it('allows marketing-flagged words grounded in related entity names', () => {
    expect(validateElementDescription(
      'Transaction Settlement records settlement outcomes and compliance checks for each card transaction.',
      { name: 'Transaction Settlement', relatedEntities: ['CompliancePolicy', 'CardTransaction'] },
    ).ok).toBe(true);
  });

  it('still rejects ungrounded marketing words and names them for the repair prompt', () => {
    const result = validateElementDescription(
      'Jito Capability submits transaction bundles, enhancing throughput and efficiency for the trading bot.',
      {
        name: 'Jito Capability',
        relatedDomains: ['jito'],
        domainVocabulary: ['solana-trading', 'bundle', 'transaction', 'A Solana trading bot that submits Jito bundles.'],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unsupported-marketing-language');
    expect(result.reason).toContain('enhancing');
    expect(result.reason).toContain('efficiency');
  });

  it('allows grounded multi-word marketing phrases when the domain vocabulary states them', () => {
    expect(validateElementDescription(
      'Experience Personalization tailors the storefront user experience using saved shopper preferences.',
      {
        name: 'Experience Personalization',
        domainVocabulary: ['storefront personalization of the user experience for shoppers'],
      },
    ).ok).toBe(true);
  });

  it('grounds the orchestrator wrapper with system vocabulary and entity names', () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const target = {
      id: 'cap_1',
      name: 'Policy Management',
      kind: 'capability',
      relatedDomains: ['policy'],
      relatedEntities: ['Policy'],
    };
    const text = 'Policy Management maintains policy records and compliance rules used by carrier and card workflows.';

    expect(localOrch.validateElementDescription(text, target).reason).toContain('unsupported-marketing-language');

    localOrch.setElementDescriptionGrounding(
      'order-card-carrier-management',
      ['policy', 'card', 'carrier', 'compliance'],
      'A payments client that manages order, card, carrier, and policy compliance workflows.'
    );
    expect(localOrch.validateElementDescription(text, target).ok).toBe(true);
  });

  it('resolves related entity ids to names in capability description targets', () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const capability = {
      id: 'cap_2',
      name: 'Card Management',
      description: 'Card Management covers read paths.',
      category: 'core',
      operations: [{ entry_point_id: 'ep1', entry_point_type: 'file', action: 'Read', path_or_command: 'src/CardManagementWS.php' }],
      related_entities: ['entity-card'],
      related_domains: ['card'],
      criticality: 'high',
      criticality_factors: [],
    };
    const entityNamesById = new Map([['entity-card', 'FuelCard']]);
    const target = localOrch.capabilityDescriptionTarget(capability, entityNamesById);
    expect(target.relatedEntities).toEqual(['FuelCard']);
    expect(target.operations[0]).toContain('src/CardManagementWS.php');

    const bare = localOrch.capabilityDescriptionTarget(capability);
    expect(bare.relatedEntities).toEqual(['entity-card']);
  });
});
