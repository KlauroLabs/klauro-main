import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { evaluateCapabilityCatalogAudience } from '../../analyzer/core/capability-catalog-audience';
import type { SystemCapability } from '../../types/cas.types';

// Private-method tests (same convention as orchestrator-internals.test.ts):
// the guards are internal by design, reached via a typed `any` handle.
const orch = new AnalyzerOrchestrator() as any;

const cap = (over: Partial<SystemCapability> & Record<string, unknown>): SystemCapability => ({
  id: 'c', name: 'Cap', description: 'Grounded prose describing a real ability of the product.',
  name_source: 'ai', description_source: 'ai',
  category: 'supporting', operations: [], related_entities: [], related_domains: [],
  criticality: 'medium', criticality_factors: [],
  ...over,
} as SystemCapability);

describe('structural placeholder description guard', () => {
  it('flags the single-operation grouping template', () => {
    expect(orch.isStructuralPlaceholderCapabilityDescription('Active: query operation via message')).toBe(true);
    expect(orch.isStructuralPlaceholderCapabilityDescription('Cas: command operation via cli')).toBe(true);
  });

  it('flags the multi-operation grouping template', () => {
    expect(orch.isStructuralPlaceholderCapabilityDescription('Hot: 4 operations (crud, query)')).toBe(true);
    expect(orch.isStructuralPlaceholderCapabilityDescription('Adrs: 12 operations (general)')).toBe(true);
  });

  it('never flags authored prose, even prose mentioning operations', () => {
    expect(orch.isStructuralPlaceholderCapabilityDescription('Surfaces hot spots so agents can prioritize risky operations during review.')).toBe(false);
    expect(orch.isStructuralPlaceholderCapabilityDescription('Tracks each analysis operation via the fabric so peers stay aware.')).toBe(false);
    expect(orch.isStructuralPlaceholderCapabilityDescription('')).toBe(false);
  });

  it('rebuilds a placeholder from the real operations, naming entry kinds and operation labels', () => {
    const rebuilt = orch.rebuildCapabilityDescriptionFromOperations([
      { name: 'get_hot_spots', trigger: { type: 'message' } },
      { name: 'get_hot_spots_summary', trigger: { type: 'message' } },
    ]);
    expect(rebuilt).toContain('Get Hot Spots');
    expect(rebuilt).toContain('message');
    expect(orch.rebuildCapabilityDescriptionFromOperations([])).toBeUndefined();
  });
});

describe('finalizeSystemCapabilityNames canonical publication gate', () => {
  it('excludes a deterministic placeholder instead of promoting it into comprehension', () => {
    const caps = [cap({
      name: 'Manage Analyses',
      description: 'Analyses: query operation via message',
      description_source: undefined,
      operations: [{ entry_point_id: 'ep1', entry_point_type: 'message', action: 'list_analyses' }] as any,
    })];
    orch.finalizeSystemCapabilityNames(caps);
    expect(caps).toEqual([]);
  });

  it('excludes an authored description that still contains a structural template', () => {
    const caps = [cap({
      name: 'Manage Analyses',
      description: 'Analyses: query operation via message',
      description_source: 'ai',
      operations: [{ entry_point_id: 'ep1', entry_point_type: 'message', action: 'list_analyses' }] as any,
    })];
    orch.finalizeSystemCapabilityNames(caps);
    expect(caps).toEqual([]);
  });

  it('keeps an evidence-anchored PM-quality authored capability', () => {
    const caps = [cap({
      name: 'Review codebase change risk',
      description: 'Explains affected behaviors and tests before engineers modify connected code.',
      operations: [{ entry_point_id: 'ep1', entry_point_type: 'message', action: 'assess_change_risk' }] as any,
    })];
    orch.finalizeSystemCapabilityNames(caps);
    expect(caps).toHaveLength(1);
  });
});

