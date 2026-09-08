test('catalog stabilization cannot discard newly authored outcomes merely because they share evidence', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const previous = {
    ...capability('review', 'Review enterprise orders', 'shared'),
    description: 'Review enterprise orders presents EnterpriseOrder details for operator review.',
  };
  const refreshed = [
    { ...previous },
    { ...previous, id: 'compare', name: 'Compare enterprise orders',
      description: 'Compare enterprise orders identifies differences between EnterpriseOrder records.' },
  ];
  const stabilized = orchestrator.stabilizeRefreshedCapabilityCatalog([previous], candidates(previous.operations), refreshed);
  assert.deepEqual(stabilized.map((item: SystemCapability) => item.id), ['review', 'compare']);
});
import { attachFlowContract } from './entry-point-enrichment';

test('incremental reuse compares flow-enriched contracts at the same stage without discarding input or output evidence', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const previous = capability('old', 'Understand the behavior implemented by a system', 'inspect');
  const entry = { id: 'inspect', type: 'api', name: 'inspect', source_node: 'handler', trigger: { method: 'GET', path: '/inspect' } };
  const flow = { flow_id: 'inspect-flow', entry_point: 'inspect', contract: { input: ['repo: string'], output: ['Report'] } };
  const enriched = attachFlowContract([entry], [flow]);
  assert.notDeepEqual(enriched, [entry]);
  const before = structuredClone({ previous, entry, flow, enriched });
  const reused = orchestrator.reusePreviousCapabilityCatalog([previous], [], {
    previousEntryPoints: enriched, currentEntryPoints: [entry], currentFlows: [flow],
  });
  orchestrator.finalizeSystemCapabilityNames(reused);
  assert.equal(reused.length, 1);
  assert.deepEqual(reused[0].operations, previous.operations);
  assert.deepEqual({ previous, entry, flow, enriched }, before);
  for (const contract of [
    { input: ['repo: number'], output: ['Report'] },
    { input: ['repo: string'], output: ['Secret'] },
  ]) {
    assert.deepEqual(orchestrator.reusePreviousCapabilityCatalog([previous], [], {
      previousEntryPoints: enriched, currentEntryPoints: [entry], currentFlows: [{ ...flow, contract }],
    }), []);
  }
});

test('unchanged canonical entry contracts retain authored outcomes absent from candidate projections', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const previous = capability('old', 'Understand the behavior implemented by a system', 'inspect');
  const entry = { id: 'inspect', type: 'api', source_node: 'handler', trigger: { method: 'GET', path: '/inspect' } };
  const reused = orchestrator.reusePreviousCapabilityCatalog([previous], [], {
    previousEntryPoints: [{ ...entry, capabilities: [{ capability_id: 'old' }] }],
    currentEntryPoints: [{ ...entry, capabilities: [] }],
  });
  orchestrator.finalizeSystemCapabilityNames(reused);
  assert.equal(reused.length, 1);
  assert.deepEqual(reused[0].operations, previous.operations);
});

test('canonical entry removal or contract changes cannot be hidden by a stale candidate projection', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const previous = capability('old', 'Understand the behavior implemented by a system', 'inspect');
  const entry = { id: 'inspect', type: 'api', source_node: 'handler', trigger: { method: 'GET', path: '/inspect' } };
  for (const currentEntryPoints of [[], [{ ...entry, trigger: { method: 'DELETE', path: '/inspect' } }], [{ ...entry, source_node: 'other-handler' }]]) {
    assert.deepEqual(orchestrator.reusePreviousCapabilityCatalog([previous], candidates(previous.operations), {
      previousEntryPoints: [entry], currentEntryPoints,
    }), []);
  }
});

test('finalization still merges exact duplicate authored outcome names', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const previous = [capability('one', 'Understand the behavior implemented by a system', 'inspect'),
    capability('two', 'Understand the behavior implemented by a system', 'inspect')];
  const reused = orchestrator.reusePreviousCapabilityCatalog(previous, candidates(previous[0].operations));
  orchestrator.finalizeSystemCapabilityNames(reused);
  assert.equal(reused.length, 1);
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalyzerOrchestrator } from './orchestrator';
import type { SystemCapability } from '../../types/cas.types';

function capability(id: string, name: string, operationId: string): SystemCapability {
  return {
    id, name, name_source: 'ai', category: 'core', criticality: 'high',
    description: 'People inspect the supported behavior and evidence associated with this outcome.',
    description_source: 'ai', description_generation: { status: 'ai_applied', attempted: true },
    related_entities: ['codebase'], related_domains: ['software'],
    operations: [{ entry_point_id: operationId, entry_point_type: 'api', action: 'Inspect' }],
    criticality_factors: ['catalog-candidate:shared-surface'],
  };
}

