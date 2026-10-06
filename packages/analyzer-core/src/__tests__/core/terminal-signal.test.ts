import { buildTerminalSignal } from '../../analyzer/core/terminal-signal';
import type { CASEntryPointFlow, SystemCapability } from '../../types/cas.types';

function journey(overrides: Partial<CASEntryPointFlow>): CASEntryPointFlow {
  return {
    id: overrides.id || 'journey_test',
    title: 'Test journey',
    flow_kind: overrides.flow_kind || 'user-facing',
    terminal_entities: overrides.terminal_entities || [],
    steps: overrides.steps || [],
    ...overrides,
  } as CASEntryPointFlow;
}

function capability(name: string, relatedEntities: string[]): SystemCapability {
  return {
    name,
    related_entities: relatedEntities,
  } as unknown as SystemCapability;
}

describe('buildTerminalSignal', () => {
  test('write terminals outrank read terminals regardless of frequency', () => {
    const entryPointFlows = [
      journey({ id: 'j1', terminal_entities: [{ name: 'Invoice', access: 'created', terminal_kind: 'entity' }] }),
      journey({ id: 'j2', terminal_entities: [{ name: 'User', access: 'read', terminal_kind: 'entity' }] }),
      journey({ id: 'j3', terminal_entities: [{ name: 'User', access: 'read', terminal_kind: 'entity' }] }),
    ];
    const signal = buildTerminalSignal({ entryPointFlows, systemCapabilities: [] });
    expect(signal.ranked_entities[0].name).toBe('Invoice');
    expect(signal.ranked_entities[0].write_entry_point_flows).toBe(1);
    expect(signal.ranked_entities[1].name).toBe('User');
  });

  test('user-facing entryPointFlows weigh more than system entryPointFlows', () => {
    const entryPointFlows = [
      journey({ id: 'j1', flow_kind: 'system', terminal_entities: [{ name: 'AuditLog', access: 'created', terminal_kind: 'entity' }] }),
      journey({ id: 'j2', flow_kind: 'user-facing', terminal_entities: [{ name: 'Order', access: 'created', terminal_kind: 'entity' }] }),
    ];
    const signal = buildTerminalSignal({ entryPointFlows, systemCapabilities: [] });
    expect(signal.ranked_entities[0].name).toBe('Order');
    expect(signal.ranked_entities[0].user_facing_entry_point_flows).toBe(1);
  });

  test('node-kind terminals are demoted against entity-kind terminals', () => {
    const entryPointFlows = [
      journey({ id: 'j1', terminal_entities: [{ name: 'formatHelper', access: 'created', terminal_kind: 'node' }] }),
      journey({ id: 'j2', terminal_entities: [{ name: 'Shipment', access: 'created', terminal_kind: 'entity' }] }),
    ];
    const signal = buildTerminalSignal({ entryPointFlows, systemCapabilities: [] });
    expect(signal.ranked_entities[0].name).toBe('Shipment');
  });

  test('capabilities rank by overlap with ranked terminal entities only', () => {
    const entryPointFlows = [
      journey({ id: 'j1', terminal_entities: [{ name: 'Vehicle', access: 'updated', terminal_kind: 'entity' }] }),
      journey({ id: 'j2', terminal_entities: [{ name: 'Vehicle', access: 'created', terminal_kind: 'entity' }] }),
      journey({ id: 'j3', terminal_entities: [{ name: 'Trip', access: 'created', terminal_kind: 'entity' }] }),
    ];
    const capabilities = [
      capability('Vehicle Management', ['Vehicle', 'Trip']),
      capability('Session Handling', ['Session']),
    ];
    const signal = buildTerminalSignal({ entryPointFlows, systemCapabilities: capabilities });
    expect(signal.ranked_capabilities.map(c => c.name)).toEqual(['Vehicle Management']);
    expect(signal.ranked_capabilities[0].matched_terminal_entities).toEqual(expect.arrayContaining(['Vehicle', 'Trip']));
  });

  test('domain seed text repeats top terminals by rank so frequency scorers see hierarchy', () => {
    const entryPointFlows = [
      journey({ id: 'j1', terminal_entities: [{ name: 'WorkOrder', access: 'created', terminal_kind: 'entity' }] }),
      journey({ id: 'j2', terminal_entities: [{ name: 'WorkOrder', access: 'updated', terminal_kind: 'entity' }] }),
      journey({ id: 'j3', terminal_entities: [{ name: 'Customer', access: 'read', terminal_kind: 'entity' }] }),
    ];
    const signal = buildTerminalSignal({ entryPointFlows, systemCapabilities: [] });
    const workOrderCount = (signal.domain_seed_text.match(/work order/g) || []).length;
    const customerCount = (signal.domain_seed_text.match(/customer/g) || []).length;
    expect(workOrderCount).toBeGreaterThan(customerCount);
  });

  test('empty entryPointFlows produce an empty signal, never a throw', () => {
    const signal = buildTerminalSignal({ entryPointFlows: [], systemCapabilities: [capability('X', ['Y'])] });
    expect(signal.ranked_entities).toEqual([]);
    expect(signal.ranked_capabilities).toEqual([]);
    expect(signal.domain_seed_text).toBe('');
  });

  test('keeps lowercase product nouns while filtering lowercase utility words', () => {
    const entryPointFlows = [
      journey({ id: 'j1', terminal_entities: [{ name: 'portfolio', access: 'updated', terminal_kind: 'entity' }] }),
      journey({ id: 'j2', terminal_entities: [{ name: 'find', access: 'read', terminal_kind: 'node' }] }),
      journey({ id: 'j3', terminal_entities: [{ name: 'invoice', access: 'created', terminal_kind: 'entity' }] }),
    ];
    const signal = buildTerminalSignal({ entryPointFlows, systemCapabilities: [] });
    expect(signal.ranked_entities.map(entity => entity.name)).toEqual(expect.arrayContaining(['portfolio', 'invoice']));
    expect(signal.ranked_entities.map(entity => entity.name)).not.toContain('find');
  });

  test('near-terminal stages score with decay: analysis service two above terminal still ranks high', () => {
    // Soon-shaped case: PortfolioAnalysis sits above the terminal
    // insight/trade entities but defines the domain.
    const entryPointFlows = [
      journey({
        id: 'j1',
        terminal_entities: [
          { name: 'ActionableInsight', access: 'created', terminal_kind: 'entity' },
          { name: 'TradeExecution', access: 'created', terminal_kind: 'entity' },
        ],
        steps: [
          { node_id: 'n1', name: 'PortfolioController', layer: 'entry', depth: 0 },
          { node_id: 'n2', name: 'PortfolioAnalysisService', layer: 'business', depth: 1 },
          { node_id: 'n3', name: 'InsightGenerator', layer: 'business', depth: 2 },
          { node_id: 'n4', name: 'TradeRepository', layer: 'data', depth: 3 },
        ],
      }),
    ];
    const signal = buildTerminalSignal({ entryPointFlows, systemCapabilities: [] });
    const stageNames = signal.ranked_stages.map(stage => stage.name);
    expect(stageNames).toContain('PortfolioAnalysisService');
    expect(stageNames).not.toContain('PortfolioController');
    const analysis = signal.ranked_stages.find(stage => stage.name === 'PortfolioAnalysisService')!;
    const repo = signal.ranked_stages.find(stage => stage.name === 'TradeRepository')!;
    expect(repo.score).toBeGreaterThan(analysis.score);
    expect(analysis.score).toBeGreaterThan(0);
    expect(signal.domain_seed_text).toContain('portfolio analysis');
  });

  test('entry/infrastructure steps never enter the stage ranking', () => {
    const entryPointFlows = [
      journey({
        id: 'j1',
        terminal_entities: [{ name: 'Report', access: 'created', terminal_kind: 'entity' }],
        steps: [
          { node_id: 'n1', name: 'AuthMiddleware', layer: 'infrastructure', depth: 0 },
          { node_id: 'n2', name: 'ReportService', layer: 'business', depth: 1 },
        ],
      }),
    ];
    const signal = buildTerminalSignal({ entryPointFlows, systemCapabilities: [] });
    expect(signal.ranked_stages.map(stage => stage.name)).toEqual(['ReportService']);
  });

  test('hash/id-shaped terminal entity names are rejected as candidates, never ranked', () => {
    const entryPointFlows = [
      journey({ id: 'j1', terminal_entities: [{ name: 'a3f9c2b1d8e04f77', access: 'created', terminal_kind: 'entity' }] }),
      journey({ id: 'j2', terminal_entities: [{ name: '9f8e7d6c-5b4a-4321-8765-1234567890ab', access: 'created', terminal_kind: 'entity' }] }),
      journey({ id: 'j3', terminal_entities: [{ name: '8f3k29xz1q', access: 'created', terminal_kind: 'entity' }] }),
      journey({ id: 'j4', terminal_entities: [{ name: 'Invoice', access: 'created', terminal_kind: 'entity' }] }),
    ];
    const signal = buildTerminalSignal({ entryPointFlows, systemCapabilities: [] });
    expect(signal.ranked_entities.map(entity => entity.name)).toEqual(['Invoice']);
    expect(signal.domain_seed_text).not.toMatch(/a3f9c2b1d8e04f77|9f8e7d6c|8f3k29xz1q/);
  });

  test('hash/id-shaped stage names are rejected as candidates', () => {
    const entryPointFlows = [
      journey({
        id: 'j1',
        terminal_entities: [{ name: 'Report', access: 'created', terminal_kind: 'entity' }],
        steps: [
          { node_id: 'n1', name: 'a3f9c2b1d8e04f77', layer: 'business', depth: 0 },
          { node_id: 'n2', name: 'ReportService', layer: 'business', depth: 1 },
        ],
      }),
    ];
    const signal = buildTerminalSignal({ entryPointFlows, systemCapabilities: [] });
    expect(signal.ranked_stages.map(stage => stage.name)).toEqual(['ReportService']);
  });

  test('deterministic ordering: ties break lexicographically', () => {
    const entryPointFlows = [
      journey({ id: 'j1', terminal_entities: [{ name: 'Beta', access: 'created', terminal_kind: 'entity' }] }),
      journey({ id: 'j2', terminal_entities: [{ name: 'Alpha', access: 'created', terminal_kind: 'entity' }] }),
    ];
    const a = buildTerminalSignal({ entryPointFlows, systemCapabilities: [] });
    const b = buildTerminalSignal({ entryPointFlows: [...entryPointFlows].reverse(), systemCapabilities: [] });
    expect(a.ranked_entities.map(e => e.name)).toEqual(['Alpha', 'Beta']);
    expect(b.ranked_entities.map(e => e.name)).toEqual(a.ranked_entities.map(e => e.name));
  });
});

