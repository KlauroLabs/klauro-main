import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { aiService } from '../../ai/ai-service';
import { validateElementDescription } from '../../ai/element-description-validator';
import { filterPlausibleExternalServices, isPlausibleExternalServiceName, isHostnameLikeServiceName } from '../../ai/external-service-plausibility';

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
      'Agent Context manages the creation and coordination of files related to agent adoption and measurement.',
      { name: 'Agent Context', relatedDomains: ['agent'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('generic-structural-phrase');
  });

  it('rejects descriptions that name implementation source files', () => {
    const result = validateElementDescription(
      'Agent Context prepares coding briefs for agents by coordinating agent-adoption.ts and agent-adoption-measurement.ts.',
      { name: 'Agent Context', relatedDomains: ['agent'] },
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
      'Agent Context coordinates and generates functions to process and format data for structured output.',
      { name: 'Agent Context', kind: 'capability', relatedDomains: ['agent'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('implementation-function-restatement');
  });

  it('rejects capability descriptions that list helper function examples', () => {
    const result = validateElementDescription(
      'Agent Context organizes and executes specific functions like parseArgs, formatTable, and renderRow to process and structure data.',
      { name: 'Agent Context', kind: 'capability', relatedDomains: ['agent'] },
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
      expect(['generic-structural-phrase', 'implementation-surface-restatement', 'too-short', 'lets-users-scaffold-ungrounded', 'lets-users-scaffold-restatement']).toContain(result.reason);
    }
  });

  it('rejects the no-information "Lets users <verb> <noun>" scaffold (live truckspy: 12/12 domain capabilities)', () => {
    const result = validateElementDescription(
      'Vehicle Management lets users manage vehicles and their related information.',
      { name: 'Vehicle Management', kind: 'capability', relatedDomains: ['vehicle'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('lets-users-scaffold-restatement');
  });

  it('keeps a "lets users" sentence whose concrete content is grounded in the capability entities', () => {
    const result = validateElementDescription(
      'Portfolio Management lets users track their crypto holdings — balances, allocation, and performance across connected wallets.',
      { name: 'Portfolio Management', kind: 'capability', relatedDomains: ['portfolio'], relatedEntities: ['PortfolioHolding', 'Wallet'] },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a "lets users" sentence whose content grounds in NO capability evidence (free-floating template filler)', () => {
    const result = validateElementDescription(
      'Memory Management lets users store, retrieve, and organize their knowledge and skills.',
      { name: 'Memory Management', kind: 'capability', relatedDomains: ['memory'], relatedEntities: ['MemoryEntry', 'AgentSession'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('lets-users-scaffold-ungrounded');
  });

  it('rejects the "capability owns the ... lifecycle" surface template (live truckspy surface capabilities)', () => {
    const result = validateElementDescription(
      'The Dispatch Surface capability owns the trip assignment lifecycle from creation to completion.',
      { name: 'Dispatch Surface', kind: 'capability', relatedDomains: ['dispatch'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('owns-lifecycle-template');
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

describe('entity-kind filler recalibration (state/record vocabulary is not filler for entities)', () => {
  // The FILLER_PHRASE_PATTERN was authored from CAPABILITY-description failures.
  // A few of its phrases ("state mutations", "current product context", "screen
  // state", "workflow state") describe exactly what a state/record ENTITY IS. For
  // kind:'entity' those are accurate record semantics, not filler; for
  // capabilities they remain plumbing and stay rejected.

  it('accepts an audit-log entity that records "state mutations"', () => {
    const result = validateElementDescription(
      'AuditLog records who changed what and when across the platform, preserving an immutable history of state mutations for compliance.',
      { name: 'AuditLog', kind: 'entity', relatedEntities: ['User'], domainVocabulary: ['compliance', 'fleet'] },
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a session entity that holds the "current product context"', () => {
    const result = validateElementDescription(
      'Session represents an authenticated user session, tracking the active connection, expiry, and current product context for the signed-in user.',
      { name: 'Session', kind: 'entity', relatedEntities: ['User'] },
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a view-model entity describing "screen state" and "workflow state"', () => {
    const result = validateElementDescription(
      'ViewState holds the current screen state and workflow state the operator sees while dispatching a load.',
      { name: 'ViewState', kind: 'entity', relatedEntities: ['Load'] },
    );
    expect(result.ok).toBe(true);
  });

  it('STILL rejects genuine capability-plumbing filler for entities', () => {
    const result = validateElementDescription(
      'Thing manages the creation and management of internal files and supports tasks across different system components.',
      { name: 'Thing', kind: 'entity', relatedEntities: ['Widget'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('generic-structural-phrase');
  });

  it('STILL rejects state-language plumbing for capabilities (unchanged)', () => {
    const result = validateElementDescription(
      'State Management tracks state mutations and current product context across the app.',
      { name: 'State Management', kind: 'capability', relatedDomains: ['state'] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('generic-structural-phrase');
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

  it('rejects CI shell-command fragments so they never become service labels', () => {
    // The exact class that leaked into testing-utilities-net's description:
    // a raw `dotnet pack` line from .gitlab-ci.yml surfaced as a "service".
    const leaked = [
      'dotnet pack "Soon.TestingUtilities/Soon.TestingUtilities.csproj" -p:Version=$VER',
      '.NET pack "Soon.TestingUtilities/Soon.TestingUtilities.csproj" -p:Version=$VER deploys to nuget',
      'npm publish --access public',
      'docker build -t app:${CI_COMMIT_SHA} .',
      'cargo publish --token $CARGO_TOKEN',
      'helm upgrade --install my-release charts/app',
      'bash scripts/deploy.sh production',
      'echo $DEPLOY_URL > target/url.txt',
      'a very long multi word fragment that reads like prose not a service name',
    ];
    for (const name of leaked) {
      expect(isPlausibleExternalServiceName(name, ['testing-utilities-net'])).toBe(false);
    }
    expect(filterPlausibleExternalServices(leaked, ['testing-utilities-net'])).toEqual([]);
    // Orchestrator-side gate (buildExternalServices) rejects the same class.
    for (const name of leaked) {
      expect(orch.isMeaningfulExternalServiceName(name)).toBe(false);
    }
    // Real service names still pass both gates.
    for (const name of ['Stripe', 'S3', 'auth0.com']) {
      expect(isPlausibleExternalServiceName(name, ['testing-utilities-net'])).toBe(true);
    }
    // Real domain-name services now pass the orchestrator gate too (bare domains
    // are meaningful; the dotted-identifier rule no longer over-rejects them).
    for (const name of ['Stripe', 'S3', 'auth0.com', 'api.stripe.com', 'sentry.io']) {
      expect(orch.isMeaningfulExternalServiceName(name)).toBe(true);
    }
    // …while command-shaped / path / variable junk stays rejected by the gate.
    for (const name of ['dotnet-pack', 'Soon.TestingUtilities/Soon.TestingUtilities.csproj', '$VER']) {
      expect(orch.isMeaningfulExternalServiceName(name)).toBe(false);
    }
  });

  it('accepts real hostnames but rejects command/path/hash junk (isHostnameLikeServiceName)', () => {
    for (const host of ['auth0.com', 'api.stripe.com', 'sentry.io', 'https://sentry.io', 'my-service.dev', 'foo.bar.co.io']) {
      expect(isHostnameLikeServiceName(host)).toBe(true);
    }
    for (const notHost of [
      'Soon.TestingUtilities/Soon.TestingUtilities.csproj',
      'dotnet pack "Foo.csproj" -p:Version=$VER',
      'dotnet-pack',
      '$VER',
      'System.Text',
      'this.repo.save',
      'Repo.Save',
      'sentry.io/path',
      'sentry.io:443',
      'ftp://sentry.io',
      'foo.internalzzz',
      'plainword',
    ]) {
      expect(isHostnameLikeServiceName(notHost)).toBe(false);
    }
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

describe('AI interpretation budgets for hosted providers', () => {
  const localEnvKeys = ['KLAURO_OLLAMA_AUTO', 'OLLAMA_BASE_URL', 'LOCAL_OPENAI_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'AI_TIMEOUT'];
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

  it('ignores local model toggles and defaults the per-request timeout to 90s for hosted AI', () => {
    const { getAIConfig } = require('../../config/ai.config');
    // Hosted default is 90s: a hosted-70B catalog/narrative call sends a large
    // fact bundle and returns structured JSON on highly variable shared inference;
    // a short timeout cut it off, burning the retry budget before any result.
    expect(getAIConfig().openai.timeout).toBe(90000);
    process.env.KLAURO_OLLAMA_AUTO = 'true';
    expect(getAIConfig().openai.timeout).toBe(90000);
    process.env.AI_TIMEOUT = '45000';
    expect(getAIConfig().openai.timeout).toBe(45000);
  });

  it('uses the hosted interpretation wall budget unless explicitly overridden', async () => {
    const previousOpenAI = process.env.OPENAI_API_KEY;
    const previousForce = process.env.KLAURO_AI_INTERPRETATION_FORCE;
    const previousBudget = process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS;
    const previousInterpretation = process.env.KLAURO_AI_INTERPRETATION;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    // Comprehension is AI-only and default-OFF in tests (setup.ts); opt into it.
    process.env.KLAURO_AI_INTERPRETATION = 'true';
    process.env.KLAURO_AI_INTERPRETATION_FORCE = '1';
    delete process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS;

    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(JSON.stringify({
      system_description: 'Klauro builds CAS relationship graphs from source repositories so coding agents can reason about a codebase before touching it. It parses code into structural facts — call graphs, routes, entities, and tests — and layers comprehension over them. The pipeline resolves references, derives capabilities, and grounds every description in the evidence bundle it gathered. It is built in TypeScript and hands this analysis context to agents over MCP, keeping facts deterministic and meaning model-authored.',
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
      if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAI;
      if (previousForce === undefined) delete process.env.KLAURO_AI_INTERPRETATION_FORCE;
      else process.env.KLAURO_AI_INTERPRETATION_FORCE = previousForce;
      if (previousBudget === undefined) delete process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS;
      else process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS = previousBudget;
      if (previousInterpretation === undefined) delete process.env.KLAURO_AI_INTERPRETATION;
      else process.env.KLAURO_AI_INTERPRETATION = previousInterpretation;
    }

    expect(purpose.description_generation.budget_ms).toBe(20000);
    expect(purpose.description_generation.status).toBe('ai_applied');
  });
});

describe('AI repair re-prompt budget (2 attempts) and terminal throw', () => {
  const envKeys = ['OPENAI_API_KEY', 'KLAURO_AI_INTERPRETATION', 'KLAURO_AI_INTERPRETATION_FORCE', 'KLAURO_AI_INTERPRETATION_BUDGET_MS'];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    process.env.OPENAI_API_KEY = 'test-openai-key';
    // Comprehension is AI-only and default-OFF in tests (setup.ts); opt into it.
    process.env.KLAURO_AI_INTERPRETATION = 'true';
    process.env.KLAURO_AI_INTERPRETATION_FORCE = '1';
    delete process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS;
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    jest.restoreAllMocks();
  });

  const freshPurpose = (): any => ({
    primary_type: 'developer-tool',
    confidence: 0.9,
    evidence: [],
    primary_domain: 'code-analysis',
    core_concepts: ['code', 'analysis'],
    inferred_description: 'A code analysis service.',
    supporting_workflow_ids: [],
  });

  // Semantically unfixable: "interaction surfaces" is a source-bucket
  // restatement that neither the sanitizer nor the mechanical repair path
  // edits away — only a fresh AI re-prompt could fix it.
  const badAnswer = JSON.stringify({
    system_description: 'Klauro analyzes code repositories and builds analysis graphs for coding agents to consume before they edit. It exposes interaction surfaces for operators to trigger analysis runs and inspect code analysis results across repositories and workspaces before agents act on them.',
    domain: '',
    descriptions: [],
  });
  const goodAnswer = JSON.stringify({
    system_description: 'Klauro builds CAS relationship graphs from source repositories so coding agents can reason about a codebase before touching it. It parses code into structural facts — call graphs, routes, entities, and tests — and layers comprehension over them. The pipeline resolves references, derives capabilities, and grounds every description in the evidence bundle it gathered. It is built in TypeScript and hands this analysis context to agents over MCP, keeping facts deterministic and meaning model-authored.',
    domain: '',
    descriptions: [],
  });

  it('accepts a description produced on the SECOND repair re-prompt (previously only one repair pass existed)', async () => {
    const spy = jest.spyOn(aiService, 'generateComponentDescription')
      .mockResolvedValueOnce(badAnswer)
      .mockResolvedValueOnce(badAnswer)
      .mockResolvedValueOnce(goodAnswer);
    const purpose = freshPurpose();

    await orch.applyAIInterpretation(purpose, 'analysis-api', [], [], [], [], orch.emptyFlowGraph(), []);

    // 1 initial + 2 repair re-prompts.
    expect(spy).toHaveBeenCalledTimes(3);
    expect(purpose.description_generation.status).toBe('ai_applied');
    expect(purpose.inferred_description).toMatch(/CAS relationship graphs/);
  });

  it('throws AFTER exhausting both repair re-prompts (AI-only-or-throw stands, no deterministic fallback)', async () => {
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockResolvedValue(badAnswer);
    const purpose = freshPurpose();

    await expect(
      orch.applyAIInterpretation(purpose, 'analysis-api', [], [], [], [], orch.emptyFlowGraph(), [])
    ).rejects.toThrow(/failed the grounding gate \(source-bucket-restatement\)/);

    expect(spy).toHaveBeenCalledTimes(3);
    expect(purpose.description_generation.status).toBe('ai_rejected');
    expect(purpose.inferred_description).toBe('A code analysis service.');
  });
});

describe('self-analysis AI description guardrails', () => {
  const purpose: any = {
    primary_type: 'developer-tool',
    confidence: 0.9,
    evidence: [],
    primary_domain: 'codebase-analysis',
    core_concepts: ['CAS', 'MCP', 'codebase analysis', 'agent contexts'],
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
      'Klauro builds CAS relationship graphs from repositories so AI agents can understand codebase structure before editing. It exposes MCP agent contexts, idiom guidance, proposal previews, incremental analysis, telemetry correlation, and analysis storage for development workflows.',
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
      { name: 'Agent Context', related_domains: ['agent'] },
      { name: 'Proposal Preview', related_domains: ['proposal'] },
      { name: 'Codebase Idiom Guidance', related_domains: ['idiom'] },
      { name: 'Analysis Storage', related_domains: ['storage'] },
    ];

    const prioritized = localOrch.prioritizeKlauroSelfCapabilities(capabilities, '/tmp/klauro');

    expect(prioritized.map((capability: any) => capability.name)).toEqual([
      'Codebase Analysis',
      'Agent Context',
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

describe('AI-phase OVERALL wall-clock budget (KLAURO_AI_PHASE_BUDGET_MS)', () => {
  // LIVE EVIDENCE (see the "AI-phase OVERALL wall-clock budget" comment near
  // getAiPhaseBudgetMs() in orchestrator.ts): on a 47k-node CAS the AI-phase
  // burned 1-3+ CPU-hours because nothing bounded the SUM of the capability
  // catalog + system description + entity description sub-budgets. These
  // tests exercise the new outer ceiling directly against applyAIInterpretation.
  const envKeys = [
    'OPENAI_API_KEY', 'KLAURO_AI_INTERPRETATION', 'KLAURO_AI_INTERPRETATION_FORCE',
    'KLAURO_AI_PHASE_BUDGET_MS', 'KLAURO_AI_INTERPRETATION_BUDGET_MS',
    'KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS',
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.KLAURO_AI_INTERPRETATION = 'true';
    process.env.KLAURO_AI_INTERPRETATION_FORCE = '1';
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function freshPurpose(): any {
    return {
      primary_type: 'developer-tool',
      confidence: 0.9,
      evidence: [],
      primary_domain: 'code-analysis',
      core_concepts: ['code', 'analysis'],
      inferred_description: 'A code analysis service.',
      supporting_workflow_ids: [],
    };
  }

  it('when the capability-catalog call alone consumes the whole phase budget, applies its result but skips system description and entity descriptions', async () => {
    // The phase clock only starts INSIDE applyAIInterpretation (a fresh call
    // always gets a fresh deadline), so "already exhausted" is exercised the
    // way it happens for real: an earlier stage's OWN in-flight AI call
    // outlasts the phase budget, and the NEXT stage sees the expired deadline.
    // Phase budget (300ms) vs. the mocked catalog call's delay (3000ms) is a
    // 10x margin, deterministic under CI/VM jitter.
    process.env.KLAURO_AI_PHASE_BUDGET_MS = '300';
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 3000));
      // >= any catalogCountMin (capped at 10) so aiExtractCapabilityCatalog's
      // under-count retry never fires a second call — exactly one AI call
      // happens in this test, the capability catalog.
      const capabilities = Array.from({ length: 10 }, (_, i) => ({
        name: `Capability ${i}`,
        description: `Capability ${i} lets operators manage a distinct product area end to end.`,
        category: i === 0 ? 'core' : 'supporting',
        entities: [],
        journeys: [],
      }));
      return JSON.stringify({ capabilities });
    });
    const purpose = freshPurpose();
    const systemCapabilities: any[] = [{
      id: 'cap_x', name: 'Widget Management', operations: [], related_domains: [], related_entities: [], criticality_factors: [],
    }];
    const dataEntities: any[] = [{ id: 'entity_widget', name: 'Widget', fields: [] }];

    let callCount = 0;
    try {
      await orch.applyAIInterpretation(
        purpose, 'analysis-api', [], [], [], [], orch.emptyFlowGraph(), [],
        systemCapabilities, [], [], dataEntities
      );
    } finally {
      // Read the call count BEFORE mockRestore(): mockRestore() does
      // everything mockReset() does (including clearing .mock.calls), so
      // asserting on the spy after restoring would always read 0.
      callCount = spy.mock.calls.length;
      spy.mockRestore();
    }

    // Exactly one AI call happened (the capability catalog); it was allowed
    // to finish (never aborted mid-request) and its result was applied. By
    // the time execution reached the system-description stage, the phase
    // deadline had already passed, so that stage — and the entity-description
    // stage after it — were both skipped, honestly, rather than attempted.
    expect(callCount).toBe(1);
    expect(purpose.ai_phase_status).toBe('partial');
    expect(purpose.ai_phase_stopped_reason).toBe('phase-budget-exhausted');
    expect(purpose.description_generation.status).toBe('ai_skipped');
    expect(purpose.description_generation.reason).toBe('phase-budget-exhausted');
    // The system description was never attempted, so no fabricated text landed.
    expect(purpose.inferred_description).toBe('A code analysis service.');
    expect(dataEntities[0].description_generation.status).toBe('ai_skipped');
    expect(dataEntities[0].description_generation.reason).toBe('phase-budget-exhausted');
    // Nothing already produced was discarded/faked — description_source stays unset.
    expect(dataEntities[0].description_source).toBeUndefined();
  }, 10000);

  it('when the system description call alone outlasts the phase budget, still applies the description but skips entity descriptions honestly', async () => {
    // Phase budget (300ms) is deliberately much shorter than the mocked call's
    // own delay (3000ms) so the deadline is unambiguously passed by the time
    // the entity-description stage is reached — a large (10x) margin keeps
    // this deterministic rather than timing-sensitive under CI/VM jitter.
    process.env.KLAURO_AI_PHASE_BUDGET_MS = '300';
    delete process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS;
    const spy = jest.spyOn(aiService, 'generateComponentDescription').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 3000));
      return JSON.stringify({
        system_description: 'Klauro builds CAS relationship graphs from source repositories so coding agents can reason about a codebase before touching it. It parses code into structural facts — call graphs, routes, entities, and tests — and layers comprehension over them. The pipeline resolves references, derives capabilities, and grounds every description in the evidence bundle it gathered. It is built in TypeScript and hands this analysis context to agents over MCP, keeping facts deterministic and meaning model-authored.',
        domain: '',
        descriptions: [],
      });
    });
    const purpose = freshPurpose();
    const dataEntities: any[] = [{ id: 'entity_widget', name: 'Widget', fields: [] }];

    let callCount = 0;
    try {
      // Empty systemCapabilities/userJourneys: skip the capability-catalog
      // stage so exactly ONE provider call (the system description) happens
      // before the entity-description stage sees the expired deadline.
      await orch.applyAIInterpretation(
        purpose, 'analysis-api', [], [], [], [], orch.emptyFlowGraph(), [],
        [], [], [], dataEntities
      );
    } finally {
      // Read the call count BEFORE mockRestore(): mockRestore() does
      // everything mockReset() does (including clearing .mock.calls), so
      // asserting on the spy after restoring would always read 0.
      callCount = spy.mock.calls.length;
      spy.mockRestore();
    }

    expect(callCount).toBe(1);
    // The system description that was already in flight when the budget
    // expired is kept — never discarded — even though the phase is 'partial'.
    expect(purpose.description_generation.status).toBe('ai_applied');
    expect(purpose.ai_phase_status).toBe('partial');
    expect(purpose.ai_phase_stopped_reason).toBe('phase-budget-exhausted');
    expect(purpose.ai_phase_nodes_at_stop).toBe(0);
    expect(dataEntities[0].description_generation.status).toBe('ai_skipped');
    expect(dataEntities[0].description_generation.reason).toBe('phase-budget-exhausted');
    expect(purpose.entity_description_coverage.stopped_reason).toBe('phase-budget-exhausted');
  }, 10000);
});