describe('finalizeFlowGraphCapabilities (flow_graph bare-noun/placeholder sweep)', () => {
  it('repairs a bare-noun name from its verb-headed operation label and rebuilds the template description', () => {
    const flowGraph: any = {
      capability_candidates: [{
        id: 'capability_hot', name: 'Hot',
        description: 'Hot: query operation via message',
        entry_points: ['ep1'],
        operations: [{ id: 'op_1', name: 'get_hot_spots', pattern: 'query', trigger: { type: 'message' } }],
      }],
    };
    orch.finalizeFlowGraphCapabilities(flowGraph);
    expect(flowGraph.capability_candidates[0].name).toBe('Get Hot Spots');
    expect(flowGraph.capability_candidates[0].description).not.toContain('operation via');
    expect(flowGraph.capability_candidates[0].description).toContain('Get Hot Spots');
  });

  it('falls back to Manage <subject> when no operation label is verb-headed but evidence anchors the group', () => {
    const flowGraph: any = {
      capability_candidates: [{
        id: 'capability_adrs', name: 'Adrs',
        description: 'Adrs: query operation via message',
        entry_points: ['ep1'],
        operations: [{ id: 'op_1', name: 'adrs', pattern: 'query', trigger: { type: 'message' } }],
      }],
    };
    orch.finalizeFlowGraphCapabilities(flowGraph);
    expect(flowGraph.capability_candidates[0].name).toBe('Manage Adrs');
  });

  it('leaves purposeful names and authored descriptions alone, and never drops entries', () => {
    const flowGraph: any = {
      capability_candidates: [{
        id: 'capability_x', name: 'Analyze Codebases',
        description: 'Runs the full analysis pipeline over any repository.',
        entry_points: [], operations: [],
      }],
    };
    orch.finalizeFlowGraphCapabilities(flowGraph);
    expect(flowGraph.capability_candidates).toHaveLength(1);
    expect(flowGraph.capability_candidates[0].name).toBe('Analyze Codebases');
    expect(flowGraph.capability_candidates[0].description).toBe('Runs the full analysis pipeline over any repository.');
  });

  it('tolerates an absent flow graph', () => {
    expect(() => orch.finalizeFlowGraphCapabilities(undefined)).not.toThrow();
  });
});

describe('catalogQualityFailure (post-reconcile gate, defect #33)', () => {
  // Anchored by default (one resolvable operation) — a purposeful, grounded
  // capability always carries SOME structural evidence; tests that need to
  // exercise the unanchored path build their own zero-operation/zero-entity
  // fixture explicitly (see the "unanchored capabilities" describe block).
  const anchorOp = (name: string) => ([{ entry_point_id: `ep_${name.replace(/\W+/g, '_')}`, entry_point_type: 'http', action: 'Handle' }] as any);
  const purposeful = (name: string) => cap({
    id: name, name, description: `Grounded prose about ${name} and why the ability exists in the product.`,
    operations: anchorOp(name),
  });

  it('fails an empty catalog', () => {
    expect(orch.catalogQualityFailure([], 20)).toContain('empty');
  });

  it('fails a <=3 catalog when the deterministic families outnumber it 2x+', () => {
    const three = [purposeful('View entry points'), purposeful('View functions'), purposeful('View dashboard')];
    expect(orch.catalogQualityFailure(three, 20)).toContain('collapse');
  });

  it('accepts a small catalog on a genuinely small repo', () => {
    const three = [purposeful('Manage cryptocurrency trades'), purposeful('Track portfolios'), purposeful('Report order settlement')];
    expect(orch.catalogQualityFailure(three, 4)).toBeUndefined();
  });

  it('fails on surviving bare-noun names and placeholder descriptions', () => {
    const bare = [purposeful('Analyze codebases'), purposeful('Serve agent context'), purposeful('Coordinate fleets'), cap({ id: 'g', name: 'Gateway', operations: anchorOp('Gateway') })];
    expect(orch.catalogQualityFailure(bare, 8)).toContain('bare-noun');
    const placeholder = [purposeful('Analyze codebases'), purposeful('Serve agent context'), purposeful('Coordinate fleets'), cap({ id: 'p', name: 'Manage Hot Spots', description: 'Hot: query operation via message', operations: anchorOp('Manage Hot Spots') })];
    expect(orch.catalogQualityFailure(placeholder, 8)).toContain('template');
  });

  it('rejects unauthored names and descriptions that cannot explain product value', () => {
    const unauthored = purposeful('Analyze codebases');
    unauthored.name_source = undefined;
    expect(orch.catalogQualityFailure([unauthored], 1)).toContain('unauthored');
    const unexplained = purposeful('Analyze codebases');
    unexplained.description = 'Analyzes codebases.';
    expect(orch.catalogQualityFailure([unexplained], 1)).toContain('product-language');
  });

  it('accepts a rich purposeful catalog', () => {
    const six = ['Analyze codebases', 'Serve agent context over MCP', 'Coordinate agent fleets', 'Detect deployables', 'Correlate runtime telemetry', 'Store analyses'].map(purposeful);
    expect(orch.catalogQualityFailure(six, 20)).toBeUndefined();
  });

  it('accepts grounded capability identities whose descriptions are queued for focused AI repair', () => {
    const repairing = ['View industry reports', 'Browse products', 'Access user account']
      .map(name => cap({
        id: name,
        name,
        description: '',
        operations: anchorOp(name),
        description_source: undefined,
        description_generation: {
          status: 'ai_rejected',
          attempted: true,
          reason: 'catalog-audience:marketing-language',
        },
      }));

    expect(orch.catalogQualityFailure(repairing, 6)).toBeUndefined();
  });

  it('requires every selected behavior family to be cited even when the capability count passes', () => {
    const capabilities = [
      purposeful('Analyze codebases'),
      purposeful('Coordinate overlapping work'),
      purposeful('Correlate runtime telemetry'),
    ];
    capabilities[0].criticality_factors = ['catalog-candidate:analysis'];
    capabilities[1].criticality_factors = ['catalog-candidate:fabric'];

    expect(orch.catalogQualityFailure(capabilities, 5, ['analysis', 'fabric', 'runtime']))
      .toContain('runtime');
    capabilities[2].criticality_factors = ['catalog-candidate:runtime'];
    expect(orch.catalogQualityFailure(capabilities, 5, ['analysis', 'fabric', 'runtime']))
      .toBeUndefined();
  });

  it('requires one cited candidate from every distinct product-entity family', () => {
    const capabilities = [
      purposeful('Track parcels'),
      purposeful('Record inspections'),
    ];
    capabilities[0].criticality_factors = ['catalog-candidate:parcel-read'];
    capabilities[1].criticality_factors = ['catalog-candidate:inspection'];

    expect(orch.catalogQualityFailure(capabilities, 2, [], [
      ['parcel-read', 'parcel-write'],
      ['inspection'],
      ['reservation'],
    ])).toContain('reservation');
    capabilities.push(purposeful('Manage reservations'));
    capabilities[2].criticality_factors = ['catalog-candidate:reservation'];
    expect(orch.catalogQualityFailure(capabilities, 3, [], [
      ['parcel-read', 'parcel-write'],
      ['inspection'],
      ['reservation'],
    ])).toBeUndefined();
  });
});

