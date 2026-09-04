import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { evaluateCapabilityCatalogAudience } from '../../analyzer/core/capability-catalog-audience';
import { capabilityCatalogOutcomeCoverageFailure, deriveCapabilityCatalogOutcomeRequirements } from '../../analyzer/core/capability-catalog-outcome-coverage';
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

describe('description repair rejection feedback', () => {
  it('preserves the exact validator reason after identity and structural gates pass', () => {
    expect(orch.capabilityPublishabilityFailure(cap({
      name: 'Access external records',
      description: '',
      operations: [{ entry_point_id: 'read', entry_point_type: 'internal', action: 'Read' }] as any,
      description_generation: {
        status: 'ai_rejected', attempted: true, reason: 'implementation-surface-restatement',
      },
    }))).toBe('implementation-surface-restatement');
  });

  it('rejects generated field labels leaked into capability names', () => {
    expect(orch.capabilityPublishabilityFailure(cap({
      name: 'filter: Filter between job applications',
      operations: [{ entry_point_id: 'filter', entry_point_type: 'http', action: 'filter' }] as any,
    }))).toBe('generated-label-prefix');
  });

  it('retains description failures for repair but retires malformed names', () => {
    expect(orch.isRepairRetainableCapability(cap({
      name: 'filter: Filter between job applications',
      operations: [{ entry_point_id: 'filter', entry_point_type: 'http', action: 'filter' }] as any,
    }))).toBe(false);
    expect(orch.isRepairRetainableCapability(cap({
      name: 'Filter job applications', description: '',
      operations: [{ entry_point_id: 'filter', entry_point_type: 'http', action: 'filter' }] as any,
    }))).toBe(true);
  });

  it('does not let a rejected description mask structural or identity failures', () => {
    const rejected: Pick<SystemCapability, 'description' | 'description_generation'> = {
      description: '',
      description_generation: {
        status: 'ai_rejected', attempted: true, reason: 'implementation-surface-restatement',
      },
    };
    expect(orch.capabilityPublishabilityFailure(cap({
      ...rejected, name: 'Access external records', operations: [], related_entities: [],
    }))).toBe('missing-structural-anchor');
    expect(orch.capabilityPublishabilityFailure(cap({
      ...rejected, name: 'Records',
      operations: [{ entry_point_id: 'read', entry_point_type: 'internal', action: 'Read' }] as any,
    }))).toBe('bare-noun-name');
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

  it('merges same-outcome obligation scopes without losing their operations or provenance', () => {
    const exact = (id: string, action: string, entryPointId: string) => cap({
      id, name: 'Remove records',
      description: 'Users remove records through the verified product workflow.',
      operations: [{ entry_point_id: entryPointId, entry_point_type: 'http', action }] as any,
      related_entities: ['entity_record'],
      criticality_factors: [`catalog-operation-obligation:operation-obligation:records:${id}`],
    });
    const removeCategory = exact('remove-category', 'delete', 'delete-category');
    const removeJob = exact('remove-job', 'delete', 'delete-job');
    const caps = [removeJob, removeCategory];

    orch.finalizeSystemCapabilityNames(caps);

    expect(caps).toHaveLength(1);
    expect(caps[0].operations.map(operation => operation.entry_point_id).sort()).toEqual([
      'delete-category', 'delete-job',
    ]);
    expect(caps[0].criticality_factors.filter(factor => factor.startsWith('catalog-operation-obligation:')).sort()).toEqual([
      'catalog-operation-obligation:operation-obligation:records:remove-category',
      'catalog-operation-obligation:operation-obligation:records:remove-job',
    ]);
  });
});

describe('operation-only catalog reconciliation', () => {
  const operation = {
    entry_point_id: 'ep_identity',
    entry_point_type: 'event',
    action: 'Authenticate',
  } as any;
  const entryPoints = [{ id: 'ep_identity', source_node: 'node_identity' }] as any;
  const nodes = [{ id: 'node_identity', type: 'function' }] as any;

  it('keeps an entity-free outcome grounded by cited product-outcome evidence', () => {
    const evidence = cap({
      id: 'identity-surface',
      name: 'Identity surface',
      evidence_kind: 'behavior-surface',
      evidence_role: 'product-outcome',
      operations: [operation],
    });
    const authored = cap({
      id: 'authenticate-users',
      name: 'Authenticate users',
      description: 'Users authenticate their identity before entering protected product workflows.',
      operations: [operation],
      related_entities: [],
      criticality_factors: ['catalog-candidate:identity-surface'],
    });

    expect(orch.reconcileCatalogedCapabilities(
      [authored], [evidence], [], entryPoints, nodes, undefined, [], { concepts: [], evidence: [] }, [],
    )).toEqual([expect.objectContaining({ id: 'authenticate-users' })]);
  });

  it('does not keep an entity-free gesture grounded only by supporting evidence', () => {
    const evidence = cap({
      id: 'navigation-gesture',
      name: 'Navigation gesture',
      evidence_kind: 'behavior-surface',
      evidence_role: 'supporting-mechanism',
      operations: [{ ...operation, action: 'Click' }],
    });
    const authored = cap({
      id: 'open-navigation',
      name: 'Open navigation',
      description: 'Users open navigation controls while moving between product screens.',
      operations: [{ ...operation, action: 'Click' }],
      related_entities: [],
      criticality_factors: ['catalog-candidate:navigation-gesture'],
    });

    expect(orch.reconcileCatalogedCapabilities(
      [authored], [evidence], [], entryPoints, nodes, undefined, [], { concepts: [], evidence: [] }, [],
    )).toEqual([]);
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

  it('accepts an empty catalog when no authored outcome is grounded', () => {
    expect(orch.catalogQualityFailure([], 20)).toBeUndefined();
  });

  it('does not impose a structural-family count quota on a small grounded catalog', () => {
    const three = [purposeful('View entry points'), purposeful('View functions'), purposeful('View dashboard')];
    expect(orch.catalogQualityFailure(three, 20)).toBeUndefined();
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

  it('publishes deterministic evidence recovery only with an explicit degraded quality reason', () => {
    const recovered = purposeful('View job sites');
    recovered.name_source = 'deterministic';
    recovered.description_source = 'deterministic';
    expect(orch.catalogQualityFailure([recovered], 1)).toContain('deterministic recovery');
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

  it('does not turn operation-level evidence into a publication quota', () => {
    const capabilities = [
      purposeful('Analyze codebases'),
      purposeful('Coordinate overlapping work'),
      purposeful('Correlate runtime telemetry'),
    ];
    capabilities[0].criticality_factors = ['catalog-candidate:analysis'];
    capabilities[1].criticality_factors = ['catalog-candidate:fabric'];
    capabilities[2].criticality_factors = ['catalog-candidate:runtime'];

    expect(orch.catalogQualityFailure(capabilities, 5, ['runtime']))
      .toBeUndefined();
  });

  it('does not turn distinct product-entity families into publication quotas', () => {
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
    ])).toBeUndefined();
  });

  it('fails closed when a catalog omits independently grounded product-evidence families', () => {
    const capabilities = [
      purposeful('Create records'),
      purposeful('Track record status'),
      purposeful('Review aggregate statistics'),
      purposeful('Review categorized records'),
    ];
    capabilities[0].criticality_factors = ['catalog-candidate:record-write', 'catalog-candidate:record-update'];
    capabilities[1].criticality_factors = ['catalog-candidate:record-status'];
    capabilities[2].criticality_factors = ['catalog-candidate:record-statistics'];
    capabilities[3].criticality_factors = ['catalog-candidate:record-category'];
    const families = [
      ['record-write'], ['record-update'], ['record-status'], ['record-statistics'],
      ['record-category'], ['record-notes'], ['record-sites'],
    ];

    expect(orch.catalogQualityFailure(capabilities, 7, [], [], [], families))
      .toContain('omits 2 grounded product-evidence families: record-notes, record-sites');
  });

  it('rejects a citation-complete catalog that omits corroborated first-party audience outcomes', () => {
    const evidence = [
      cap({ id: 'understanding', name: 'Explore connected software behavior', structural_label: 'Software behavior exploration', evidence_examples: ['inspect_behavior'] }),
      cap({ id: 'graph', name: 'Relationship graph analysis', structural_label: 'Trustworthy relationship graph', evidence_examples: ['query_relationships'] }),
    ];
    const requirements = deriveCapabilityCatalogOutcomeRequirements({
      productDocSummary: 'Builds a trustworthy relationship graph and turns it into behavior comprehension for people and AI agents.',
    }, evidence);
    const agentOnly = purposeful('Give AI agents software comprehension');
    agentOnly.description = 'AI agents understand connected software behavior before making changes.';
    agentOnly.criticality_factors = ['catalog-candidate:understanding', 'catalog-candidate:graph'];

    expect(orch.catalogQualityFailure([agentOnly], 1, [], [], requirements)).toContain('first-party product outcomes');
  });
});

describe('capability catalog entity grounding', () => {
  it('does not treat grammatical connectors as shortened product identifiers', () => {
    const evaluation = evaluateCapabilityCatalogAudience([
      cap({
        id: 'notes',
        name: 'Add notes to job records',
        description: 'Users add notes to job records so application context remains available.',
        operations: [{ entry_point_id: 'ep_notes', entry_point_type: 'http', action: 'Add note' }] as any,
      }),
    ], [], [], ['Todo Jobs']);

    expect(evaluation.rejections).toEqual([]);
    expect(evaluation.accepted).toHaveLength(1);
  });

  it('continues to reject genuine shortened product identifiers in capability subjects', () => {
    const evaluation = evaluateCapabilityCatalogAudience([
      cap({
        id: 'records',
        name: 'Manage kl audit records',
        description: 'Users manage audit records that remain available for later review.',
        operations: [{ entry_point_id: 'ep_records', entry_point_type: 'http', action: 'Manage audit records' }] as any,
      }),
    ], [], [], ['Klarity Platform']);

    expect(evaluation.rejections[0]).toMatchObject({
      target: 'name', reasons: ['shortened-product-term'], flaggedTokens: ['kl'],
    });
  });

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
      'Manage orders', 'Track portfolios', 'Settle payments', 'View invoices',
      'Add devices', 'Authorize access', 'Publish messages', 'Configure job schedules',
      'Analyze risks', 'View audit summaries', 'Sync inventory', 'Configure policies',
    ].map((name, index) => cap({ id: `cand_${index}`, name, category: 'core', operations: anchorOp(name) })),
    behaviorSurfaces: [],
    externalServices: [],
    flowGraph: { capability_candidates: [] },
    projectTextSignal: {
      concepts: ['manage orders', 'track portfolios', 'settle payments', 'view invoices', 'add devices', 'authorize access', 'publish messages', 'configure job schedules', 'analyze risks', 'view audit summaries', 'sync inventory', 'configure policies'],
      evidence: [],
      summary: 'The product lets users manage orders, track portfolios, settle payments, view invoices, add devices, authorize access, publish messages, configure job schedules, analyze risks, view audit summaries, sync inventory, and configure policies.',
    },
    entryPoints: [],
    exitPoints: [],
    nodes: [],
    edges: [],
    budgetMs: 1000,
  });
  const citeEveryGateFamily = (capabilities: SystemCapability[]): SystemCapability[] => capabilities.map(capability => ({
    ...capability,
    criticality_factors: [...new Set([
      ...(capability.criticality_factors || []),
      ...Array.from({ length: 12 }, (_, index) => `catalog-candidate:cand_${index}`),
    ])],
  }));

  const atomicGateArgs = (localOrch: any) => {
    const args: any = gateArgs(localOrch);
    const evidence = cap({
      id: 'notes-read', name: 'read note', structural_label: 'read note',
      category: 'core', evidence_kind: 'behavior-surface', evidence_role: 'product-outcome',
      operations: [{ entry_point_id: 'view-note', entry_point_type: 'http', action: 'read', trigger: { method: 'GET', path: '/notes' } }] as any,
      related_entities: ['entity_note'],
    });
    args.candidateSnapshot = [evidence];
    args.behaviorSurfaces = [evidence];
    args.dataEntities = [{ id: 'entity_note', name: 'Note', kind: 'persisted-entity', attributes: [] }];
    args.entryPoints = [{ id: 'view-note', name: 'View notes', type: 'http', route: { method: 'GET', path: '/notes' }, handler: { file: 'routes/notes.ts' }, metadata: {} }];
    args.projectTextSignal = { concepts: ['notes'], evidence: [], summary: 'Users view notes attached to their job applications.' };
    return args;
  };

  it('does not promote a structural atomic baseline before authored comprehension', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args = atomicGateArgs(localOrch);
    args.hardDeadlineAt = Date.now() - 1;
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => { calls++; return []; };

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(calls).toBe(0);
    expect(out).toEqual([]);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage).toMatchObject({ status: 'unavailable', published_capabilities: 0 });
  });

  it('does not publish structural closure after a completed cycle reaches the hard deadline', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args = atomicGateArgs(localOrch);
    args.hardDeadlineAt = Date.now() + 60_000;
    let providerCalls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => {
      providerCalls += 1;
      args.hardDeadlineAt = Date.now() - 1;
      return [];
    };
    const originalQualityFailure = localOrch.catalogQualityFailure.bind(localOrch);
    let qualityChecks = 0;
    localOrch.catalogQualityFailure = (...values: unknown[]) => {
      qualityChecks += 1;
      return qualityChecks === 1 ? 'forced-cycle-one-repair' : originalQualityFailure(...values);
    };

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(providerCalls).toBe(1);
    expect(qualityChecks).toBeGreaterThanOrEqual(2);
    expect(out).toEqual([]);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage).toMatchObject({ status: 'unavailable', published_capabilities: 0 });
  });

  it('revalidates complete deterministic coverage after no-progress termination', async () => {
    const completeOrch = new AnalyzerOrchestrator() as any;
    const completeArgs = atomicGateArgs(completeOrch);
    let completeCalls = 0;
    completeOrch.aiExtractCapabilityCatalog = async () => { completeCalls++; return []; };
    const completeQualityFailure = completeOrch.catalogQualityFailure.bind(completeOrch);
    let completeQualityChecks = 0;
    completeOrch.catalogQualityFailure = (...values: unknown[]) => {
      completeQualityChecks += 1;
      return completeQualityChecks <= 3 ? 'forced-no-progress-repair' : completeQualityFailure(...values);
    };

    const complete: SystemCapability[] = await completeOrch.runCapabilityCatalogWithQualityGate(completeArgs);

    expect(completeCalls).toBeGreaterThan(0);
    expect(completeQualityChecks).toBeGreaterThanOrEqual(3);
    expect(complete).toEqual([]);
    expect(completeArgs.enhancedSystemPurpose.capability_catalog_coverage).toMatchObject({ status: 'rejected', published_capabilities: 0 });

  });

  it('recovers grounded authored outcomes in the first cycle without broad repair calls', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args: any = gateArgs(localOrch);
    const outcome = 'Understand what a codebase actually built';
    const operation = {
      entry_point_id: 'understand-codebase',
      entry_point_type: 'message',
      action: 'Understand',
      path_or_command: 'get_agent_start_context',
    };
    const evidence = cap({
      id: 'understand-codebase',
      name: outcome,
      structural_label: 'Agent understanding surface',
      evidence_kind: 'behavior-surface',
      evidence_role: 'product-outcome',
      operations: [operation] as any,
    });
    args.candidateSnapshot = [evidence];
    args.behaviorSurfaces = [evidence];
    args.projectTextSignal = {
      productDocSummary: `${outcome}.`,
      concepts: ['understand codebase'],
      evidence: [],
    };
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => { calls += 1; return []; };
    localOrch.reconcileCatalogedCapabilities = (values: SystemCapability[]) => values;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(calls).toBe(1);
    expect(out).toEqual([expect.objectContaining({ name: outcome })]);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage).toMatchObject({
      status: 'accepted',
      published_capabilities: 1,
    });
  });

  it('keeps structural evidence out of the catalog when the provider returns no authored outcome', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args = atomicGateArgs(localOrch);
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => { calls.push(input); return []; };

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(out).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls.some(call => call.exactCapabilityLimit)).toBe(false);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage).toMatchObject({
      status: 'accepted',
      published_capabilities: 0,
    });
  });

  it('does not inject a deterministic atomic baseline around provider-authored output', async () => {
    const run = async (reverse: boolean) => {
      const localOrch = new AnalyzerOrchestrator() as any;
      const args = atomicGateArgs(localOrch);
      const wrong = cap({
        id: 'wrong', name: 'Add notes',
        description: 'Users add notes to job applications while reviewing each tracked opportunity.',
        operations: args.candidateSnapshot[0].operations,
        related_entities: ['entity_note'], criticality_factors: ['catalog-candidate:notes-read'],
      });
      const unrelated = cap({
        id: 'unrelated', name: 'Update profiles',
        description: 'Users update profile settings while managing their product account preferences.',
        operations: [], criticality_factors: [],
      });
      localOrch.aiExtractCapabilityCatalog = async () => reverse ? [unrelated, wrong] : [wrong, unrelated];
      localOrch.reconcileCatalogedCapabilities = (values: SystemCapability[]) => values;
      return localOrch.runCapabilityCatalogWithQualityGate(args) as Promise<SystemCapability[]>;
    };

    for (const out of [await run(false), await run(true)]) {
      const retained = out.find(item => item.criticality_factors.includes('catalog-candidate:notes-read'));
      expect(retained?.name).toBe('Add notes');
      expect(retained?.criticality_factors).not.toContain('catalog-deterministic-atomic-closure');
    }
  });

  it('allows a validated provider improvement without losing exact atomic coverage and abstains on ambiguous evidence', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args = atomicGateArgs(localOrch);
    const improvedDescription = 'Users view notes attached to job applications while reviewing each tracked opportunity.';
    const improved = cap({
      id: 'improved', name: 'View notes', description: improvedDescription,
      operations: args.candidateSnapshot[0].operations, related_entities: ['entity_note'],
      criticality_factors: ['catalog-candidate:notes-read'],
    });
    localOrch.aiExtractCapabilityCatalog = async () => [improved];
    localOrch.reconcileCatalogedCapabilities = (values: SystemCapability[]) => values;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(out.some(item => item.name === 'View notes' && item.criticality_factors.includes('catalog-candidate:notes-read'))).toBe(true);
    const ambiguousArgs = atomicGateArgs(new AnalyzerOrchestrator() as any);
    ambiguousArgs.candidateSnapshot[0] = {
      ...ambiguousArgs.candidateSnapshot[0], name: 'read record', structural_label: 'read record',
      operations: [{ entry_point_id: 'view-note', entry_point_type: 'internal', action: 'read' }],
      related_entities: ['entity_note', 'entity_job'],
    };
    ambiguousArgs.behaviorSurfaces = [ambiguousArgs.candidateSnapshot[0]];
    ambiguousArgs.dataEntities.push({ id: 'entity_job', name: 'Job', kind: 'persisted-entity', attributes: [] });
    ambiguousArgs.entryPoints = [];
    ambiguousArgs.hardDeadlineAt = Date.now() - 1;

    const ambiguousOrch = new AnalyzerOrchestrator() as any;
    expect(await ambiguousOrch.runCapabilityCatalogWithQualityGate(ambiguousArgs)).toEqual([]);
  });
  it('publishes an accepted cycle-one capability without staging it as an evidence repair', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const operation = [{
      entry_point_id: 'ep_status', entry_point_type: 'http', action: 'Track',
      path_or_command: '/status', trigger: { method: 'PATCH', path: '/status' },

    }] as any;
    const evidence = cap({
      id: 'capability_status', name: 'Track job status', structural_label: 'Track job status',
      category: 'core', evidence_kind: 'behavior-surface', evidence_role: 'product-outcome', operations: operation,
      related_entities: ['entity_job'],
    });
    const authored = cap({
      id: 'track-status', name: 'Track job status',
      description: 'Users track job status throughout the review process.',
      operations: operation, related_entities: ['entity_job'], criticality_factors: ['catalog-candidate:capability_status'],
    });
    const args: any = gateArgs(localOrch);
    args.candidateSnapshot = [evidence];
    args.projectTextSignal = {
      concepts: ['track job status'], evidence: [],
      summary: 'Users track job status throughout the review process.',
    };
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => { calls++; return [authored]; };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(calls).toBe(1);
    expect(out).toEqual([authored]);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage).toMatchObject({ status: 'accepted' });
  });

  it('does not fill a catalog quota after tool-shaped proposals are rejected', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const collapsed = ['View entry points', 'View functions', 'View dashboard'].map(name => cap({ id: name, name, description: `Surfaces the ${name.toLowerCase()} page for users of the product.` }));
    const rich = citeEveryGateFamily(['Analyze codebases', 'Serve agent context over MCP', 'Coordinate agent fleets', 'Detect deployables', 'Correlate runtime telemetry', 'Store analyses'].map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists in the product.`, operations: anchorOp(name) })));
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      return collapsed;
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));
    expect(out).toEqual([]);
    // An empty first answer with grounded product evidence earns exactly one
    // targeted repair (one batch per evidence family); junk from that repair is
    // never published and no further repair is solicited to fill the catalog.
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThanOrEqual(13);
    expect(calls[0].qualityNudge).toBeUndefined();
    void rich;
  });

  it('repairs paired audience and truth outcomes even when they share one evidence family', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const outcome = (name: string) => cap({
      id: name,
      name,
      description: `Grounded prose about ${name.toLowerCase()} and why the ability exists in the product.`,
      operations: anchorOp(name),
    });
    const args: any = gateArgs(localOrch);
    args.candidateSnapshot = [
      cap({ id: 'graph', name: 'Trustworthy relationship graph', structural_label: 'Trustworthy relationship graph', evidence_examples: ['CrossCodebaseSystemGraph', 'CASEdge'], operations: anchorOp('graph') }),
      cap({ id: 'understanding', name: 'Explore connected software behavior', structural_label: 'Software behavior exploration', evidence_examples: ['KlauroConfig'], operations: anchorOp('understanding') }),
      cap({ id: 'collaboration', name: 'Concurrent collaboration', structural_label: 'Real-time collaboration', operations: anchorOp('collaboration') }),
      cap({ id: 'runtime', name: 'Runtime evidence correlation', structural_label: 'Runtime evidence correlation', operations: anchorOp('runtime') }),
    ];
    args.projectTextSignal = {
      concepts: [], evidence: [],
      productDocSummary: 'Builds a trustworthy relationship graph, turns that graph into behavior comprehension for people and AI agents, enables real-time collaboration, and correlates static understanding with runtime evidence.',
    };
    const initial = [
      outcome('Track change history'),
      outcome('Coordinate real-time collaboration'),
      outcome('Correlate runtime evidence'),
    ];
    initial[0].criticality_factors = ['catalog-candidate:graph'];
    initial[1].criticality_factors = ['catalog-candidate:collaboration'];
    initial[2].criticality_factors = ['catalog-candidate:runtime'];
    initial[0].description = 'Change history shows people how connected software behavior evolves across analyzed revisions.';
    initial[1].description = 'Coordinate overlapping work warns collaborators about conflicting changes while they continue working in parallel.';
    initial[2].description = 'Runtime evidence reveals how observed software behavior compares with its analyzed structure.';
    const calls: any[] = [];
    const attemptsByRequirement = new Map<string, number>();
    let emptyGraphAttempts = 0;
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      if (calls.length === 1) return initial;
      if (input.candidateCapabilities[0]?.id === 'graph') {
        emptyGraphAttempts++;
        return emptyGraphAttempts === 1 ? [] : [cap({ ...outcome('Build a trustworthy relationship graph'), criticality_factors: ['catalog-candidate:graph'] })];
      }
      const requirement = input.requiredOutcomeRequirements?.[0];
      const attempts = (attemptsByRequirement.get(requirement.id) || 0) + 1;
      attemptsByRequirement.set(requirement.id, attempts);
      if (attempts === 1) {
        input.onRejection?.({
          candidateIds: ['understanding'], requirementId: requirement.id,
          name: requirement.audience === 'human' ? 'Surface behavior understanding' : 'Explain behavioral relationships to agents',
          reason: requirement.audience === 'human' ? 'required-outcome-audience-missing:human' : `required-outcome-subject-mismatch:${requirement.id}`,
          ...(requirement.audience === 'human' ? {
            missingAudience: requirement.audienceLabel, missingAudienceLocations: ['name'],
            oppositeAudienceLabels: ['agents'], oppositeAudienceLocations: ['description'],
          } : { missingSubjectTerms: requirement.requiredSubjectTerms }),
        });
        return [];
      }
      return [requirement.audience === 'human'
        ? cap({ ...outcome('Turn software behavior into comprehension for people'), description: 'Human engineers explore connected software behavior and change risks.', criticality_factors: ['catalog-candidate:understanding'] })
        : cap({
            ...outcome('Turn software behavior into comprehension for AI agents'),
            description: 'AI agents understand connected software behavior before making changes.',
            criticality_factors: ['catalog-candidate:understanding'],
          })];
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(out.map(capability => capability.name)).toEqual(expect.arrayContaining([
      'Build a trustworthy relationship graph',
      'Turn software behavior into comprehension for people',
      'Turn software behavior into comprehension for AI agents',
    ]));
    expect(calls.length).toBeGreaterThan(1);
    const understandingCalls = calls.filter(call => call.candidateCapabilities[0]?.id === 'understanding');
    expect(understandingCalls).toHaveLength(4);
    expect(understandingCalls.every(call => call.requiredOutcomeRequirements?.length === 1 && call.exactCapabilityLimit === 1)).toBe(true);
    expect([...new Set(understandingCalls.map(call => call.requiredOutcomeRequirements[0].audience))].sort()).toEqual(['agent', 'human']);
    expect(understandingCalls.every(call => call.qualityNudge.includes('required_audience_label') && call.qualityNudge.includes('required_subject_terms'))).toBe(true);
    expect(understandingCalls.every(call => call.requiredOutcomeRequirements[0].visibleActionTerms?.includes('turn'))).toBe(true);
    expect(understandingCalls.filter(call => call.requiredOutcomeRequirements[0].audience === 'human')[1].qualityNudge).toContain('missing_audience');
    expect(understandingCalls.filter(call => call.requiredOutcomeRequirements[0].audience === 'human')[1].qualityNudge).toContain('opposite_audience_labels');
    expect(understandingCalls.filter(call => call.requiredOutcomeRequirements[0].audience === 'agent')[1].qualityNudge).toContain('missing_subject_terms');
    for (const call of understandingCalls) {
      const [requirement] = call.requiredOutcomeRequirements;
      const promptText = call.targetedRepairFacts[0].first_party_outcomes[0];
      if (requirement.audience === 'human') { expect(promptText).toContain('people'); expect(promptText).not.toContain('agents'); }
      if (requirement.audience === 'agent') { expect(promptText).toContain('agents'); expect(promptText).not.toContain('people'); }
    }
    const targetedPromptFacts = JSON.stringify(calls.slice(1).flatMap(call => call.targetedRepairFacts || []));
    expect(targetedPromptFacts).toContain('candidate_1');
    expect(targetedPromptFacts).not.toContain('CrossCodebaseSystemGraph');
    expect(targetedPromptFacts).not.toContain('CASEdge');
    expect(targetedPromptFacts).not.toContain('KlauroConfig');
    expect(emptyGraphAttempts).toBe(1);
  });

  it('does not retry rejected ungrounded proposals merely to fill the catalog', async () => {
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
    const repaired = citeEveryGateFamily(['View industry reports', 'Browse products', 'Access user account', 'Generate invoices']
      .map(name => cap({
        id: name,
        name,
        description: `Lets users complete ${name.toLowerCase()} using the observed product information.`,
        operations: anchorOp(name),
      })));
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      return rejected;
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) =>
      extracted.filter(capability => capability.description && !capability.description.includes('seamless'));

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));

    expect(out).toEqual([]);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThanOrEqual(13);
    void repaired;
    expect(calls[0].qualityNudge).toBeUndefined();
  });

  it('does not accept grounded identities until their descriptions are publishable', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const extracted = citeEveryGateFamily([
      cap({ id: 'reports', name: 'View industry reports', description: 'Provides seamless insights into industry reports.', operations: anchorOp('reports') }),
      cap({ id: 'products', name: 'Browse products', description: '', operations: anchorOp('products') }),
      cap({ id: 'account', name: 'Access user account', description: 'Executes the main CLI entry point for account commands.', operations: anchorOp('account') }),
      cap({ id: 'company', name: 'View company information', description: 'View company information.', operations: anchorOp('company') }),
    ]);
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      return extracted;
    };

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.slice(1).every(input => input.exactCapabilityLimit === 1)).toBe(true);
    expect(new Set(calls.slice(1).map(input => input.repairMode))).toEqual(new Set(['description']));
    expect(out).toEqual([]);
  });

  it('repairs an otherwise complete catalog before accepting it', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const names = ['Analyze codebases', 'Serve agent context', 'Coordinate work', 'Detect deployables', 'Correlate runtime telemetry', 'Store analyses'];
    const initial = names.map((name, index) => cap({
      id: name, name, description: index === 0 ? '' : `Grounded prose about ${name.toLowerCase()} and why the product ability exists.`,
      operations: anchorOp(name), criticality_factors: [
        `catalog-candidate:cand_${index}`,
        `catalog-candidate:cand_${index + 6}`,
      ],
    }));
    const repaired = cap({
      ...initial[0], description: 'Grounded prose about analyze codebases and why the product ability exists.',
      description_generation: { status: 'ai_applied', attempted: true }, description_source: 'ai',
    });
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => { calls.push(input); return calls.length === 1 ? initial : [repaired]; };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const args: any = gateArgs(localOrch);
    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(calls).toHaveLength(2);
    expect(calls.slice(1).every(input => input.exactCapabilityLimit === 1)).toBe(true);
    expect(calls.filter(input => input.repairMode === 'description')).toHaveLength(1);
    expect(calls[1].qualityNudge).toContain('stable accepted identity');
    expect(calls[1].qualityNudge).toContain(initial[0].name);
    expect(out).toHaveLength(6);
    expect(out.find(capability => capability.name === repaired.name)?.description).toBe(repaired.description);
    localOrch.finalizeSystemCapabilityNames(out, [], args.enhancedSystemPurpose);
    expect(args.enhancedSystemPurpose.capability_naming_coverage.un_enriched).toBe(0);
  });

  it('accepts an empty catalog after tool-shaped proposals provide no grounded authored outcome', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const collapsed = ['View entry points', 'View functions'].map(name => cap({ id: name, name, description: `Surfaces the ${name.toLowerCase()} page for users of the product.` }));
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => { calls++; return collapsed; };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const args: any = gateArgs(localOrch);
    const out = await localOrch.runCapabilityCatalogWithQualityGate(args);
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(13);
    expect(out).toEqual([]);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage.status).toBe('accepted');
    expect(args.enhancedSystemPurpose.capability_catalog_coverage.reason).toBeUndefined();
  });

  it('passes a good first catalog through with a single call', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const rich = citeEveryGateFamily(['Analyze codebases', 'Serve agent context over MCP', 'Coordinate agent fleets', 'Detect deployables', 'Correlate runtime telemetry', 'Store analyses'].map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists in the product.`, operations: anchorOp(name) })));
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => { calls++; return rich; };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));
    expect(calls).toBe(1);
    expect(out).toHaveLength(6);
  });

  it('builds the initial catalog from the complete evidence set before isolating missing-family repairs', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args: any = gateArgs(localOrch);
    args.projectTextSignal = { concepts: ['software understanding', 'collaborative work'], evidence: [] };
    args.behaviorSurfaces = [
      {
        id: 'workspace', name: 'Workspace Tool Surface', category: 'internal', evidence_kind: 'behavior-surface',
        evidence_examples: ['get_agent_context', 'get_product_map'],
        criticality_factors: ["2 message entry points form one cohesive behavior family ('workspace')"],
        operations: anchorOp('workspace'), related_entities: [], related_domains: ['workspace'],
      },
      {
        id: 'fabric', name: 'Fabric Tool Surface', category: 'internal', evidence_kind: 'behavior-surface',
        evidence_examples: ['claim_work', 'check_collision', 'release_work'],
        criticality_factors: ["3 message entry points form one cohesive behavior family ('fabric')"],
        operations: anchorOp('fabric'), related_entities: [], related_domains: ['collaboration'],
      },
    ];
    const complete = ['Understand software behavior', 'Coordinate collaborative work', 'Assess change risk', 'Correlate runtime signals']
      .map((name, index) => cap({
        id: name,
        name,
        description: `Grounded product outcome for ${name.toLowerCase()} across connected software systems.`,
        operations: anchorOp(name),
        criticality_factors: index === 0
          ? ['catalog-candidate:workspace']
          : index === 1
            ? ['catalog-candidate:fabric']
            : [],
      }));
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      return complete;
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(out).toEqual(complete);
    expect(calls).toHaveLength(1);
    expect(calls[0].exactCapabilityLimit).toBeUndefined();
    expect(calls[0].qualityNudge).toBeUndefined();
    expect(calls[0].behaviorSurfaces.map((surface: SystemCapability) => surface.id)).toEqual(['workspace', 'fabric']);
    expect(calls[0].candidateCapabilities.length).toBeGreaterThan(1);
  });

  it('does not force a first-party delivery namespace into an otherwise complete product catalog', async () => {
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
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      return rich;
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);
    expect(calls).toHaveLength(1);
    expect(out).toEqual(rich);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage.candidate_dispositions).toEqual(
      expect.arrayContaining([expect.objectContaining({ candidate_id: 'fabric', role: 'supporting-mechanism' })]),
    );
  });

  it('does not require an internal supporting history entity as a product family', async () => {
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
    const accepted = citeEveryGateFamily(['Analyze codebases', 'Coordinate agent work', 'Correlate runtime signals', 'Review change impact']
      .map(name => cap({ id: name, name, description: `Grounded product outcome for ${name.toLowerCase()} across connected software.`, operations: anchorOp(name) })));
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      return accepted;
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(calls).toHaveLength(1);
    expect(out).toEqual(accepted);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage.candidate_dispositions).toEqual(
      expect.arrayContaining([expect.objectContaining({ candidate_id: 'cap_history', role: 'unresolved' })]),
    );
    expect(args.enhancedSystemPurpose.capability_catalog_coverage.evidence_families).toBe(12);
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

    expect(calls).toHaveLength(2);
    expect(out).toHaveLength(6);
    expect(out.find(capability => capability.name === rejectedWorkspace.name)?.description).toBe(retained[0].description);
    expect(calls[1]).toMatchObject({ repairMode: 'description', repairIdentityName: rejectedWorkspace.name });
  });

  it('carries operational guarantee phrases into the next description repair fact', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args: any = gateArgs(localOrch);
    args.projectTextSignal = { concepts: ['overlapping work', 'collaboration'], evidence: [] };
    const coordinationEvidence = {
      id: 'coordination', name: 'Coordinate overlapping work', category: 'internal', evidence_kind: 'behavior-surface', evidence_role: 'product-outcome',
      evidence_examples: ['surface overlapping changes'],
      criticality_factors: ["1 message entry point forms one cohesive behavior family ('coordination')"],
      operations: [{ entry_point_id: 'observe', entry_point_type: 'message', action: 'Process' }],
      related_entities: [], related_domains: [],
    };
    const safeCoordinationEvidence = { ...coordinationEvidence, id: 'coordination-safe' };
    args.behaviorSurfaces = [coordinationEvidence, safeCoordinationEvidence];
    args.candidateSnapshot.push(coordinationEvidence, safeCoordinationEvidence);
    const retained = ['Analyze codebases', 'Serve agent context', 'Correlate runtime signals', 'Assess change risk', 'Explain system behavior']
      .map(name => cap({ id: name, name, description: `Grounded product outcome for ${name.toLowerCase()} across connected software.`, operations: anchorOp(name) }));
    const rejected = cap({
      id: 'coordination', name: 'Coordinate overlapping work',
      description: 'Surfaces synchronized changes across overlapping work while ensuring participants remain aligned.',
      operations: [{ entry_point_id: 'observe', entry_point_type: 'message', action: 'Process' }],
      criticality_factors: ['catalog-candidate:coordination'],
    });
    const repaired = { ...rejected, description: 'Surfaces overlapping changes so participants can coordinate their work.' };
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      return calls.length === 1 ? [...retained, rejected] : [repaired];
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(out.length).toBeGreaterThan(0);
    const repairCall = calls.find(call => call.repairIdentityName === rejected.name);
    const prior = repairCall.targetedRepairFacts[0].prior_rejections;
    expect(prior).toEqual(expect.arrayContaining([expect.objectContaining({
      forbidden_subject_terms: expect.arrayContaining(['synchronized changes', 'ensuring participants remain aligned']),
    })]));
    expect(repairCall.targetedRepairFacts[0].candidate_id).toBe('candidate_1');
    expect(repairCall.targetedRepairCandidateMap).toEqual({ candidate_1: 'coordination' });
  });

  it('preserves distinct accepted outcomes when the global catalog attaches supporting delivery evidence', async () => {
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
    localOrch.aiExtractCapabilityCatalog = async () => {
      calls++;
      return [repaired, ...retained.slice(1)];
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(calls).toBe(1);
    expect(out.map(capability => capability.name)).toEqual(retained.map(capability => capability.name));
    expect(out[0].criticality_factors).toContain('catalog-candidate:workspace');
  });

  it('does not publish or repair structural evidence without a grounded authored outcome', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args: any = gateArgs(localOrch);
    const operations = [
      { entry_point_id: 'category-create', entry_point_type: 'http', action: 'Create', trigger: { method: 'POST', path: '/categories' } },
      { entry_point_id: 'category-list', entry_point_type: 'http', action: 'List', trigger: { method: 'GET', path: '/categories' } },
      { entry_point_id: 'category-update', entry_point_type: 'http', action: 'Update', trigger: { method: 'PATCH', path: '/categories/:id' } },
      { entry_point_id: 'category-delete', entry_point_type: 'http', action: 'Delete', trigger: { method: 'DELETE', path: '/categories/:id' } },
    ] as any;
    const evidence = cap({
      id: 'cap_categories', name: 'Spending categories', structural_label: 'Spending category',
      category: 'core', evidence_role: 'product-outcome',
      operations, related_entities: ['entity_category'], related_domains: ['categories'],
    });
    args.candidateSnapshot = [evidence];
    args.behaviorSurfaces = [];
    args.dataEntities = [{ id: 'entity_category', name: 'Category', kind: 'persisted-entity', attributes: [] }];
    args.projectTextSignal = { concepts: ['spending categories', 'budgets'], evidence: [], summary: 'Users organize spending with categories and budgets.' };
    args.userJourneys = [{ name: 'Organize spending categories' }];
    const repaired = cap({
      id: 'organize-categories', name: 'Organize spending categories',
      description: 'Users organize spending categories while retaining the ability to add, review, revise, and remove categories.',
      operations, related_entities: ['entity_category'], related_domains: ['categories'],
      criticality_factors: ['catalog-candidate:cap_categories'],
    });
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      if (calls.length === 1) {
        input.onRejection?.({
          candidateIds: ['cap_categories'],
          name: 'Create and manage spending categories',
          reason: 'crud-inventory-label',
        });
        return [];
      }
      return calls.length === 2 ? [] : [repaired];
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(calls).toHaveLength(2);
    expect(calls.every(call => call.repairMode === undefined)).toBe(true);
    expect(out).toEqual([]);
  });

  it('accepts scope-relative management wording when first-party intent and structural evidence both require it', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args: any = gateArgs(localOrch);
    const operations = [
      { entry_point_id: 'update-application-status', entry_point_type: 'http', action: 'Update', trigger: { method: 'PATCH', path: '/applications/:id/status' } },
    ] as any;
    args.candidateSnapshot = [cap({
      id: 'cap_status', name: 'Application status', structural_label: 'application status',
      category: 'core', evidence_role: 'product-outcome', operations,
      related_entities: ['entity_application'], related_domains: ['applications'],
    })];
    args.behaviorSurfaces = [];
    args.dataEntities = [{ id: 'entity_application', name: 'Application', kind: 'persisted-entity', attributes: [] }];
    args.projectTextSignal = {
      concepts: ['application status'], evidence: [],
      summary: 'Users manage application status and can change it to rejected, assessment, interview, or closed.',
      productDocSummary: 'Users manage application status and can change it to rejected, assessment, interview, or closed.',
    };
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      const requirement = input.requiredOutcomeRequirements?.[0];
      expect(requirement?.candidateIds).toContain('cap_status');
      return [cap({
      id: 'manage-application-status',
      name: 'Manage application status',
      description: 'Users manage application status and move applications through rejected, assessment, interview, or closed states.',
      operations,
      related_entities: ['entity_application'],
      related_domains: ['applications'],
      criticality_factors: ['catalog-candidate:cap_status', `catalog-outcome-requirement:${requirement.id}`],
      })];
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(out.map(capability => capability.name)).toEqual(['Manage application status']);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage.status).toBe('accepted');
  });

  it('accepts an independently grounded outcome without turning a rejected proposal into a targeted repair', async () => {
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
      id: 'analyze-codebase', name: 'Analyze codebases', description: 'Grounded product outcome for analyze codebases across connected software.',
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
      return [repaired, ...retained];
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out: SystemCapability[] = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(calls).toHaveLength(2);
    expect(calls.every(call => call.repairIdentityName === undefined)).toBe(true);
    expect(out.map(capability => capability.name)).toEqual([...retained.map(capability => capability.name), repaired.name]);
  });

  it('does not publish a rejected description identity when its evidence family is already covered', async () => {
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

    expect(calls).toHaveLength(2);
    expect(out.map(capability => capability.name)).toEqual(accepted.map(capability => capability.name));
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
    const grounded = citeEveryGateFamily(['Analyze codebases', 'Serve agent context', 'Coordinate agent work', 'Correlate runtime signals', 'Review change impact', 'Understand system behavior']
      .map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists.`, operations: anchorOp(name) })));
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
    const grounded = citeEveryGateFamily(['Analyze codebases', 'Serve agent context', 'Coordinate agent work', 'Correlate runtime signals', 'Review change impact', 'Understand system behavior']
      .map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists.`, operations: anchorOp(name) })));
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => { calls++; return grounded; };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(calls).toBe(1);
    expect(out).toEqual(grounded);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage.status).toBe('accepted');
  });

  it('does not degrade a grounded catalog because an optional delivery surface is uncited', async () => {
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
    expect(calls).toBe(1);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage).toMatchObject({ status: 'accepted' });
    expect(args.enhancedSystemPurpose.capability_catalog_coverage.reason).toBeUndefined();
  });

  it('returns no canonical capabilities after all authored catalog cycles fail', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => { calls++; return []; };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(13);
    expect(out).toHaveLength(0);
  });

  it('publishes every grounded outcome without imposing a catalog-size quota', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const grounded = ['Analyze codebases', 'Coordinate agent work', 'Correlate runtime signals'].map(name => cap({
      id: name, name, description: `Grounded product outcome for ${name.toLowerCase()} across connected software.`, operations: anchorOp(name),
    }));
    localOrch.aiExtractCapabilityCatalog = async () => grounded;
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;
    const args: any = gateArgs(localOrch);
    args.candidateSnapshot = [];
    args.behaviorSurfaces = [];

    const out = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(out).toEqual(grounded);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage).toMatchObject({
      status: 'accepted',
      published_capabilities: 3,
      actual_publishable_capabilities: 3,
    });
    expect(args.enhancedSystemPurpose.capability_catalog_coverage.reason).toBeUndefined();
  });

  it('publishes grounded outcomes while retaining a missing first-party outcome as an intent gap', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const args: any = gateArgs(localOrch);
    args.projectTextSignal = {
      productDocSummary: 'The product builds a trustworthy relationship graph, turns that graph into behavior-level comprehension for people and AI agents, enables real-time collaboration, and correlates static understanding with runtime evidence.',
      evidence: [],
    };
    args.candidateSnapshot = [
      cap({ id: 'graph', name: 'Relationship graph analysis', category: 'core', evidence_examples: ['query_graph_relationships'], operations: anchorOp('query graph relationships') }),
      cap({ id: 'understanding', name: 'Explore connected software behavior', category: 'core', evidence_examples: ['inspect_behavior', 'explain_change_risk'], operations: anchorOp('inspect behavior') }),
      cap({ id: 'collaboration', name: 'Coordinate real-time collaboration', category: 'core', evidence_examples: ['coordinate_overlapping_work'], operations: anchorOp('coordinate overlapping work') }),
      cap({ id: 'runtime', name: 'Runtime evidence correlation', category: 'core', evidence_examples: ['correlate_runtime_evidence'], operations: anchorOp('correlate runtime evidence') }),
    ];
    const requirements = deriveCapabilityCatalogOutcomeRequirements(args.projectTextSignal, args.candidateSnapshot);
    const factor = (candidateId: string) => [`catalog-candidate:${candidateId}`];
    const incomplete = [
      cap({ id: 'published-graph', name: 'Build a trustworthy relationship graph', description: 'A trustworthy relationship graph connects software structure and behavior.', operations: anchorOp('graph'), criticality_factors: factor('graph') }),
      cap({ id: 'published-agent', name: 'Give AI agents software comprehension', description: 'AI agents understand connected software behavior before changing code.', operations: anchorOp('agent'), criticality_factors: factor('understanding') }),
      cap({ id: 'published-collaboration', name: 'Coordinate concurrent work', description: 'Collaborators coordinate overlapping changes in real time.', operations: anchorOp('collaboration'), criticality_factors: factor('collaboration') }),
      cap({ id: 'published-runtime', name: 'Correlate runtime evidence', description: 'Runtime telemetry is correlated with static software understanding.', operations: anchorOp('runtime'), criticality_factors: factor('runtime') }),
      cap({ id: 'published-impact', name: 'Review change impact', description: 'Engineers review the impact of connected changes before proceeding.', operations: anchorOp('impact') }),
    ];
    const complete = [...incomplete.slice(0, 4), cap({
      id: 'published-human',
      name: 'Help people understand software behavior',
      description: 'Human engineers understand connected software behavior before changing code.',
      operations: anchorOp('human'),
      criticality_factors: factor('understanding'),
    })];
    expect(requirements).toHaveLength(5);
    complete.forEach((_: SystemCapability, index: number) => expect(capabilityCatalogOutcomeCoverageFailure(
      complete.filter((__: SystemCapability, candidateIndex: number) => candidateIndex !== index), requirements,
    )).toContain('first-party product outcome'));
    localOrch.aiExtractCapabilityCatalog = async () => incomplete;
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(args);

    expect(out).toEqual([]);
    expect(args.enhancedSystemPurpose.capability_catalog_coverage).toMatchObject({
      actual_publishable_capabilities: 6,
      published_capabilities: 0,
      status: 'rejected',
    });
    expect(args.enhancedSystemPurpose.capability_catalog_coverage.reason).toContain('first-party product outcome');
    expect(args.enhancedSystemPurpose.capability_reconciliation.proposals).toEqual(
      expect.arrayContaining([expect.objectContaining({ disposition: 'intent-gap' })]),
    );
  });

  it('does not replace rejected bare abstractions merely to fill a catalog', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const rejected = Array.from({ length: 8 }, (_, index) => cap({
      id: `rejected_${index}`,
      name: `Area ${index}`,
      description: 'Grounded prose describing a real ability of the product.',
      operations: anchorOp(`rejected_${index}`),
    }));
    const accepted = citeEveryGateFamily(['Analyze codebases', 'Serve agent context', 'Coordinate agent work', 'Correlate runtime signals', 'Review change impact', 'Understand system behavior']
      .map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists.`, operations: anchorOp(name) })));
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => { calls++; return rejected; };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));
    expect(out).toEqual([]);
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(13);
    void accepted;
  });

  it('refuses an unanchored item without discarding the grounded catalog', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const withFabrication = citeEveryGateFamily([
      ...['Analyze codebases', 'Serve agent context over MCP', 'Coordinate agent fleets', 'Detect deployables', 'Correlate runtime telemetry']
        .map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists in the product.`, operations: anchorOp(name) })),
      cap({ id: 'fab', name: 'Manages fleet operations', description: 'Manages fleet operations end to end for dispatch teams.' }),
    ]);
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
    const grounded = citeEveryGateFamily(['Manage access requests', 'Register network agents', 'Review activity logs', 'Configure resource policies', 'Control inline gateways']
      .map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists.`, operations: anchorOp(name) })));
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
    expect(out).toEqual(grounded.slice(1));
  });
});
