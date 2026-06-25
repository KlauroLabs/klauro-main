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

  it('rejects short API endpoint restatements for capabilities', () => {
    const result = validateElementDescription(
      'Customer Management manages Customer records through API endpoints.',
      { name: 'Customer Management', relatedDomains: ['customer'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('api-endpoint-restatement');
  });

  it('rejects generic creation-and-management phrasing for capability descriptions', () => {
    const result = validateElementDescription(
      'Codebase Analysis handles the creation and management of AnalysisResult and AnalysisRun entities through scripts inside the MCP server.',
      { name: 'Codebase Analysis', relatedDomains: ['analysis', 'codebase'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('generic-structural-phrase');
  });

  it('rejects source-bucket restatements for capability descriptions', () => {
    const result = validateElementDescription(
      'Visual Capability enables script-based visualization of system behavior and state.',
      { name: 'Visual Capability', relatedDomains: ['visual'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('source-bucket-restatement');
  });

  it('rejects file coordination restatements for capability descriptions', () => {
    const result = validateElementDescription(
      'Agent Work Packets manages the creation and coordination of files related to agent adoption and measurement.',
      { name: 'Agent Work Packets', relatedDomains: ['agent'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('generic-structural-phrase');
  });

  it('rejects descriptions that name implementation source files', () => {
    const result = validateElementDescription(
      'Agent Work Packets prepares coding briefs for agents by coordinating agent-adoption.ts and agent-adoption-measurement.ts.',
      { name: 'Agent Work Packets', relatedDomains: ['agent'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('source-file-restatement');
  });

  it('rejects Terraform source-file restatements for infrastructure entry descriptions', () => {
    const result = validateElementDescription(
      'Orientation entry platform/modules/vpc/variables.tf helps engineers configure VPC settings before deploying cloud infrastructure.',
      { name: 'Orientation entry platform/modules/vpc/variables.tf', kind: 'entry_point', relatedDomains: ['infrastructure'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('source-file-restatement');
  });

  it('cleans broken infrastructure boilerplate grammar from system summaries', () => {
    const cleaned = orch.cleanGeneratedDescriptionText(
      'soon-infra is a cloud infrastructure system. The system is designed to organizes the creation and management of cloud resources via structured file-based workflows.'
    );

    expect(cleaned).toBe(
      'soon-infra is a cloud infrastructure system. The system defines cloud resources as structured infrastructure that can be reviewed before deployment.'
    );
  });

  it('rejects capability descriptions that summarize implementation functions', () => {
    const result = validateElementDescription(
      'Agent Work Packets coordinates and generates functions to process and format data for structured output.',
      { name: 'Agent Work Packets', kind: 'capability', relatedDomains: ['agent'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('implementation-function-restatement');
  });

  it('rejects capability descriptions that list helper function examples', () => {
    const result = validateElementDescription(
      'Agent Work Packets organizes and executes specific functions like parseArgs, formatTable, and renderRow to process and structure data.',
      { name: 'Agent Work Packets', kind: 'capability', relatedDomains: ['agent'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('implementation-function-restatement');
  });

  it('rejects capability descriptions that leak internal code identifiers', () => {
    const result = validateElementDescription(
      'CAS Contract Validation helps engineers coordinate parseCasVersion, estimateCasSourceTokens, scoreCasOrganization, and other CAS-related functions before proceeding with codebase analysis tasks.',
      { name: 'CAS Contract Validation', kind: 'capability', relatedDomains: ['cas'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('implementation-identifier-restatement');
  });

  it('rejects capability descriptions that coordinate scripts instead of naming product behavior', () => {
    const result = validateElementDescription(
      'Usage Management helps engineers coordinate scripts model usage and read agents usage before creating or importing components.',
      { name: 'Usage Management', kind: 'capability', relatedDomains: ['usage'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('generic-structural-phrase');
  });

  it('rejects local-model implementation summaries for capability cards', () => {
    const badSummaries = [
      'Runtime Telemetry provides codebase performance by collecting and exposing metrics like memory leaks, bottlenecks, and hotspots through HTTP endpoints.',
      'MCP Server coordinates the setup and maintenance of analysis environments, supporting agent adoption and task benchmarking through script execution and configuration.',
      'Klauro Runtime SDK provides tools for developers to integrate and extend analysis capabilities, supporting agent workflows and codebase interaction through Python-based SDKs.',
      'Klauro Runtime SDK provides tools for AI agents to interact with codebases, enabling them to analyze, modify, and generate code based on predefined guidelines.',
      'Trace Management handles the collection and processing of trace data, enabling the construction of call and flow graphs to visualize code execution paths.',
      'Trace Management captures and processes trace data, supporting detailed analysis of code execution paths and interactions between components.',
      'Codebase Analysis generates and maintains AnalysisResults and AnalysisRuns to provide structured code structure and behavior for review and modification.',
      'Web Authentication lets engineers manage company, discount, device, invoice, location, partner, and user records through HTTP endpoints.',
      'Charge Workflow covers handle paths through message handlers.',
      'Latest Management spans scripts.',
      'Connection Capability spans configuration support.',
      'Record Management centralizes the coordination of arbitrage strategies, execution scripts, and optimization logic across CEX, DEX, and liquidity pools.',
    ];

    for (const description of badSummaries) {
      const result = validateElementDescription(
        description,
        { name: description.split(' ').slice(0, 3).join(' '), kind: 'capability', relatedDomains: ['analysis'] },
      );
      expect(result.ok).toBe(false);
      expect(['generic-structural-phrase', 'implementation-surface-restatement', 'too-short']).toContain(result.reason);
    }
  });

  it('rejects legal-contract hallucinations for schema or API contract capabilities', () => {
    const result = validateElementDescription(
      'CAS Contract Validation ensures that agreements between systems are accurate and checks that terms and conditions are properly defined and enforced.',
      { name: 'CAS Contract Validation', kind: 'capability', relatedDomains: ['cas'], domainVocabulary: ['code analysis specification', 'schema validation'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsupported-legal-contract-claim');
  });

  it('keeps concise descriptions when they are specific to the capability subject', () => {
    const result = validateElementDescription(
      'Order Reconciliation manages order settlement across payment providers.',
      { name: 'Order Reconciliation', relatedDomains: ['order', 'payment'] },
    );
    expect(result.ok).toBe(true);
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

  it('keeps the management template when the subject itself is a useful domain noun', () => {
    expect(orch.curatedElementDescription({
      id: 'cap_x',
      name: 'Payment Management',
      kind: 'capability',
      operations: [],
      relatedEntities: [],
      relatedDomains: ['payment'],
    })).toBe('Payment Management maintains payment records, workflows, and relationships used by payment behavior.');
  });

  it('suppresses management templates for ungrounded infrastructure/process nouns', () => {
    expect(orch.curatedElementDescription({
      id: 'cap_x',
      name: 'Pipeline Management',
      kind: 'capability',
      operations: [],
      relatedEntities: [],
      relatedDomains: [],
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
    expect(isPlausibleExternalServiceName('Pusher', ['chat-api'])).toBe(true);
    expect(isPlausibleExternalServiceName('Taxjar', ['commerce-api'])).toBe(true);
    expect(isPlausibleExternalServiceName('Geocodio', ['location-api'])).toBe(true);
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

  it('defaults the per-request timeout to 120s for local ollama and 90s for cloud', () => {
    const { getAIConfig } = require('../../config/ai.config');
    // Cloud default is 90s: a hosted-70B catalog/narrative call sends a large
    // fact bundle and returns structured JSON on highly variable shared inference;
    // a short timeout cut it off, burning the retry budget before any result.
    expect(getAIConfig().openai.timeout).toBe(90000);
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
      system_description: 'A code analysis service builds CAS relationship graphs from repositories for coding agents. It exposes analysis context so agents can navigate code structure, risks, and tests before editing.',
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
    delete process.env.KLAURO_AI_INTERPRETATION_FORCE;
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      system_description: 'A payment and order coordination system manages account payment connections through HTTP endpoints. It keeps account payments tied to order records for backend workflows without covering the wider portfolio lifecycle.',
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

  it('rejects AI without retaining deterministic summaries that use analyzer jargon', async () => {
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      system_description: 'An order management system built with Angular that coordinates company, offer, suggestion, and upload workflows. It connects to HTTP API Connection and apollo-angular to manage user, portal, and company data.',
      domain: '',
      descriptions: [],
    }));
    const purpose: any = {
      primary_type: 'frontend-app',
      confidence: 0.88,
      evidence: [],
      primary_domain: 'order-management',
      core_concepts: ['company', 'offer', 'suggestion', 'upload'],
      inferred_description: 'An order management system built with Angular that coordinates company, offer, suggestion, and upload workflows. It is exercised through route entry points and lifecycle entry points, and it connects to HTTP API Connection, jose, and apollo-angular.',
      supporting_workflow_ids: [],
    };

    try {
      await orch.applyAIInterpretation(
        purpose,
        'internalPortal',
        ['Angular'],
        [{ type: 'route', count: 20 }],
        [],
        ['HTTP API Connection', 'jose', 'apollo-angular'],
        flowGraphWith('Offer Management'),
        [{ id: 'c1', name: 'offer', classification: 'core', frequency: 9 }],
      );
    } finally {
      spy.mockRestore();
    }

    expect(purpose.description_source).toBe('deterministic');
    expect(purpose.description_generation).toEqual(expect.objectContaining({
      status: 'ai_rejected',
      attempted: true,
      reason: expect.stringContaining('generic-concept-ending'),
    }));
  });

  it('still applies AI when it is at least as grounded as the deterministic description', async () => {
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      system_description: 'An order payment management system records payment, order, spending, and decision log activity for account workflows. It links CollectService and MeshPortfolioService portfolio operations to HTTP-facing payment behavior.',
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

  it('keeps AI-sourced descriptions after removing source-bucket wording from small CLI repos', async () => {
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      system_description: 'A script-based solana arbitrage bot watches new token pairs, bonding curve progress, and market-cap signals before choosing when to buy or sell. It uses file-based entry points and connects to @solana/web3.js for chain access while applying profit target, stop-loss, and curve thresholds around trading decisions.',
      domain: '',
      descriptions: [],
    }));
    const purpose: any = {
      primary_type: 'automation-tool',
      confidence: 0.9,
      evidence: [],
      primary_domain: 'solana-arbitrage',
      core_concepts: ['solana', 'arbitrage', 'trading', 'token pairs'],
      inferred_description: 'A solana arbitrage system that coordinates trade execution and pairs workflows.',
      supporting_workflow_ids: [],
    };

    try {
      await orch.applyAIInterpretation(
        purpose,
        'treecity',
        [],
        [{ type: 'cli', count: 1 }],
        [],
        ['@solana/web3.js'],
        flowGraphWith('Trade Execution'),
        [{ id: 'c1', name: 'solana arbitrage', classification: 'core', frequency: 9 }],
      );
    } finally {
      spy.mockRestore();
    }

    expect(purpose.description_source).toBe('ai');
    expect(purpose.description_generation.status).toBe('ai_applied');
    expect(purpose.inferred_description).toContain('solana arbitrage bot watches new token pairs');
    expect(purpose.inferred_description).not.toMatch(/script[- ]based|internal script|source files?|file[- ]based entry points?/i);
  });

  it('preserves the original validator rejection reason when the curated fallback replaces a capability description', async () => {
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      system_description: 'An order payment management system maintains payment and order workflows for account activity. It is exercised through HTTP endpoints and backed by payment and order records.',
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
      system_description: 'A zero trust security gateway manages session and packet workflows for network access decisions. It is exercised through socket entry points and policy checks.',
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

describe('self-analysis AI description guardrails', () => {
  const purpose: any = {
    primary_type: 'developer-tool',
    confidence: 0.9,
    evidence: [],
    primary_domain: 'codebase-analysis',
    core_concepts: ['CAS', 'MCP', 'codebase analysis', 'agent work packets'],
    inferred_description: 'Klauro builds CAS relationship graphs for AI agents and human codebase inspection.',
    supporting_workflow_ids: [],
  };

  it('rejects stale legacy API summaries for the Klauro repo itself', () => {
    const result = orch.validateGeneratedAIInterpretation(
      'A codebase analysis system built with Ruby that coordinates workspace, project, and user workflows to produce analyzer controller records. It manages workspaces, projects, and users through HTTP endpoints.',
      purpose,
      { isKlauroSelfProject: true, structuralTokens: ['codebase', 'analysis', 'workspace', 'project'] },
    );

    expect(result).toEqual({ ok: false, reason: 'legacy-self-api-pollution' });
  });

  it('rejects self summaries centered on stale auth and route surfaces', () => {
    const result = orch.validateGeneratedAIInterpretation(
      'Klauro is a codebase analysis system that builds relationship graphs for AI agents and human code reviewers. It focuses on analyzing codebases, validating contracts, storing analysis results, and providing telemetry data to help agents understand and modify repositories. The system integrates with Redis and JWT services for caching and authentication, and it supports HTTP, message, and WebSocket entry points for communication.',
      purpose,
      { isKlauroSelfProject: true, structuralTokens: ['codebase', 'analysis', 'agent', 'telemetry'] },
    );

    expect(result).toEqual({ ok: false, reason: 'legacy-self-api-pollution' });
  });

  it('accepts self descriptions that lead with CAS, MCP, agent guidance, and analysis storage', () => {
    const result = orch.validateGeneratedAIInterpretation(
      'Klauro builds CAS relationship graphs from repositories so AI agents can understand codebase structure before editing. It exposes MCP work packets, idiom guidance, proposal previews, incremental analysis, telemetry correlation, and analysis storage for development workflows.',
      purpose,
      { isKlauroSelfProject: true, structuralTokens: ['codebase', 'analysis', 'agent', 'storage'] },
    );

    expect(result.ok).toBe(true);
  });

  it('prioritizes current Klauro analyzer and MCP capabilities over legacy API residue', () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    jest.spyOn(localOrch, 'isKlauroSelfProject').mockReturnValue(true);
    const capabilities = [
      { name: 'Workspaces Management', related_domains: ['workspace'] },
      { name: 'Projects Management', related_domains: ['project'] },
      { name: 'Codebase Analysis', related_domains: ['analysis'] },
      { name: 'Agent Work Packets', related_domains: ['agent'] },
      { name: 'Proposal Preview', related_domains: ['proposal'] },
      { name: 'Codebase Idiom Guidance', related_domains: ['idiom'] },
      { name: 'Analysis Storage', related_domains: ['storage'] },
    ];

    const prioritized = localOrch.prioritizeKlauroSelfCapabilities(capabilities, '/tmp/klauro');

    expect(prioritized.map((capability: any) => capability.name)).toEqual([
      'Codebase Analysis',
      'Agent Work Packets',
      'Proposal Preview',
      'Codebase Idiom Guidance',
      'Analysis Storage',
    ]);
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

  it('sanitizes removable marketing words in otherwise grounded AI descriptions', () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const target = {
      id: 'cap_terraform',
      name: 'ECR Registry',
      kind: 'capability',
      currentDescription: 'ECR Registry maintains ECR repository resources, access policy relationships, and API image registry settings used by cloud infrastructure behavior.',
      relatedDomains: ['cloud-infrastructure', 'resource', 'ecr'],
      relatedEntities: ['AwsEcrRepository'],
    };
    const text = 'ECR Registry maintains ECR repository resources and access policies efficiently for cloud infrastructure behavior.';

    expect(localOrch.validateElementDescription(text, target).reason).toContain('unsupported-marketing-language');
    expect(localOrch.sanitizeElementDescriptionCandidate(text, target)).toBe('ECR Registry maintains ECR repository resources and access policies for cloud infrastructure behavior.');
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
