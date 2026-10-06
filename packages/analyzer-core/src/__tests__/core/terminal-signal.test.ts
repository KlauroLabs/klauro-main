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
