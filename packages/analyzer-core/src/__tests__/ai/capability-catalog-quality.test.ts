import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import type { SystemCapability } from '../../types/cas.types';

// Private-method tests (same convention as orchestrator-internals.test.ts):
// the guards are internal by design, reached via a typed `any` handle.
const orch = new AnalyzerOrchestrator() as any;

const cap = (over: Partial<SystemCapability> & Record<string, unknown>): SystemCapability => ({
  id: 'c', name: 'Cap', description: 'Grounded prose describing a real ability of the product.',
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

describe('finalizeSystemCapabilityNames placeholder-description sweep', () => {
  it('rebuilds a template description from operation evidence and tags the repair', () => {
    const caps = [cap({
      name: 'Manage Analyses',
      description: 'Analyses: query operation via message',
      operations: [{ entry_point_id: 'ep1', entry_point_type: 'message', action: 'list_analyses' }] as any,
    })];
    orch.finalizeSystemCapabilityNames(caps);
    expect(caps[0].description).not.toContain('operation via');
    expect(caps[0].description).toContain('List Analyses');
    expect(caps[0].criticality_factors).toContain('placeholder-description-rebuilt');
  });

  it('never touches an AI-authored description', () => {
    const caps = [cap({
      name: 'Manage Analyses',
      description: 'Analyses: query operation via message',
      description_source: 'ai',
      operations: [{ entry_point_id: 'ep1', entry_point_type: 'message', action: 'list_analyses' }] as any,
    })];
    orch.finalizeSystemCapabilityNames(caps);
    expect(caps[0].description).toBe('Analyses: query operation via message');
  });
});

describe('finalizeFlowGraphCapabilities (flow_graph bare-noun/placeholder sweep)', () => {
  it('repairs a bare-noun name from its verb-headed operation label and rebuilds the template description', () => {
    const flowGraph: any = {
      capabilities: [{
        id: 'capability_hot', name: 'Hot',
        description: 'Hot: query operation via message',
        entry_points: ['ep1'],
        operations: [{ id: 'op_1', name: 'get_hot_spots', pattern: 'query', trigger: { type: 'message' } }],
      }],
    };
    orch.finalizeFlowGraphCapabilities(flowGraph);
    expect(flowGraph.capabilities[0].name).toBe('Get Hot Spots');
    expect(flowGraph.capabilities[0].description).not.toContain('operation via');
    expect(flowGraph.capabilities[0].description).toContain('Get Hot Spots');
  });

  it('falls back to Manage <subject> when no operation label is verb-headed but evidence anchors the group', () => {
    const flowGraph: any = {
      capabilities: [{
        id: 'capability_adrs', name: 'Adrs',
        description: 'Adrs: query operation via message',
        entry_points: ['ep1'],
        operations: [{ id: 'op_1', name: 'adrs', pattern: 'query', trigger: { type: 'message' } }],
      }],
    };
    orch.finalizeFlowGraphCapabilities(flowGraph);
    expect(flowGraph.capabilities[0].name).toBe('Manage Adrs');
  });

  it('leaves purposeful names and authored descriptions alone, and never drops entries', () => {
    const flowGraph: any = {
      capabilities: [{
        id: 'capability_x', name: 'Analyze Codebases',
        description: 'Runs the full analysis pipeline over any repository.',
        entry_points: [], operations: [],
      }],
    };
    orch.finalizeFlowGraphCapabilities(flowGraph);
    expect(flowGraph.capabilities).toHaveLength(1);
    expect(flowGraph.capabilities[0].name).toBe('Analyze Codebases');
    expect(flowGraph.capabilities[0].description).toBe('Runs the full analysis pipeline over any repository.');
  });

  it('tolerates an absent flow graph', () => {
    expect(() => orch.finalizeFlowGraphCapabilities(undefined)).not.toThrow();
  });
});

describe('catalogQualityFailure (post-reconcile gate, defect #33)', () => {
  const purposeful = (name: string) => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists in the product.` });

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
    const bare = [purposeful('Analyze codebases'), purposeful('Serve agent context'), purposeful('Coordinate fleets'), cap({ id: 'g', name: 'Gateway' })];
    expect(orch.catalogQualityFailure(bare, 8)).toContain('bare-noun');
    const placeholder = [purposeful('Analyze codebases'), purposeful('Serve agent context'), purposeful('Coordinate fleets'), cap({ id: 'p', name: 'Manage Hot Spots', description: 'Hot: query operation via message' })];
    expect(orch.catalogQualityFailure(placeholder, 8)).toContain('template');
  });

  it('accepts a rich purposeful catalog', () => {
    const six = ['Analyze codebases', 'Serve agent context over MCP', 'Coordinate agent fleets', 'Detect deployables', 'Correlate runtime telemetry', 'Store analyses'].map(purposeful);
    expect(orch.catalogQualityFailure(six, 20)).toBeUndefined();
  });
});

describe('runCapabilityCatalogWithQualityGate (retry-before-degrade, defect #33)', () => {
  const gateArgs = (localOrch: any) => ({
    systemName: 'sys',
    enhancedSystemPurpose: { primary_domain: 'analysis', core_concepts: [] },
    frameworks: [],
    userJourneys: [],
    dataEntities: [],
    candidateSnapshot: Array.from({ length: 12 }, (_, i) => cap({ id: `cand_${i}`, name: `Area ${i} Management` })),
    behaviorSurfaces: [],
    externalServices: [],
    flowGraph: { capabilities: [] },
    projectTextSignal: { concepts: [], evidence: [] },
    entryPoints: [],
    nodes: [],
    budgetMs: 1000,
  });

  it('retries a collapsed catalog with a quality nudge and keeps the passing retry result', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const collapsed = ['View entry points', 'View functions', 'View dashboard'].map(name => cap({ id: name, name, description: `Surfaces the ${name.toLowerCase()} page for users of the product.` }));
    const rich = ['Analyze codebases', 'Serve agent context over MCP', 'Coordinate agent fleets', 'Detect deployables', 'Correlate runtime telemetry', 'Store analyses'].map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists in the product.` }));
    const calls: any[] = [];
    localOrch.aiExtractCapabilityCatalog = async (input: any) => {
      calls.push(input);
      return calls.length === 1 ? collapsed : rich;
    };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));
    expect(out).toHaveLength(6);
    expect(calls).toHaveLength(2);
    expect(calls[0].qualityNudge).toBeUndefined();
    expect(calls[1].qualityNudge).toContain('quality check');
  });

  it('stops after 3 cycles and returns the best result for the caller to judge', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const collapsed = ['View entry points', 'View functions'].map(name => cap({ id: name, name, description: `Surfaces the ${name.toLowerCase()} page for users of the product.` }));
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => { calls++; return collapsed; };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));
    expect(calls).toBe(3);
    expect(out).toHaveLength(2);
  });

  it('passes a good first catalog through with a single call', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    const rich = ['Analyze codebases', 'Serve agent context over MCP', 'Coordinate agent fleets', 'Detect deployables', 'Correlate runtime telemetry', 'Store analyses'].map(name => cap({ id: name, name, description: `Grounded prose about ${name} and why the ability exists in the product.` }));
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => { calls++; return rich; };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));
    expect(calls).toBe(1);
    expect(out).toHaveLength(6);
  });

  it('returns [] after all cycles fail so the caller degrades to the deterministic fallback', async () => {
    const localOrch = new AnalyzerOrchestrator() as any;
    let calls = 0;
    localOrch.aiExtractCapabilityCatalog = async () => { calls++; return []; };
    localOrch.reconcileCatalogedCapabilities = (extracted: SystemCapability[]) => extracted;

    const out = await localOrch.runCapabilityCatalogWithQualityGate(gateArgs(localOrch));
    expect(calls).toBe(3);
    expect(out).toHaveLength(0);
  });
});