// Domain authority: AI labels are gated by terminal outputs and anchoring.
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';

describe('evaluateAIDomainCandidate (domain authority)', () => {
  function orchestratorWithTerminal(entities: string[], stages: string[] = []) {
    const orch = new AnalyzerOrchestrator() as any;
    orch.activeTerminalSignal = {
      ranked_entities: entities.map(name => ({ name, score: 5, entry_point_flow_count: 2, write_entry_point_flows: 2, read_entry_point_flows: 0, user_facing_entry_point_flows: 1 })),
      ranked_stages: stages.map(name => ({ name, score: 2, entry_point_flow_count: 1, min_distance_from_terminal: 1 })),
      ranked_capabilities: [],
      domain_seed_text: entities.join(' ').toLowerCase(),
    };
    return orch;
  }
  const purpose = (domain: string, anchored: boolean, description: string) => ({
    primary_domain: domain,
    domain_anchored: anchored,
    inferred_description: description,
    core_concepts: [],
  });

  test('plumbing label rejected when terminals are product entities', () => {
    const orch = orchestratorWithTerminal(['Protocol', 'CarePlan']);
    const verdict = orch.evaluateAIDomainCandidate(
      'user-identity-management',
      purpose('clinical-testing', true, 'manages user identity, accounts, protocols and care plans for clinics')
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe('generic-plumbing-label');
  });

  test('plumbing label allowed when terminals ARE the plumbing (identity service)', () => {
    const orch = orchestratorWithTerminal(['User', 'IdentityClaim']);
    const verdict = orch.evaluateAIDomainCandidate(
      'user-identity-management',
      purpose('access', false, 'registers users and issues identity claims')
    );
    expect(verdict.accepted).toBe(true);
  });

  test('sideways label rejected against anchored domain; narrowing accepted as ai-refined', () => {
    const orch = orchestratorWithTerminal(['Vrs', 'ProductSerial']);
    const sideways = orch.evaluateAIDomainCandidate(
      'order-billing-management',
      purpose('product-verification', true, 'verifies product serial numbers, orders and billing references against manufacturer records')
    );
    expect(sideways.accepted).toBe(false);
    const narrowing = orch.evaluateAIDomainCandidate(
      'product-serial-verification',
      purpose('product-verification', true, 'verifies product serial numbers against manufacturer records')
    );
    expect(narrowing.accepted).toBe(true);
    expect(narrowing.refined).toBe(true);
  });

  test('label disconnected from terminal vocabulary rejected even unanchored', () => {
    const orch = orchestratorWithTerminal(['Portfolio', 'TradeExecution'], ['PortfolioAnalysisService']);
    const verdict = orch.evaluateAIDomainCandidate(
      'commerce-operations-portal',
      purpose('infer', false, 'manages portfolio analysis, commerce operations, portal screens, checkout and trades')
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe('not-anchored-in-terminal-outputs');
  });

  test('explicit product documentation can outweigh misleading terminal vocabulary', () => {
    const orch = orchestratorWithTerminal(['CacheRecord'], ['RefreshWorker']);
    const verdict = orch.evaluateAIDomainCandidate(
      'source-analysis',
      purpose('', false, ''),
      [],
      {
        concepts: [], evidence: [],
        productDocTitle: 'Source Analysis Platform',
        productDocSummary: 'Analyzes source repositories for engineering teams.',
      },
    );
    expect(verdict.accepted).toBe(true);
  });

  test('terminal-anchored specific label accepted when deterministic domain is weak', () => {
    const orch = orchestratorWithTerminal(['Portfolio', 'ActionableInsight'], ['PortfolioAnalysisService']);
    const verdict = orch.evaluateAIDomainCandidate(
      'portfolio-analysis-automation',
      purpose('infer', false, 'performs portfolio analysis to produce actionable insights and automation')
    );
    expect(verdict.accepted).toBe(true);
  });

  test('buildEnhancedSystemPurpose does not seed a deterministic comprehension domain or description (AI-only)', () => {
    const orch = new AnalyzerOrchestrator() as any;
    // Bound POSITIONALLY to buildEnhancedSystemPurpose's 15 parameters, one per
    // line with the parameter it fills. This call had silently drifted: it passed
    // 16 arguments against an older ordering, so `domainExtractor` received `[]`
    // and the whole test died on `domainExtractor.getCoreConcepts is not a
    // function` — it asserted nothing for as long as it was red. Keep the labels;
    // they are what makes the next signature change visible instead of silent.
    const purpose = orch.buildEnhancedSystemPurpose(
      /* basePurpose        */ { primary_type: 'application', confidence: 0.7, evidence: [] },
      /* domainConcepts     */ [{ id: 'concept_portfolio', name: 'Portfolio', type: 'entity', confidence: 0.9 }],
      /* domainExtractor    */ {
        getCoreConcepts: () => [{ name: 'Portfolio' }],
        inferPrimaryDomain: () => 'portfolio-management',
      },
        [],
        [],
        [],
        [],
        [],
        [],
        'portfolio-app',
        { concepts: ['Portfolio'], evidence: [], primaryDomain: 'portfolio-management' },
        [],
        '',
        {
        ranked_entities: [{ name: 'Message', score: 5, entry_point_flow_count: 2, write_entry_point_flows: 2, read_entry_point_flows: 0, user_facing_entry_point_flows: 1 }],
        ranked_stages: [],
        ranked_capabilities: [],
        domain_seed_text: 'message message message message message',
      },
      /* exitPoints         */ []
    );

    // Comprehension is AI-only: the builder must NOT keyword-classify a domain
    // or write a description. Those are produced solely by applyAIInterpretation.
    expect(purpose.primary_domain).toBe('');
    expect(purpose.inferred_description).toBe('');
    expect(purpose.domain_source).toBeUndefined();
    expect(purpose.description_source).toBeUndefined();
    // Structure (Camp B) is still produced.
    expect(purpose.core_concepts).toContain('Portfolio');
  });

  test('buildEnhancedSystemPurpose publishes bounded first-party product evidence with provenance', () => {
    const orch = new AnalyzerOrchestrator() as any;
    const result = orch.buildEnhancedSystemPurpose(
      { primary_type: 'application', confidence: 0.7, evidence: [] },
      [],
      { getCoreConcepts: () => [] },
      [],
      [],
      [],
      [],
      [],
      [],
      'storefront-theme',
      {
        concepts: ['product', 'cart'],
        evidence: ['README.md', 'package.json description'],
        productDocTitle: 'Dawn',
        productDocSummary: 'A storefront theme for browsing products and managing carts.',
        productDocSource: 'README.md',
        manifestDescription: 'A fast commerce storefront theme.',
      },
      [],
      '',
      null,
      [],
    );

    expect(result.first_party_product_evidence).toEqual({
      title: { value: 'Dawn', source: 'README.md' },
      overview: {
        value: 'A storefront theme for browsing products and managing carts.',
        source: 'README.md',
      },
      manifest_description: {
        value: 'A fast commerce storefront theme.',
        source: 'package.json',
      },
    });
  });
});
