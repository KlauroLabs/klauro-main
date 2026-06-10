import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOperationalPriorities, type RuntimeObservation } from './product';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

test('buildOperationalPriorities ranks runtime errors with static CAS risk context', () => {
  const cas = {
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-test',
    system: { id: 'system', name: 'System', type: 'service', root_path: '/tmp/system' },
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { level_definitions: [] },
    system_health: {
      score: 72,
      status: 'watch',
      summary: 'risk',
      risk_areas: [{
        id: 'complexity-hotspots',
        type: 'complexity',
        severity: 'high',
        title: 'Complexity hotspots need targeted tests before changes',
        description: 'complex',
        affected_nodes: ['node-task-service'],
        evidence: ['TaskService: cyclomatic 42'],
        recommendation: 'Refactor behind tests.',
        agent_guidance: 'Call assess_change_risk and find_tests first.',
      }],
      coherence: {
        status: 'mixed',
        paradigm_count: 2,
        primary_paradigms: ['Service Layer'],
        conflicting_paradigms: [],
        naming_convention_violations: 0,
        dependency_injection_violations: 0,
        module_boundary_violations: 0,
        duplication_signals: 0,
      },
      remediation: {
        immediate: ['Refactor behind tests.'],
        agent_rules: ['Call assess_change_risk and find_tests first.'],
        validation_tools: ['get_system_health'],
      },
    },
    change_risks: [{
      node_id: 'node-task-service',
      node_name: 'TaskService',
      risk_level: 'high',
      risk_factors: [],
      downstream_impact: {},
      test_protection: {},
      recommendations: [],
    }],
    change_risk_summary: {
      high_risk_nodes: ['node-task-service'],
      untested_critical_paths: ['node-task-service'],
      recent_hotspots: [],
    },
  } as unknown as CASOutput;

  const observations: RuntimeObservation[] = [{
    id: 'obs-1',
    project_path: '/tmp/system',
    recorded_at: new Date().toISOString(),
    event: {
      type: 'error',
      timestamp: new Date().toISOString(),
      status_code: 500,
      duration_ms: 1600,
      trace_id: 'trace-1',
      attributes: { volume: 50 },
    },
    correlation: {
      status: 'matched',
      best_match: {
        type: 'node',
        id: 'node-task-service',
        label: 'TaskService',
      },
      matches: [],
      runtime_links: [],
      suggested_instrumentation: [],
    },
  }];

  const result = buildOperationalPriorities(cas, observations);
  assert.equal(result.priorities.length, 1);
  assert.equal(result.priorities[0].static_risk.system_health_risk, 'Complexity hotspots need targeted tests before changes');
  assert.equal(result.priorities[0].static_risk.change_risk, 'high');
  assert.equal(result.priorities[0].static_risk.untested, true);
  assert.equal(result.priorities[0].runtime.errors, 1);
  assert.ok(result.priorities[0].priority_score >= 50);
});