describe('capability catalog entity grounding', () => {
  it('rejects another product entity in a name unless the capability cites that entity', () => {
    const evaluation = evaluateCapabilityCatalogAudience([
      cap({
        id: 'invoice',
        name: 'Settle invoices for fuel purchases',
        description: 'Invoices are marked settled after their payments are captured.',
        related_entities: ['entity_invoice'],
        operations: [{ entry_point_id: 'ep_invoice', entry_point_type: 'http', action: 'Settle' }] as any,
      }),
    ], [
      { id: 'entity_invoice', name: 'Invoice', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'entity_fuel', name: 'FuelPurchase', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
    ] as any, [], []);

    expect(evaluation.accepted).toEqual([]);
    expect(evaluation.rejections[0]).toMatchObject({
      target: 'name',
      reasons: ['unrelated-entity-vocabulary'],
      flaggedTokens: ['FuelPurchase'],
    });
  });

  it('allows a combined outcome when every named product entity is structurally related', () => {
    const evaluation = evaluateCapabilityCatalogAudience([
      cap({
        id: 'settlement',
        name: 'Settle invoices for fuel purchases',
        description: 'Fuel purchases retain the invoices marked settled after their payments are captured.',
        related_entities: ['entity_invoice', 'entity_fuel'],
        operations: [{ entry_point_id: 'ep_settlement', entry_point_type: 'http', action: 'Settle' }] as any,
      }),
    ], [
      { id: 'entity_invoice', name: 'Invoice', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
      { id: 'entity_fuel', name: 'FuelPurchase', lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] } },
    ] as any, [], []);

    expect(evaluation.rejections).toEqual([]);
    expect(evaluation.accepted).toHaveLength(1);
  });
});

describe('capability candidate terminality ranking', () => {
  it('ranks a downstream product outcome ahead of its equally grounded prerequisite', () => {
    const prerequisite = cap({
      id: 'prerequisite',
      name: 'Authorize access',
      related_entities: ['entity_access'],
      operations: [{ entry_point_id: 'ep_access', entry_point_type: 'http', action: 'authorize' }] as any,
    });
    const outcome = cap({
      id: 'outcome',
      name: 'Complete purchase',
      related_entities: ['entity_purchase'],
      operations: [{ entry_point_id: 'ep_purchase', entry_point_type: 'http', action: 'purchase' }] as any,
      depends_on: [{
        from_capability: 'outcome',
        to_capability: 'prerequisite',
        dependency_type: 'requires',
        strength: 'required',
        evidence: { shared_services: [], shared_nodes: [] },
        description: 'Purchase requires access',
      }],
    });
    const ranked = orch.rankCatalogPromptCandidates([prerequisite, outcome], []);
    expect(ranked.map((candidate: SystemCapability) => candidate.id)).toEqual(['outcome', 'prerequisite']);
  });
});