function candidates(operations: SystemCapability['operations']): SystemCapability[] {
  return [{ ...capability('shared-surface', 'Structural surface', ''), name_source: undefined,
    description: '', description_source: undefined, operations }];
}

test('unchanged semantic inputs preserve five authored outcomes sharing one evidence family', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const names = [
    'Understand what a codebase actually built',
    'Onboard to an unfamiliar system without reading every file',
    'Know what will break before changing something',
    'Verify generated code beyond the demonstration path',
    'Coordinate work without duplicating or colliding with other agents',
  ];
  const previous = names.map((name, index) => capability('outcome-' + index, name, 'entry-' + index));
  const current = candidates(previous.flatMap(item => item.operations));
  const before = structuredClone({ previous, current });
  const facts = orchestrator.buildAIInterpretationRefreshFingerprint('software', [], [{ type: 'api', count: 5 }], [], [], [], current);
  const oldOutput = { capabilities: previous, enhanced_system_purpose: {
    inferred_description: 'This software lets people inspect codebases and coordinate changes through their supported behavior.',
    ai_input_fingerprint: orchestrator.hashAIInterpretationRefreshFingerprint(facts),
  } };
  assert.deepEqual(orchestrator.getAIInterpretationRefreshDecision(oldOutput, 'software', [], [{ type: 'api', count: 5 }], [], [], [], current),
    { refresh: false, reason: 'semantic-fingerprint-unchanged' });
  const reused = orchestrator.reusePreviousCapabilityCatalog(previous, current);
  orchestrator.finalizeSystemCapabilityNames(reused);
  assert.deepEqual(reused.map((item: SystemCapability) => item.name), names);
  for (let index = 0; index < previous.length; index++) {
    assert.deepEqual(reused[index].operations, previous[index].operations);
    assert.equal(reused[index].name_source, previous[index].name_source);
  }
  assert.deepEqual({ previous, current }, before);
});

test('independent outcomes can share the same supported operation without consuming each other', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const previous = [
    capability('understand', 'Understand the behavior implemented by a system', 'inspect'),
    capability('review', 'Review the effects of a proposed change', 'inspect'),
  ];
  const reused = orchestrator.reusePreviousCapabilityCatalog(previous, candidates(previous[0].operations));
  orchestrator.finalizeSystemCapabilityNames(reused);
  assert.deepEqual(reused.map((item: SystemCapability) => item.id), ['understand', 'review']);
});

test('all accepted name origins survive reuse, including deterministic and manually authored outcomes', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  for (const origin of ['ai', 'manual', 'deterministic', 'reused'] as const) {
    const previous = capability(origin, 'Understand the behavior implemented by a system', 'inspect');
    previous.name_source = origin;
    previous.description_source = origin;
    previous.name_generation = { status: 'reused_previous', attempted: false, origin_source: 'manual' };
    const reused = orchestrator.reusePreviousCapabilityCatalog([previous], candidates(previous.operations));
    orchestrator.finalizeSystemCapabilityNames(reused);
    assert.equal(reused.length, 1, origin);
    assert.equal(reused[0].name_source, origin);
    assert.deepEqual(reused[0].name_generation, previous.name_generation);
  }
});

test('an authored current candidate cannot launder an unauthored previous name', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const previous = capability('old', 'Understand the behavior implemented by a system', 'inspect');
  previous.name_source = undefined;
  const current = candidates(previous.operations);
  current[0].name_source = 'ai';
  const reused = orchestrator.reusePreviousCapabilityCatalog([previous], current);
  orchestrator.finalizeSystemCapabilityNames(reused);
  assert.deepEqual(reused, []);
});

test('an outcome loses reuse eligibility when its operation disappears despite a surviving shared entity', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const previous = capability('old', 'Understand the behavior implemented by a system', 'inspect');
  const current = candidates([{ entry_point_id: 'delete', entry_point_type: 'api', action: 'Delete' }]);
  assert.deepEqual(orchestrator.reusePreviousCapabilityCatalog([previous], current), []);
});

test('reused operation identities must still represent the same behavior', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const previous = capability('old', 'Understand the behavior implemented by a system', 'inspect');
  const current = candidates([{ ...previous.operations[0], action: 'Delete' }]);
  assert.deepEqual(orchestrator.reusePreviousCapabilityCatalog([previous], current), []);
});
