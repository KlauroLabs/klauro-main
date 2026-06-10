import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { simulateRuntimeTelemetry } from './runtime-simulation';

test('simulateRuntimeTelemetry maps synthetic events to CAS and ranks operational priorities', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-runtime-project-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-runtime-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = storage;

  const cas: CASOutput = {
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-runtime-test',
    system: { id: 'system-runtime', name: 'Runtime System', type: 'service', root_path: root },
    nodes: [{
      id: 'node-billing-service',
      name: 'BillingService',
      type: 'service',
      source: { file: 'src/billing.service.ts', line: 12 },
    }],
    edges: [],
    entry_points: [{
      id: 'entry-create-invoice',
      name: 'POST /invoices',
      type: 'http',
      source_node: 'node-billing-service',
      trigger: { method: 'POST', path: '/invoices' },
      handler: { node_id: 'node-billing-service', method_name: 'createInvoice', file: 'src/billing.service.ts', line: 12 },
    }],
    runtime_static_links: [{
      id: 'runtime-entry-create-invoice',
      kind: 'entry-point',
      static_id: 'entry-create-invoice',
      runtime_signal: 'http:POST:/invoices',
      telemetry_status: 'instrumentable',
      confidence: 0.92,
      instrumentation_points: ['src/billing.service.ts:12'],
      evidence: [{ kind: 'route', source: '/invoices', confidence: 0.92 }],
    }],
    system_health: {
      score: 70,
      status: 'watch',
      summary: 'Billing has runtime risk.',
      risk_areas: [{
        id: 'billing-risk',
        type: 'runtime-coverage-gap',
        severity: 'high',
        title: 'Billing flow is operationally sensitive',
        description: 'Billing is important.',
        affected_nodes: ['node-billing-service', 'entry-create-invoice'],
        evidence: ['billing route'],
        recommendation: 'Check billing tests before edits.',
        agent_guidance: 'Use runtime and CAS together.',
      }],
      coherence: {
        status: 'coherent',
        paradigm_count: 1,
        primary_paradigms: ['Service Layer'],
        conflicting_paradigms: [],
        naming_convention_violations: 0,
        dependency_injection_violations: 0,
        module_boundary_violations: 0,
        duplication_signals: 0,
      },
      remediation: {
        immediate: [],
        agent_rules: [],
        validation_tools: [],
      },
    },
    change_risks: [{
      node_id: 'entry-create-invoice',
      risk_level: 'high',
      risk_factors: [],
      downstream_impact: {
        direct_callers: [],
        transitive_callers: [],
        affected_call_chains: [],
        affected_entry_points: ['entry-create-invoice'],
      },
      test_protection: {
        has_direct_tests: false,
        has_integration_tests: false,
      },
      stability_context: {
        recent_churn: true,
        commit_count_30d: 3,
        bug_fix_density: 1,
      },
      recommendations: [],
    }],
    change_risk_summary: {
      high_risk_nodes: ['entry-create-invoice'],
      untested_critical_paths: ['entry-create-invoice'],
      recent_hotspots: [],
    },
    analyzer_contributions: [],
    progressive_levels: { levels: {}, level_definitions: [] } as any,
  };

  try {
    const result = await simulateRuntimeTelemetry(cas, root, {
      scenario: 'bug-hunt',
      eventCount: 24,
      seed: 'runtime-test',
      persist: false,
    });

    assert.equal(result.event_count, 24);
    assert.ok(result.correlation_summary.matched > 0);
    assert.ok(result.mapped_targets.length > 0);
    assert.ok(result.operational_priorities.priorities.length > 0);
    assert.equal(result.operational_priorities.priorities[0].static_risk.change_risk, 'high');
  } finally {
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    await fs.remove(root);
    await fs.remove(storage);
  }
});