describe('catalogQualityFailure: unanchored capabilities (defect — AI fabricates capabilities with ZERO structural evidence)', () => {
  // Real shipped fabrications from a chat-gateway/assistant-runtime CAS
  // (25-repo capability corpus, 215 capabilities characterized): "Manages
  // fleet operations", "Manages vehicle maintenance", "Provides driver
  // communication" — each with operations=0, related_entities=0, no entry
  // points. Confident prose, zero anchoring. This is the RECONCILED-output
  // half of the anchor gate (defense-in-depth for the assembly-loop gate in
  // aiExtractCapabilityCatalog): reused/manual capabilities carried forward
  // across incremental runs never pass back through that gate, so this check
  // must independently catch an unanchored item in whatever ships.
  const unanchored = (name: string) => cap({ id: name, name, description: `Manages ${name.toLowerCase()} end to end for operators.` });
  const anchored = (name: string) => cap({
    id: name, name, description: `Grounded prose about ${name} and why the ability exists in the product.`,
    operations: [{ entry_point_id: `ep_${name}`, entry_point_type: 'http', action: 'Handle' }] as any,
  });

  it('fails a catalog where an otherwise-rich set carries one unanchored fabrication', () => {
    const six = [
      anchored('Analyze codebases'), anchored('Serve agent context over MCP'), anchored('Coordinate agent fleets'),
      anchored('Detect deployables'), anchored('Correlate runtime telemetry'),
      unanchored('Manages fleet operations'),
    ];
    const failure = orch.catalogQualityFailure(six, 20);
    expect(failure).toContain('unanchored');
    expect(failure).toContain('Manages fleet operations');
  });

  it('a capability anchored by a related entity ALONE (no operations) is not flagged unanchored', () => {
    const six = [
      anchored('Analyze codebases'), anchored('Serve agent context over MCP'), anchored('Coordinate agent fleets'),
      anchored('Detect deployables'), anchored('Correlate runtime telemetry'),
      cap({ id: 'entity-anchored', name: 'Manage subscriber records', description: 'Owns subscriber account records end to end for operators.', related_entities: ['entity_subscriber'] }),
    ];
    expect(orch.catalogQualityFailure(six, 20)).toBeUndefined();
  });
});

describe('runCapabilityCatalogWithQualityGate (retry-before-degrade, defect #33)', () => {
  const anchorOp = (name: string) => ([{ entry_point_id: `ep_${name.replace(/\W+/g, '_')}`, entry_point_type: 'http', action: 'Handle' }] as any);
  const gateArgs = (localOrch: any) => ({
    systemName: 'sys',
    enhancedSystemPurpose: { primary_domain: 'analysis', core_concepts: [] },
    frameworks: [],
    userJourneys: [],
    dataEntities: [],
    candidateSnapshot: [
      'Manage orders', 'Track portfolios', 'Settle payments', 'Review invoices',
      'Enroll devices', 'Authorize access', 'Publish messages', 'Schedule jobs',
      'Analyze risks', 'Generate reports', 'Sync inventory', 'Configure policies',
    ].map((name, index) => cap({ id: `cand_${index}`, name, operations: anchorOp(name) })),
    behaviorSurfaces: [],
    externalServices: [],
    flowGraph: { capability_candidates: [] },
    projectTextSignal: { concepts: [], evidence: [] },
    entryPoints: [],
    nodes: [],
    budgetMs: 1000,
  });

  it('retries a collapsed catalog with a quality nudge and keeps the passing retry result', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const collapsed = ['View entry points', 'View functions', 'View dashboard'].map(name => cap({ id: name, name, description: `Surfaces the ${name.toLowerCase()} page for users of the product.` }));
    const rich = ['Analyze codebases', 'Serve agent context over MCP', 'Coordinate agent fleets', 'Detect deployables', 'Correlate runtime telemetry', 'Store analyses'].map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists in the product.`, operations: anchorOp(name) }));
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      return calls.length === 1 ? collapsed : rich;
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));
    expect(out).toHaveLength(6);
    expect(calls).toHaveLength(2);
    expect(calls[0].qualityNudge).toBeUndefined();
    expect(calls[1].qualityNudge).toContain('quality check');
  });

  it('tells the next AI cycle exactly which audience failures require repair', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const rejected = [
      cap({
        id: 'reports',
        name: 'View industry reports',
        description: 'Provides seamless insights into available industry reports.',
        operations: anchorOp('reports'),
      }),
      cap({
        id: 'products',
        name: 'Browse products',
        description: undefined,
        operations: anchorOp('products'),
      }),
    ];
    const repaired = ['View industry reports', 'Browse products', 'Access user account', 'Generate invoices']
      .map(name => cap({
        id: name,
        name,
        description: `Lets users complete ${name.toLowerCase()} using the observed product information.`,
        operations: anchorOp(name),
      }));
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      return calls.length === 1 ? rejected : repaired;
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) =>
      extracted.filter(capability => capability.description && !capability.description.includes('seamless'));

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));

    expect(out).toEqual(repaired);
    expect(calls).toHaveLength(2);
    expect(calls[1].qualityNudge).toContain('View industry reports');
    expect(calls[1].qualityNudge).toContain('marketing-language');
    expect(calls[1].qualityNudge).toContain('Browse products');
    expect(calls[1].qualityNudge).toContain('missing');
  });

  it('preserves grounded capability identities for the dedicated description repair stage', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const extracted = [
      cap({ id: 'reports', name: 'View industry reports', description: 'Provides seamless insights into industry reports.', operations: anchorOp('reports') }),
      cap({ id: 'products', name: 'Browse products', description: '', operations: anchorOp('products') }),
      cap({ id: 'account', name: 'Access user account', description: 'Executes the main CLI entry point for account commands.', operations: anchorOp('account') }),
      cap({ id: 'company', name: 'View company information', description: 'View company information.', operations: anchorOp('company') }),
    ];
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => {
      calls++;
      return extracted;
    };

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));

    expect(calls).toBe(2);
    expect(out).toHaveLength(4);
    expect(out.every(capability => capability.description === '')).toBe(true);
    expect(out.every(capability => capability.description_generation?.status === 'ai_rejected')).toBe(true);
  });

  it('rejects a catalog after bounded no-progress retries', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const collapsed = ['View entry points', 'View functions'].map(name => cap({ id: name, name, description: `Surfaces the ${name.toLowerCase()} page for users of the product.` }));
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => { calls++; return collapsed; };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));
    expect(calls).toBe(2);
    expect(out).toEqual([]);
  });

  it('passes a good first catalog through with a single call', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const rich = ['Analyze codebases', 'Serve agent context over MCP', 'Coordinate agent fleets', 'Detect deployables', 'Correlate runtime telemetry', 'Store analyses'].map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists in the product.`, operations: anchorOp(name) }));
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => { calls++; return rich; };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));
    expect(calls).toBe(1);
    expect(out).toHaveLength(6);
  });

  it('retries when a passing-size catalog omits a behavior family citation', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args: any = gateArgs(localOrch);
    args.projectTextSignal = { concepts: ['concurrent work'], evidence: [] };
    args.behaviorSurfaces = [{
      id: 'fabric',
      name: 'Concurrent Work Tool Surface',
      category: 'internal',
      evidence_kind: 'behavior-surface',
      evidence_examples: ['claim_work', 'check_collision', 'update_claim', 'release_work'],
      criticality_factors: ["4 message entry points form one cohesive behavior family ('fabric')"],
      operations: ['claim', 'check', 'update', 'release'].map(entryPointId => ({
        entry_point_id: entryPointId,
        entry_point_type: 'message',
        action: 'Handle',
      })),
      related_entities: [],
      related_domains: [],
    }];
    const rich = ['Analyze codebases', 'Serve agent context over MCP', 'Coordinate agent fleets', 'Detect deployables', 'Correlate runtime telemetry', 'Store analyses']
      .map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists in the product.`, operations: anchorOp(name) }));
    const covered = rich.map(capability => ({ ...capability }));
    covered[2].criticality_factors = ['catalog-candidate:fabric'];
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      return calls.length === 1 ? rich : covered;
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);
    expect(calls).toHaveLength(2);
    expect(calls[1].qualityNudge).toContain('fabric');
    expect(calls[1].qualityNudge).toContain('claim_work');
    expect(calls[1].qualityNudge).toContain('evidence_subject');
    expect(calls[1].qualityNudge).toContain('evidence_subject_terms');
    expect(calls[1].qualityNudge).toContain('MUST contain at least one exact evidence_subject_terms token');
    expect(out).toEqual(covered);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage.candidate_dispositions).toEqual(
      expect.arrayContaining([expect.objectContaining({ candidate_id: 'fabric', role: 'unresolved' })]),
    );
  });

  it('constrains a history-family repair to its evidence subject instead of an unrelated global outcome', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args: any = gateArgs(localOrch);
    args.dataEntities = [
      { id: 'entity_changehistoryentry', name: 'ChangeHistoryEntry', kind: 'record', fields: [] },
      { id: 'entity_unrelated', name: 'UnrelatedWorkspace', kind: 'record', fields: [] },
    ];
    args.userJourneys = [{ name: 'Configure unrelated workspace' }];
    args.externalServices = ['UnrelatedService'];
    args.candidateSnapshot.push(cap({
      id: 'cap_history', name: 'History', structural_label: 'History Management',
      description: 'Tracks changes to analyzed software over time.',
      related_domains: ['history'], related_entities: ['entity_changehistoryentry'],
      operations: anchorOp('history'),
    }));
    const accepted = ['Analyze codebases', 'Coordinate agent work', 'Correlate runtime signals', 'Assess change risk']
      .map(name => cap({ id: name, name, description: `Grounded product outcome for ${name.toLowerCase()} across connected software.`, operations: anchorOp(name) }));
    const repaired = cap({
      id: 'review-history', name: 'Review codebase change history',
      description: 'Lets engineers review how analyzed software changed across saved codebase revisions.',
      operations: anchorOp('history'), criticality_factors: ['catalog-candidate:cap_history'],
    });
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      return calls.length === 1 ? accepted : [repaired];
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(calls).toHaveLength(2);
    expect(calls[1].qualityNudge).toContain('"candidate_id":"cap_history"');
    expect(calls[1].qualityNudge).toContain('"evidence_subject_terms":["change","history"]');
    expect(calls[1].qualityNudge).toContain('unrelated global product vocabulary is invalid');
    expect(calls[1]).toMatchObject({ exactCapabilityLimit: 1, userJourneys: [], externalServices: [] });
    expect(calls[1].dataEntities.map((entity: any) => entity.id)).toEqual(['entity_changehistoryentry']);
    expect(out.map(capability => capability.name)).toContain('Review codebase change history');
  });

  it('preserves a cited behavior identity for the dedicated description repair stage', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args: any = gateArgs(localOrch);
    args.projectTextSignal = { concepts: ['workspace', 'software understanding', 'agent context'], evidence: [] };
    args.behaviorSurfaces = [{
      id: 'workspace',
      name: 'Workspace MCP Tool Surface',
      category: 'internal',
      evidence_kind: 'behavior-surface',
      evidence_examples: ['get_agent_context', 'get_product_map', 'get_analysis_freshness'],
      criticality_factors: ["3 message entry points form one cohesive behavior family ('workspace')"],
      operations: ['get_agent_context', 'get_product_map', 'get_analysis_freshness'].map(entryPointId => ({
        entry_point_id: entryPointId,
        entry_point_type: 'message',
        action: 'Retrieve',
      })),
      related_entities: [],
      related_domains: [],
    }];
    const retained = ['Analyze codebases', 'Coordinate agent work', 'Correlate runtime signals', 'Assess change risk', 'Explain system behavior']
      .map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists.`, operations: anchorOp(name) }));
    const rejectedWorkspace = cap({
      id: 'workspace-context',
      name: 'Retrieve codebase context for agents',
      description: 'The workspace surfaces agent context, capability maps, and entity maps for codebase understanding.',
      operations: anchorOp('workspace-context'),
      criticality_factors: ['catalog-candidate:workspace'],
    });
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      return [...retained, rejectedWorkspace];
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(calls).toHaveLength(1);
    expect(out).toHaveLength(6);
    expect(out[out.length - 1]).toMatchObject({
      name: rejectedWorkspace.name,
      description_generation: { status: 'ai_rejected', reason: 'description-internal-analysis-vocabulary' },
    });
    expect(out[out.length - 1]?.description).toBe('');
  });

  it('adds targeted evidence without collapsing distinct accepted outcomes', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args: any = gateArgs(localOrch);
    args.projectTextSignal = { concepts: ['workspace', 'codebase relationships'], evidence: [] };
    args.behaviorSurfaces = [{
      id: 'workspace', name: 'Workspace MCP Tool Surface', category: 'internal', evidence_kind: 'behavior-surface',
      evidence_examples: ['get_agent_context', 'get_product_map'],
      criticality_factors: ["2 message entry points form one cohesive behavior family ('workspace')"],
      operations: ['get_agent_context', 'get_product_map'].map(entry_point_id => ({ entry_point_id, entry_point_type: 'message', action: 'Retrieve' })),
      related_entities: [], related_domains: ['workspace'],
    }];
    const retained = [
      'Review codebase relationships before changes',
      'Review codebase relationships during changes',
      'Coordinate agent work',
      'Correlate runtime signals',
    ].map(name => cap({ id: name, name, description: `Grounded product outcome for ${name.toLowerCase()} across connected software.`, operations: anchorOp(name) }));
    const repaired = cap({
      ...retained[0],
      criticality_factors: [...retained[0].criticality_factors, 'catalog-candidate:workspace'],
    });
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => ++calls === 1 ? retained : [repaired];
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(calls).toBe(2);
    expect(out.map(capability => capability.name)).toEqual(retained.map(capability => capability.name));
    expect(out[0].criticality_factors).toContain('catalog-candidate:workspace');
  });

  it('carries a rejected focused title into the next repair instruction', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args: any = gateArgs(localOrch);
    args.projectTextSignal = { concepts: ['codebase', 'software understanding'], evidence: [] };
    args.behaviorSurfaces = [{
      id: 'codebase', name: 'Codebase MCP Tool Surface', category: 'internal', evidence_kind: 'behavior-surface',
      evidence_examples: ['analyze_codebase', 'get_codebase_idioms'],
      criticality_factors: ["2 message entry points form one cohesive behavior family ('codebase')"],
      operations: anchorOp('codebase'), related_entities: [], related_domains: ['codebase'],
    }];
    const retained = ['Review software relationships', 'Coordinate agent work', 'Correlate runtime signals']
      .map(name => cap({ id: name, name, description: `Grounded product outcome for ${name.toLowerCase()} across connected software.`, operations: anchorOp(name) }));
    const repaired = cap({
      id: 'analyze-codebase', name: 'Analyze codebases', description: 'Analyzes codebase structure and behavior for people and software agents.',
      operations: anchorOp('codebase'), criticality_factors: ['catalog-candidate:codebase'],
    });
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      if (calls.length === 1) {
        input.onRejection?.({
          candidateIds: ['codebase'],
          name: 'Analyze codebase configuration',
          reason: 'outcome-scope-unsupported:configuration',
        });
        return retained;
      }
      return [repaired];
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(calls).toHaveLength(2);
    expect(calls[1].qualityNudge).toContain('Analyze codebase configuration');
    expect(calls[1].qualityNudge).toContain('"forbidden_subject_terms":["configuration"]');
    expect(out.some(capability => capability.name === 'Analyze codebases')).toBe(true);
  });

  it('preserves a rejected description identity even when its evidence family is already covered', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args: any = gateArgs(localOrch);
    args.projectTextSignal = { concepts: ['workspace', 'software understanding'], evidence: [] };
    args.behaviorSurfaces = [{
      id: 'workspace', name: 'Workspace MCP Tool Surface', category: 'internal', evidence_kind: 'behavior-surface',
      evidence_examples: ['get_agent_context', 'get_product_map'],
      criticality_factors: ["2 message entry points form one cohesive behavior family ('workspace')"],
      operations: anchorOp('workspace'), related_entities: [], related_domains: ['workspace'],
    }];
    const accepted = ['Understand software behavior', 'Coordinate agent work', 'Correlate runtime signals']
      .map((name, index) => cap({
        id: name, name, description: `Grounded product outcome for ${name.toLowerCase()} across connected software.`,
        operations: anchorOp(name),
        criticality_factors: index === 0 ? ['catalog-candidate:workspace'] : [],
      }));
    const rejected = cap({
      id: 'review-change-risk', name: 'Review change risk', description: '', operations: anchorOp('review-change-risk'),
      criticality_factors: ['catalog-candidate:workspace'],
    });
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      return [...accepted, rejected];
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(calls).toHaveLength(1);
    expect(out.map(capability => capability.name)).toEqual([...accepted.map(capability => capability.name), rejected.name]);
    expect(out[out.length - 1]).toMatchObject({ description: '', description_generation: { status: 'ai_rejected' } });
  });

  it('does not make an uncorroborated delivery surface a mandatory product family', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args: any = gateArgs(localOrch);
    args.behaviorSurfaces = [{
      id: 'notebook-execution',
      name: 'Notebook Execution Surface',
      evidence_kind: 'behavior-surface',
      evidence_examples: ['execute_cell', 'run_notebook'],
      criticality_factors: ["2 message entry points form one cohesive behavior family ('notebook-execution')"],
      operations: anchorOp('notebook-execution'),
      related_entities: [],
      related_domains: [],
    }];
    const grounded = ['Analyze codebases', 'Serve agent context', 'Coordinate agent work', 'Correlate runtime signals', 'Assess change risk', 'Explain system behavior']
      .map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists.`, operations: anchorOp(name) }));
    localOrch.aiExtractCapabilityCatalog = async () => grounded;
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(out).toEqual(grounded);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage).toMatchObject({
      status: 'accepted',
      published_capabilities: grounded.length,
    });
    expect(args.enhancedSystemPurpose.capability_catalog_coverage.candidate_dispositions).toEqual(
      expect.arrayContaining([expect.objectContaining({ candidate_id: 'notebook-execution', role: 'supporting-mechanism' })]),
    );
  });

  it('does not force internal bootstrap and scheduling surfaces into the product capability catalog', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args: any = gateArgs(localOrch);
    args.behaviorSurfaces = [
      {
        id: 'cap_server_bootstrap_surface',
        name: 'Server Bootstrap Surface',
        evidence_kind: 'behavior-surface',
        category: 'internal',
        evidence_examples: ['HTTP Server: port 3000'],
        operations: anchorOp('bootstrap'),
        related_entities: [],
        related_domains: [],
      },
      {
        id: 'cap_scheduled_job_surface',
        name: 'Scheduled Job Surface',
        evidence_kind: 'behavior-surface',
        category: 'internal',
        evidence_examples: ['Scheduled: pruneActivityLogs'],
        operations: anchorOp('schedule'),
        related_entities: [],
        related_domains: [],
      },
    ];
    const grounded = ['Analyze codebases', 'Serve agent context', 'Coordinate agent work', 'Correlate runtime signals', 'Assess change risk', 'Explain system behavior']
      .map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists.`, operations: anchorOp(name) }));
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => { calls++; return grounded; };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(calls).toBe(1);
    expect(out).toEqual(grounded);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage.status).toBe('accepted');
  });

  it('retains the quality reason associated with the best grounded catalog when a later retry is empty', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args: any = gateArgs(localOrch);
    args.projectTextSignal = { concepts: ['notebook execution'], evidence: [] };
    args.behaviorSurfaces = [{
      id: 'notebook-execution',
      name: 'Notebook Execution Surface',
      evidence_kind: 'behavior-surface',
      category: 'supporting',
      evidence_examples: ['execute_cell', 'run_notebook'],
      criticality_factors: ["2 message entry points form one cohesive behavior family ('notebook-execution')"],
      operations: [
        { entry_point_id: 'execute_cell', entry_point_type: 'message', action: 'Handle' },
        { entry_point_id: 'run_notebook', entry_point_type: 'message', action: 'Handle' },
      ],
      related_entities: [],
      related_domains: [],
    }];
    const grounded = ['Analyze codebases', 'Serve agent context', 'Coordinate agent work', 'Correlate runtime signals', 'Assess change risk', 'Explain system behavior']
      .map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists.`, operations: anchorOp(name) }));
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => ++calls === 1 ? grounded : [];
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(out).toEqual(grounded);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage.reason).toContain('catalog omitted');
  });

  it('returns no canonical capabilities after all authored catalog cycles fail', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => { calls++; return []; };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));
    expect(calls).toBe(2);
    expect(out).toHaveLength(0);
  });

  it('does not publish a partial catalog that cannot satisfy required evidence coverage', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const grounded = cap({
      id: 'analyze-codebases',
      name: 'Analyze codebases',
      description: 'Explains observed code behavior and relationships for engineering teams.',
      operations: anchorOp('analyze-codebases'),
    });
    localOrch.aiExtractCapabilityCatalog = async () => [grounded];
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;
    const args: any = gateArgs(localOrch);

    const out = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(out).toEqual([]);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage).toMatchObject({
      status: 'rejected',
      published_capabilities: 0,
    });
    expect(args.enhancedSystemPurpose.capability_catalog_coverage.reason).toBeDefined();
  });

  it('accepts a smaller passing retry instead of retaining a larger rejected catalog', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const rejected = Array.from({ length: 8 }, (_, index) => cap({
      id: `rejected_${index}`,
      name: `Area ${index}`,
      description: 'Grounded prose describing a real ability of the product.',
      operations: anchorOp(`rejected_${index}`),
    }));
    const accepted = ['Analyze codebases', 'Serve agent context', 'Coordinate agent work', 'Correlate runtime signals', 'Assess change risk', 'Explain system behavior']
      .map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists.`, operations: anchorOp(name) }));
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => ++calls === 1 ? rejected : accepted;
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));
    expect(out).toEqual(accepted);
    expect(calls).toBe(2);
  });

  it('refuses an unanchored item without discarding the grounded catalog', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const withFabrication = [
      ...['Analyze codebases', 'Serve agent context over MCP', 'Coordinate agent fleets', 'Detect deployables', 'Correlate runtime telemetry']
        .map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists in the product.`, operations: anchorOp(name) })),
      cap({ id: 'fab', name: 'Manages fleet operations', description: 'Manages fleet operations end to end for dispatch teams.' }),
    ];
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      return withFabrication;
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));
    expect(calls).toHaveLength(1);
    expect(out.map((capability: SystemCapability) => capability.name)).not.toContain('Manages fleet operations');
    expect(out).toHaveLength(5);
  });

  it('refuses bare-noun additions without discarding publishable authored capabilities', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const grounded = ['Manage access requests', 'Register network agents', 'Review activity logs', 'Configure resource policies', 'Control inline gateways']
      .map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists.`, operations: anchorOp(name) }));
    const mixed = [
      ...grounded,
      cap({ id: 'access', name: 'Access', description: 'Provides access details for organization administrators.', operations: anchorOp('access') }),
      cap({ id: 'network', name: 'Network (AccessBinding)', description: 'Connects network records to their access bindings.', operations: anchorOp('network') }),
    ];
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => { calls++; return mixed; };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));

    expect(calls).toBe(1);
    expect(out).toEqual(grounded);
  });
});
