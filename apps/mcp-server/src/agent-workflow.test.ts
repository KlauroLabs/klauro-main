
for (const response_profile of ['standard', 'minimal', 'first-turn', 'capsule-only'] as const) {
  test(`missing explicit symbols remain suggestions, not unrelated edit targets: ${response_profile}`, async () => {
    await withWorkspace(async workspace => {
      const cas = fixtureCas();
      cas.system = { ...cas.system, root_path: workspace } as any;
      cas.nodes.push(node('extract-data', 'extractData', 'method', 'src/vue-analyzer.ts', 35));
      fs.writeFileSync(path.join(workspace, 'src/vue-analyzer.ts'), 'export function extractData() {}\n');
      const context = await getAgentContext(cas, workspace, {
        task_type: 'debug', target: 'extractDatabaseCalls', response_profile,
      }) as any;
      assert.equal(context.target_resolution.selected_node_id, null);
      assert.match(context.target_resolution.gaps.join(' '), /no CAS node resolved/);
      assert.ok(context.target_resolution.candidates.some((candidate: any) => candidate.id === 'extract-data'));
      assert.equal(context.agent_context_ready, false);
      if (response_profile === 'standard' || response_profile === 'minimal') {
        assert.deepEqual(context.execution_brief.edit_scope, []);
        assert.deepEqual(context.execution_brief.validate, []);
        assert.equal(context.work_context.coding_context, null);
        assert.match(context.execution_brief.stop_rule, /resolve|confirm/i);
      } else {
        const capsule = context.execution_capsule || context.capsule;
        assert.match(context.rule, /resolve|confirm/i);
        assert.match(capsule, /S\|resolve-target/);
        assert.doesNotMatch(capsule, /\nF\|[^\n]*[*!]:/);
        assert.doesNotMatch(capsule, /\nV\|/);
      }
    });
  });
}

test('qualified call syntax resolves the exact implementation, not its similar neighbor', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.system = { ...cas.system, root_path: workspace } as any;
    cas.nodes.push(
      { ...node('exact-call', 'extract', 'method', 'src/parser.ts', 5), qualified_name: 'Parser.extract' },
      { ...node('longer-call', 'extractData', 'method', 'src/ui.ts', 10), qualified_name: 'Parser.extractData' },
    );
    for (const target of ['Parser.extract', 'Parser.extract()', 'PARSER.EXTRACT()']) {
      const context = await getAgentContext(cas, workspace, { task_type: 'debug', target }) as any;
      assert.equal(context.target_resolution.selected_node_id, 'exact-call');
      assert.equal(context.target_resolution.gaps.length, 0);
    }
  });
});

test('natural language target discovery still finds behavior beyond exact identifiers', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.nodes.push({ ...node('invite-member', 'inviteMember', 'function', 'src/invitations.ts', 5), description: 'Send an invitation to a new workspace member.' });
    const context = await getAgentContext(cas, workspace, {
      task_type: 'debug', target: 'send an invitation to a workspace member',
    }) as any;
    assert.equal(context.target_resolution.selected_node_id, 'invite-member');
  });
});

import test from 'node:test';

for (const file of ['math.h', 'greeter.proto', 'main.cpp', 'module.ixx', 'scene.custom', 'Makefile']) {
  test(`observed source file targets do not depend on an extension whitelist: ${file}`, async () => {
    await withWorkspace(async workspace => {
      const cas = fixtureCas();
      cas.system = { ...cas.system, root_path: workspace } as any;
      cas.nodes = [node('observed-target', 'observedBehavior', 'function', file, 1)];
      cas.edges = [];
      cas.entry_points = [];
      cas.exit_points = [];
      fs.writeFileSync(path.join(workspace, file), 'observed source\n');
      const context = await getAgentContext(cas, workspace, { task_type: 'modify', target: file }) as any;
      assert.equal(context.target_resolution.selected_node_id, 'observed-target');
      assert.equal(context.file_read_plan[0].file, file);
      assert.deepEqual(context.target_resolution.gaps, []);
    });
  });
}
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  buildCodebaseAgentRules,
  explainChangeShape,
  openAgentWorkbench,
  preflightAgentChange,
  validateAgentChange,
} from './agent-workflow';
import { buildArchitectureContextForAgent, evaluateAgentReadiness, formatExecutionCapsule, getAgentStartContext, getAgentToolPlan, getAgentContext } from './agent-adoption';
import { benchmarkAgentContextCodecs, formatAgentContextCapsule, parseAgentContextCapsule } from './agent-context-codec';
import { ingestTelemetryBatch } from './telemetry-ingestion';
import { attachCasProjection } from './cas-projection';


test('regression guidance does not turn invented test paths into missing source citations', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    fs.writeFileSync(path.join(workspace, 'src', 'recovery.ts'), 'export function recoverDescription() {}\n');
    cas.nodes = [node('recover', 'recoverDescription', 'function', 'src/recovery.ts', 1)];
    cas.edges = [];
    cas.entry_points = [];
    cas.exit_points = [];
    cas.test_suites = [];
    const context = await getAgentContext(cas, workspace, {
      task_type: 'debug',
      target: 'recoverDescription',
      instructions: 'Identify connected callers and regression tests before changing recovery behavior.',
    }) as any;
    assert.equal(context.selected_node.id, 'recover');
    assert.ok(context.file_read_plan.every((item: any) => fs.existsSync(path.join(workspace, item.file))));
    assert.ok(context.execution_brief.read_first.every((file: string) => fs.existsSync(path.join(workspace, file))));
    assert.equal(context.analysis_freshness.missing_files, 0);
    assert.notEqual(context.analysis_freshness.citation_verification, 'invalid');
    assert.match(context.validation_plan.run_policy, /focused test command was not verified/i);
    assert.notEqual(context.validation_plan.strategy, 'focused-tests-first');
  });
});

test('CAS-observed test candidates remain citations and missing real files remain invalid', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    fs.writeFileSync(path.join(workspace, 'src', 'recovery.ts'), 'export function recoverDescription() {}\n');
    fs.mkdirSync(path.join(workspace, 'tests'));
    const testFile = path.join(workspace, 'tests', 'recovery.test.ts');
    fs.writeFileSync(testFile, 'test("recovers descriptions", () => {});\n');
    cas.nodes = [
      node('recover', 'recoverDescription', 'function', 'src/recovery.ts', 1),
      node('recovery-check', 'checkRecovery', 'function', 'tests/recovery.test.ts', 1),
    ];
    cas.edges = [];
    cas.entry_points = [];
    cas.exit_points = [];
    cas.test_suites = [];
    const task = { task_type: 'debug' as const, target: 'recoverDescription', instructions: 'Find focused regression tests for recovery behavior.' };
    const before = await getAgentContext(cas, workspace, task) as any;
    assert.ok(before.file_read_plan.some((item: any) => item.file === 'tests/recovery.test.ts'));
    assert.equal(before.analysis_freshness.missing_files, 0);
    fs.unlinkSync(testFile);
    const after = await getAgentContext(cas, workspace, task) as any;
    assert.equal(after.analysis_freshness.missing_files, 1);
    assert.equal(after.analysis_freshness.citation_verification, 'invalid');
  });
});

test('agent regression guidance reuses known test coverage instead of proposing duplicate files', async () => {
  await withWorkspace(async workspace => {
    const context = await getAgentContext(fixtureCas(), workspace, {
      task_type: 'debug',
      target: 'UsersService',
      instructions: 'Find the connected callers and regression tests before correcting user creation behavior.',
    }) as any;
    assert.ok(context.work_context.tests.suites.some((suite: any) => suite.file_path === 'src/users/users.service.spec.ts'));
    assert.ok(!context.file_read_plan.some((item: any) => item.reason.includes('likely focused regression test path')));
    assert.ok(context.execution_brief.read_first.every((file: string) => fs.existsSync(path.join(workspace, file))));
    assert.ok(!context.execution_brief.edit_scope.some((file: string) => /^tests\/users\.service\./.test(file)));
  });
});


test('function debugging keeps observed tests ahead of speculative test paths', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    fs.writeFileSync(path.join(workspace, 'src', 'recovery.ts'), 'export function recoverDescription() {}\n');
    fs.writeFileSync(path.join(workspace, 'src', 'recovery.test.ts'), 'test("recovers descriptions", () => {});\n');
    cas.nodes.push(node('recover', 'recoverDescription', 'function', 'src/recovery.ts', 1), node('recover-test', 'recovers descriptions', 'test', 'src/recovery.test.ts', 1));
    cas.edges.push({ id: 'test-recover', source: 'recover-test', target: 'recover', type: 'tests' });
    cas.test_suites!.push({ id: 'recover-suite', name: 'recovers descriptions', file_path: 'src/recovery.test.ts', test_type: 'unit', framework: 'node', tests: [] } as any);
    const context = await getAgentContext(cas, workspace, {
      task_type: 'debug', target: 'recoverDescription',
      instructions: 'Identify description publication validators, connected callers and regression tests for repeated rejection of an outcome description.',
    }) as any;
    assert.equal(context.selected_node.id, 'recover');
    assert.ok(context.work_context.tests.suites.some((suite: any) => suite.file_path === 'src/recovery.test.ts'));
    assert.ok(!context.file_read_plan.some((item: any) => item.reason.includes('likely focused regression test path')));
    assert.ok(!context.execution_brief.read_first.some((file: string) => /^tests\/recovery\./.test(file)));
  });
});

test('bounded agent orientation uses canonical graph counts and persisted call-layer readiness', async () => {
  await withWorkspace(async workspace => {
    const full = fixtureCas();
    const projected = attachCasProjection({
      ...full,
      nodes: [],
      edges: [],
      method_calls: undefined,
      call_chains: undefined,
      layers_ready: {
        complete: true,
        generated_at: '2026-08-22T00:00:00.000Z',
        layers: [
          { layer: 'L2', name: 'Call graph / edges', status: 'ready', fields: ['edges', 'method_calls', 'call_chains'] },
        ],
      },
    }, {
      loaded_sections: ['identity', 'facts', 'comprehension', 'tests', 'runtime', 'quality', 'supplemental'],
      node_count: full.nodes.length,
      edge_count: full.edges.length,
    });

    const readiness = evaluateAgentReadiness(projected, workspace);
    const context = getAgentStartContext(projected, workspace);

    assert.equal(readiness.profile.kind, 'backend-service');
    assert.equal(readiness.summary.nodes, full.nodes.length);
    assert.equal(readiness.summary.edges, full.edges.length);
    assert.equal(readiness.gates.find(gate => gate.id === 'call-chains')?.status, 'pass');
    assert.match(readiness.gates.find(gate => gate.id === 'call-chains')?.detail || '', /persisted L2 status is ready/);
    assert.equal(context.scale.nodes, full.nodes.length);
    assert.equal(context.scale.edges, full.edges.length);
    assert.equal(context.scale.projection?.graph_detail_loaded, false);
  });
});

test('openAgentWorkbench returns a product-level context for agent work', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    const context = await openAgentWorkbench(cas, workspace, {
      task_type: 'modify',
      target: 'UsersService',
      instructions: 'Change user creation behavior',
    });

    assert.equal(context.product, 'agent_workbench');
    assert.equal(context.task_context.selected_node?.name, 'UsersService');
    assert.ok(context.task_context.file_read_plan.some((item: any) => item.file === 'src/users/users.service.ts'));
    assert.equal(context.task_context.work_context.capability_memory.status, 'possible-existing-capability');
    assert.ok(context.task_context.work_context.capability_memory.reuse_decisions_required.some((decision: any) =>
      decision.existing_capability === 'Tenant-scoped user management'
    ));
    assert.ok(context.task_context.work_context.architecture_context.architecture_budget.includes('Service Layer'));
    assert.ok(Array.isArray(context.task_context.work_context.tests.mocks));
    assert.ok(Array.isArray(context.task_context.work_context.tests.fixtures));
    assert.ok(context.task_context.work_context.risk_context.target_risk);
    assert.equal(context.task_context.work_context.risk_context.target_risk.name, 'UsersService');
    assert.ok(context.task_context.work_context.risk_context.agent_rules.some((rule: string) => rule.includes('assess_change_risk')));
    assert.equal(context.task_context.execution_brief.mode, 'minimal-execution');
    assert.ok(context.task_context.execution_brief.read_first.includes('src/users/users.service.ts'));
    assert.ok(context.task_context.execution_brief.token_policy.source_files <= 5);
    assert.match(context.task_context.execution_brief.stop_rule, /stop/i);
    assert.match(context.task_context.execution_brief.capsule, /^K5\|m\|/);
    assert.ok(context.task_context.execution_brief.capsule.length < JSON.stringify(context.task_context.execution_brief).length / 2);
    assert.ok(context.agent_rules.idiom_rules.some((rule: any) => rule.category === 'testing'));
    assert.equal(context.signal_quality.overall, 'partial');
    assert.ok(context.signal_quality.warnings.some((warning: string) => warning.includes('reusable patterns')));
    assert.ok(context.evidence_policy.must_confirm_in_source.length > 0);
  });
});

test('first-turn agent contexts include a compact K15 context capsule that agents can execute without broad JSON', async () => {
  await withWorkspace(async workspace => {
    const context = await getAgentContext(fixtureCas(), workspace, {
      task_type: 'modify',
      target: 'UsersService',
      instructions: 'Change tenant-scoped user creation behavior.',
      response_profile: 'first-turn',
    }) as any;

    assert.equal(context.context_capsule.format, 'K15');
    assert.match(context.context_capsule.capsule, /^K15m[A-Za-z0-9]* UsersService/m);
    assert.match(context.context_capsule.capsule, /^I/m);
    assert.match(context.context_capsule.capsule, /^V/m);
    assert.ok(context.context_capsule.estimated_tokens < Math.ceil(JSON.stringify(context).length / 4));

    const parsed = parseAgentContextCapsule(context.context_capsule.capsule);
    assert.equal(parsed.version, 'K15');
    assert.ok(parsed.files.some(file => file.includes('src/users/users.service.ts')));
    assert.ok(parsed.rules.some(rule => /idioms|risk|reuse|F/i.test(rule)));
  });
});

test('first-turn start context is compact and preserves readiness, orientation, and next tools', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    const standard = getAgentStartContext(cas, workspace, { task_type: 'orient' }) as any;
    const compact = getAgentStartContext(cas, workspace, {
      task_type: 'orient',
      response_profile: 'first-turn',
    }) as any;

    assert.equal(compact.context_profile, 'first-turn');
    assert.equal(compact.readiness.status, standard.readiness.status);
    assert.equal(compact.system.name, standard.system.name);
    assert.ok(compact.starting_points.entry_points.length > 0);
    assert.ok(compact.recommended_first_tools.length > 0);
    assert.ok(!('idiom_summary' in compact));
    assert.ok(!('architecture_context' in compact));
    assert.ok(JSON.stringify(compact).length < JSON.stringify(standard).length * 0.6);
  });
});

test('agent context treats an exact file-stem target as a module instead of an inner helper', async () => {
  await withWorkspace(async workspace => {
    const relativeFile = 'src/coordination/participant-in-flight-store.ts';
    fs.mkdirSync(path.join(workspace, 'src', 'coordination'), { recursive: true });
    fs.writeFileSync(path.join(workspace, relativeFile), 'export function readSnapshots() { return []; }\n');
    const cas = fixtureCas();
    cas.system.root_path = workspace;
    cas.nodes.push(
      { id: 'file_in_flight_store', name: 'participant-in-flight-store.ts', type: 'file', source: { file: relativeFile, line: 1 }, metadata: {} } as any,
      { id: 'function_log_path', name: 'logPath', type: 'function', source: { file: relativeFile, line: 30 }, metadata: {} } as any,
    );

    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'participant-in-flight-store',
      response_profile: 'first-turn',
    }) as any;

    assert.equal(context.selected.id, 'file_in_flight_store');
    assert.equal(context.files[0], relativeFile);
  });
});

test('capsule-only agent contexts avoid expanded JSON when token savings matter most', async () => {
  await withWorkspace(async workspace => {
    const firstTurn = await getAgentContext(fixtureCas(), workspace, {
      task_type: 'modify',
      target: 'UsersService',
      instructions: 'Change tenant-scoped user creation behavior.',
      response_profile: 'first-turn',
    }) as any;
    const capsuleOnly = await getAgentContext(fixtureCas(), workspace, {
      task_type: 'modify',
      target: 'UsersService',
      instructions: 'Change tenant-scoped user creation behavior.',
      response_profile: 'capsule-only',
    }) as any;

    assert.equal(capsuleOnly.context_profile, 'capsule-only');
    assert.match(capsuleOnly.context_capsule, /^K15m[A-Za-z0-9]* UsersService/m);
    assert.match(capsuleOnly.execution_capsule, /^K5\|m\|UsersService/m);
    assert.ok(Array.isArray(capsuleOnly.files));
    assert.ok(!('work_context' in capsuleOnly));
    assert.ok(!('file_read_plan' in capsuleOnly));
    assert.ok(capsuleOnly.estimated_tokens < Math.ceil(JSON.stringify(firstTurn).length / 4) / 2);
  });
});

test('agent contexts include telemetry-backed operational priorities for debug/runtime tasks', async () => {
  await withWorkspace(async workspace => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-agent-runtime-storage-'));
    const previousStorage = process.env.KLAURO_STORAGE_PATH;
    try {
      process.env.KLAURO_STORAGE_PATH = storageRoot;
      const cas = fixtureCas();
      cas.system.root_path = workspace;
      cas.runtime_static_links = [{
        id: 'runtime-users-create',
        kind: 'entry-point',
        static_id: 'entry-users-create',
        runtime_signal: 'http:POST:/users',
        telemetry_status: 'instrumentable',
        confidence: 0.9,
      } as any];

      await ingestTelemetryBatch(cas, workspace, [{
        kind: 'error',
        name: 'http:POST:/users',
        method: 'POST',
        route: '/users',
        status: 500,
        duration_ms: 1800,
        file_hint: 'src/users/users.service.ts',
        function_hint: 'UsersService',
        volume: 42,
        error: {
          type: 'TenantScopeError',
          message: 'User creation lost tenant context',
          stack_top_frames: [{ file: 'src/users/users.service.ts', line: 1, function: 'UsersService' }],
        },
      }], { persist: true });

      const context = await getAgentContext(cas, workspace, {
        task_type: 'debug',
        target: 'what bugs should I address today',
        instructions: 'Use runtime impact to pick the most important bug and preserve local idioms.',
      }) as any;

      assert.equal(context.work_context.operational_priorities.status, 'ready');
      assert.equal(context.work_context.operational_priorities.sources.ingested, 1);
      assert.equal(context.work_context.operational_priorities.priorities[0].source, 'ingested');
      assert.equal(context.work_context.operational_priorities.priorities[0].runtime.errors, 1);
      assert.equal(context.work_context.operational_priorities.priorities[0].runtime.estimated_volume, 42);
      const operationalTarget = context.work_context.operational_priorities.priorities[0].static_target ||
        context.work_context.operational_priorities.priorities[0].target;
      assert.match(operationalTarget.file, /users\.service\.ts/);

      const capsuleOnly = await getAgentContext(cas, workspace, {
        task_type: 'debug',
        target: 'what bugs should I address today',
        instructions: 'Use runtime impact to pick the most important bug and preserve local idioms.',
        response_profile: 'capsule-only',
      }) as any;
      assert.match(capsuleOnly.context_capsule, /ops .*runtime/);
      assert.match(capsuleOnly.context_capsule, /1err/);

      // Runtime opt-out: runtime:"exclude" omits operational_priorities for the
      // exact same debug/triage task that includes it above, and the response
      // is strictly smaller (a real token reduction, not a blanked section).
      const excluded = await getAgentContext(cas, workspace, {
        task_type: 'debug',
        target: 'what bugs should I address today',
        instructions: 'Use runtime impact to pick the most important bug and preserve local idioms.',
        runtime: 'exclude',
      }) as any;
      // Omitted => the compacted view carries no priorities (null/undefined),
      // where the included view carried a populated priorities object above.
      assert.ok(!excluded.work_context.operational_priorities, 'operational_priorities omitted when runtime excluded');
      assert.ok(excluded.work_context !== undefined, 'static work_context still present');
      const includedBytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
      const excludedBytes = Buffer.byteLength(JSON.stringify(excluded), 'utf8');
      assert.ok(excludedBytes < includedBytes, `runtime-excluded context (${excludedBytes}B) must be smaller than included (${includedBytes}B)`);

      // exclude_sections alias is an equivalent opt-out path.
      const excludedBySection = await getAgentContext(cas, workspace, {
        task_type: 'debug',
        target: 'what bugs should I address today',
        exclude_sections: ['telemetry'],
      }) as any;
      assert.ok(!excludedBySection.work_context.operational_priorities, 'exclude_sections alias omits operational_priorities');
    } finally {
      if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
      else process.env.KLAURO_STORAGE_PATH = previousStorage;
      fs.rmSync(storageRoot, { recursive: true, force: true });
    }
  });
});

test('codec recommendations require exact validation while retaining failed compression measurements', () => {
  const compact = {
    context_profile: 'first-turn',
    task: 'modify: UsersService tenant-scoped user creation',
    selected: { name: 'UsersService', type: 'service', file: 'src/users/users.service.ts', line: 12 },
    files: ['src/users/users.service.ts', 'tests/users/users.service.test.ts', 'src/users/users.controller.ts'],
    candidates: ['src/users/entities/user.entity.ts', 'src/users/dto/create-user.dto.ts'],
    terms: ['tenant', 'users', 'creation'],
    idioms: [
      'dependency-injection: use constructor-injected repositories',
      'testing: focused service test imports production source',
    ],
    risks: ['risk high: tenant scope boundary', 'validate authorization invariant'],
    reuse: ['reuse Tenant-scoped user management before adding parallel behavior'],
    execution: {
      read: ['src/users/users.service.ts'],
      edit: ['src/users/users.service.ts', 'tests/users/users.service.test.ts'],
      validate: ['npm test -- tests/users/users.service.test.ts'],
    },
    rule: 'Read files in order. Preserve idioms. Expand only if blocked.',
  };

  const benchmark = benchmarkAgentContextCodecs(compact);
  const recommended = benchmark.results.find(result => result.name === benchmark.recommendation)!;
  const k15 = benchmark.results.find(result => result.name === 'k15-agent-context-language')!;
  const k14 = benchmark.results.find(result => result.name === 'k14-agent-context-language')!;
  const minJson = benchmark.results.find(result => result.name === 'min-json')!;
  assert.equal(recommended.validation_fidelity, 'exact');
  assert.equal(k15.validation_fidelity, 'exact');
  assert.equal(k14.validation_fidelity, 'lossy');
  assert.equal(minJson.validation_fidelity, 'exact');
  assert.ok(k15.estimated_tokens < minJson.estimated_tokens);
  assert.ok(k15.estimated_tokens > k14.estimated_tokens, 'corrupted commands can be smaller, but are not eligible');
  assert.notEqual(benchmark.recommendation, k14.name);
  assert.equal(benchmark.gates.find(gate => gate.id === 'agent-context-codec:k15-beats-k14')?.status, 'fail');
  assert.equal(benchmark.status, 'fail', 'unchanged compression gates remain visibly failed');
});

test('codec fidelity checks all long validation commands, not just the first short command', () => {
  const context = {
    task: 'debug: description recovery',
    execution: { validate: [
      'npm run typecheck',
      "cd 'packages/analyzer-core' && npm test -- 'src/analyzer/core/capability-catalog-repair-plan.test.ts' 'src/analyzer/core/capability-catalog-scheduling.test.ts'",
      "node -e 'console.log(\"repository  capability; 1 | 2\")'\nnode --version",
    ] },
  };
  const benchmark = benchmarkAgentContextCodecs(context);
  assert.equal(benchmark.results.find(result => result.name === benchmark.recommendation)!.validation_fidelity, 'exact');
  assert.equal(benchmark.results.find(result => result.name === 'k15-agent-context-language')!.validation_fidelity, 'exact');
  assert.equal(benchmark.results.find(result => result.name === 'k14-agent-context-language')!.validation_fidelity, 'lossy');
  assert.equal(benchmark.results.find(result => result.name === 'gzip-json-base64')!.validation_fidelity, 'exact');
  assert.equal(benchmark.results.find(result => result.name === 'protobuf-text')!.validation_fidelity, 'unverified');
});

test('execution capsules preserve every validation command without rewriting paths or arguments', () => {
  const commands = [
    "cd 'packages/analyzer-core' && npm test -- 'src/analyzer/core/capability-catalog-repair-plan.test.ts' 'src/analyzer/core/capability-catalog-scheduling.test.ts'",
    "node -e 'console.log(\"service controller capability\")'",
  ];
  const capsule = formatExecutionCapsule({ task_type: 'debug', target: 'recoverDescription', validate: commands });
  for (const command of commands) assert.ok(capsule.includes('V|' + command), capsule);
});

test('context capsule validation round trips shell syntax and long commands exactly', () => {
  const commands = [
    "cd 'packages/analyzer-core' && npm test -- 'src/analyzer/core/capability-catalog-repair-plan.test.ts' 'src/analyzer/core/capability-catalog-scheduling.test.ts'",
    "node -e 'console.log(\"service  controller; capability | 1\")'\nnode --version",
    "npm run typecheck",
  ];
  const capsule = formatAgentContextCapsule({
    task: 'debug: recoverDescription',
    files: ['src/analyzer/core/capability-catalog-repair-plan.test.ts'],
    execution: { validate: commands },
  });
  assert.deepEqual(parseAgentContextCapsule(capsule.capsule).validation, commands);
});

test('first-turn execution retains complete validation commands from standard context', async () => {
  await withWorkspace(async workspace => {
    const task = { task_type: 'modify' as const, target: 'UsersService', instructions: 'Change tenant-scoped user creation behavior.' };
    const standard = await getAgentContext(fixtureCas(), workspace, task) as any;
    const compact = await getAgentContext(fixtureCas(), workspace, { ...task, response_profile: 'first-turn' }) as any;
    assert.ok(standard.execution_brief.validate.length > 0);
    assert.deepEqual(compact.execution.validate, standard.execution_brief.validate);
    assert.deepEqual(parseAgentContextCapsule(compact.context_capsule.capsule).validation, standard.execution_brief.validate);
  });
});

test('execution capsule packs first-action context into a compact agent-readable line set', () => {
  const capsule = formatExecutionCapsule({
    mode: 'minimal-execution',
    task_type: 'modify',
    target: 'Fix N+1 project summary lookup without changing contracts',
    read_first: [
      'src/services/taskSummaryService.ts',
      'tests/taskSummaryService.test.ts',
      'src/repositories/projectRepository.ts',
    ],
    edit_scope: [
      'src/services/taskSummaryService.ts',
      'tests/taskSummaryService.test.ts',
    ],
    validate: ['node /tmp/validator.cjs'],
    preserve: [
      'repository boundary: batch behind repository, not controller',
      'testing: focused production-source test',
      'risk: public summary contract',
    ],
    token_policy: {
      source_files: 2,
      final_response_words: 80,
    },
    stop_rule: 'After validation, stop.',
  });

  assert.match(capsule, /^K5\|m\|Fix N\+1/);
  assert.match(capsule, /F\|1\*:src\/services\/taskSummaryService\.ts;2\*:tests\/taskSummaryService\.test\.ts;3:src\/repositories\/projectRepository\.ts/);
  assert.match(capsule, /P\|repo boundary/);
  assert.match(capsule, /V\|node \/tmp\/validator\.cjs/);
  assert.match(capsule, /B\|f2,w80/);
  assert.ok(capsule.length < 390, capsule);
});

test('execution capsule supports file-scoped executable operations', () => {
  const capsule = formatExecutionCapsule({
    task_type: 'debug',
    target: 'task summary performance regression',
    read_first: [
      'src/services/taskSummaryService.ts',
      'tests/taskSummaryService.test.ts',
    ],
    edit_scope: [
      'src/services/taskSummaryService.ts',
      'tests/taskSummaryService.test.ts',
    ],
    ops: [
      {
        file: 'src/services/taskSummaryService.ts',
        op: 'summarize: ids=uniq(tasks.projectId) > projects=findByIds(ids) > byId=Map(projects.id) > map sync',
      },
      {
        file: 'tests/taskSummaryService.test.ts',
        op: 'node:assert + TaskSummaryService only; inline repo counts findById/findByIds/capturedIds',
      },
    ],
    validate: ['node /tmp/validator.cjs'],
    token_policy: {
      source_files: 2,
      final_response_words: 40,
    },
  });

  assert.match(capsule, /^K5\|d\|task summary performance regression/);
  assert.match(capsule, /F\|1\*:src\/services\/taskSummaryService\.ts;2\*:tests\/taskSummaryService\.test\.ts/);
  assert.match(capsule, /O\|1:summarize: ids=uniq\(tasks\.projectId\)/);
  assert.match(capsule, /;2:node:assert \+ TaskSummaryService only/);
  assert.ok(capsule.length < 470, capsule);
});

test('agent context exposes compact risk context for broad tasks before a node is selected', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'improve account safety behavior',
    });

    assert.equal(context.work_context.risk_context.status, 'ready');
    assert.ok(context.work_context.risk_context.summary.total_high_risk_nodes >= 1);
    assert.ok(context.work_context.risk_context.repo_top_risks.some((risk: any) => risk.name === 'UsersService'));
    assert.ok(context.work_context.risk_context.agent_rules.some((rule: string) => rule.includes('repo_top_risks')));
  });
});

test('agent context risk_context.repo_top_risks excludes the target/scoped risks already shown in top_risks (no duplication)', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    // Add a second, independent high-risk node so repo-wide risk ranking has
    // more than the one node the target already scopes to.
    (cas as any).change_risks.push({
      node_id: 'auth-service',
      risk_level: 'high',
      risk_factors: [{ factor: 'security-sensitive', severity: 'high', details: 'Handles auth tokens.' }],
      downstream_impact: { direct_callers: [], transitive_callers: [], affected_call_chains: [], affected_entry_points: [] },
      test_protection: { has_direct_tests: false, has_integration_tests: false, test_ids: [] },
      stability_context: { recent_churn: false, commit_count_30d: 0, bug_fix_density: 0 },
      recommendations: [],
    });
    (cas as any).change_risk_summary.high_risk_nodes.push('auth-service');

    const context: any = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'UsersService',
    });

    const rc = context.work_context.risk_context;
    assert.equal(rc.target_risk?.name, 'UsersService');
    assert.ok(rc.top_risks.some((r: any) => r.node_id === 'users-service'));
    // The target's own risk (users-service) must not be repeated in
    // repo_top_risks now that it's already surfaced via top_risks/target_risk.
    assert.ok(
      !rc.repo_top_risks.some((r: any) => r.node_id === 'users-service'),
      `expected users-service to be excluded from repo_top_risks, got: ${JSON.stringify(rc.repo_top_risks)}`,
    );
    // The other repo-wide risk should still be visible as background.
    assert.ok(rc.repo_top_risks.some((r: any) => r.node_id === 'auth-service'));
  });
});

test('agent context prioritizes documentation files for documentation tasks', async () => {
  await withWorkspace(async workspace => {
    fs.mkdirSync(path.join(workspace, 'docs', 'mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'docs', 'mcp', 'ANALYSIS-PERFECTION-AUDIT.md'),
      '# Analysis Perfection Audit\n\nCurrent proof evidence.\n',
    );
    const cas = fixtureCas();
    cas.system = { ...cas.system, root_path: workspace } as any;

    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'analysis perfection audit documentation and MCP agent context evidence',
    });

    assert.equal(context.selected_node, null);
    assert.equal(context.file_read_plan[0]?.file, 'docs/mcp/ANALYSIS-PERFECTION-AUDIT.md');
    assert.match(context.file_read_plan[0]?.reason || '', /task hint related file/);
  });
});

test('agent context resolves an exact implementation symbol before interpreting documentation intent', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.system = { ...cas.system, root_path: workspace } as any;
    cas.nodes.push(node('extract-doc', 'extractDocumentation', 'method', 'src/parser.ts', 35));
    const context = await getAgentContext(cas, workspace, {
      task_type: 'debug', target: 'extractDocumentation',
      instructions: 'Fix documentation lost from assigned functions and find regression tests.',
    }) as any;
    assert.equal(context.target_resolution.selected_node_id, 'extract-doc');
    assert.equal(context.file_read_plan[0].file, 'src/parser.ts');
    assert.match(context.file_read_plan[0].reason, /selected target/);
  });
});

test('agent context exposes alternative implementations of an exact documentation symbol', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.system = { ...cas.system, root_path: workspace } as any;
    cas.nodes.push(
      node('extract-js', 'extractDocumentation', 'method', 'src/javascript-parser.ts', 35),
      node('extract-py', 'extractDocumentation', 'method', 'src/python-parser.ts', 35),
    );
    for (const response_profile of ['minimal', 'first-turn', 'capsule-only'] as const) {
      const context = await getAgentContext(cas, workspace, {task_type: 'debug', target: 'extractDocumentation', response_profile}) as any;
      assert.match(context.target_resolution.gaps.join(' '), /ambiguous/);
      assert.ok(context.target_resolution.candidates.some((candidate: any) => candidate.id === 'extract-js'));
      assert.ok(context.target_resolution.candidates.some((candidate: any) => candidate.id === 'extract-py'));
      assert.equal(context.target_resolution.candidate_count, 2);
      assert.equal(context.target_resolution.candidates_truncated, false);
      assert.ok(context.readiness.status);
    }
  });
});

test('agent context treats audit proof targets as documentation-first', async () => {
  await withWorkspace(async workspace => {
    fs.mkdirSync(path.join(workspace, 'docs', 'mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'docs', 'mcp', 'ANALYSIS-PERFECTION-AUDIT.md'),
      '# Analysis Perfection Audit\n\nStorage maintenance MCP proof evidence.\n',
    );
    const cas = fixtureCas();
    cas.system = { ...cas.system, root_path: workspace } as any;
    cas.nodes.push(node('coverage-evidence', 'evidence', 'function', 'apps/mcp-server/src/agent-task-family-coverage.ts', 825));

    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'storage maintenance MCP tools and analysis perfection audit evidence',
    });

    assert.equal(context.selected_node, null);
    assert.equal(context.file_read_plan[0]?.file, 'docs/mcp/ANALYSIS-PERFECTION-AUDIT.md');
  });
});

test('agent context does not treat docs-heavy inference tasks as documentation edits', async () => {
  await withWorkspace(async workspace => {
    fs.mkdirSync(path.join(workspace, 'docs', 'cas'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'docs', 'cas', 'README.md'),
      '# CAS docs\n\nSDK embedded examples can confuse profile inference.\n',
    );
    const cas = fixtureCas();
    cas.system = { ...cas.system, root_path: workspace } as any;
    cas.nodes.push(
      node('domain-extractor', 'DomainExtractor', 'class', 'packages/analyzer-core/src/analyzer/core/domain-extractor.ts', 1),
      node('analysis-profile', 'classifyAnalysisProfile', 'function', 'apps/mcp-server/src/analysis-profile.ts', 12),
    );

    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'adversarial domain profile inference docs heavy SDK embedded examples monorepo product summary',
    });

    assert.notEqual(context.selected_node, null);
    assert.ok(
      ['DomainExtractor', 'classifyAnalysisProfile'].includes(context.selected_node?.name || ''),
      `expected analyzer source target, got ${context.selected_node?.name || 'none'}`,
    );
    assert.ok(!context.file_read_plan[0]?.file.endsWith('.md'));
  });
});

test('agent context resolves performance owners from symptoms without naming implementation symbols', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.system = { ...cas.system, root_path: workspace } as any;
    cas.nodes = [
      node('task', 'Task', 'entity', 'src/domain/task.ts', 1),
      node('task-controller', 'TaskController', 'controller', 'src/controllers/taskController.ts', 1),
      node('task-summary-service', 'TaskSummaryService', 'service', 'src/services/taskSummaryService.ts', 1),
      node('project-repository', 'ProjectRepository', 'class', 'src/repositories/projectRepository.ts', 1),
      node('task-summary-test', 'task summary contract', 'test', 'tests/taskSummaryService.test.ts', 1),
    ];
    cas.edges = [
      { id: 'edge-controller-task', source: 'task-controller', target: 'task', type: 'uses' },
      { id: 'edge-summary-task', source: 'task-summary-service', target: 'task', type: 'uses' },
      { id: 'edge-summary-projects', source: 'task-summary-service', target: 'project-repository', type: 'calls' },
      { id: 'edge-summary-test', source: 'task-summary-test', target: 'task-summary-service', type: 'tests' },
    ] as any;
    cas.entry_points = [];

    const context = await getAgentContext(cas, workspace, {
      task_type: 'debug',
      target: 'task summary performance regression',
      instructions: 'Diagnose and fix the slow task summary path that loads each project one by one. Preserve the public summary contract.',
      success_criteria: [
        'Root cause identifies repeated repository calls.',
        'Fix batches and deduplicates project lookups behind the repository boundary.',
        'Tests preserve the summary contract.',
      ],
      response_profile: 'capsule-only',
    }) as any;

    const firstFiles = new Set(context.files.slice(0, 3));
    assert.deepEqual(firstFiles, new Set([
      'src/repositories/projectRepository.ts',
      'tests/taskSummaryService.test.ts',
      'src/services/taskSummaryService.ts',
    ]));
  });
});

test('architecture context gives agents pattern budget and target-relevant owners', () => {
  const context = buildArchitectureContextForAgent(fixtureCas(), {
    target: 'UsersService',
    files: ['src/users/users.service.ts'],
  });

  assert.equal(context.system_type, 'api');
  assert.ok(context.architecture_budget.includes('Service Layer'));
  assert.ok(context.architecture_budget.includes('Repository'));
  assert.equal(context.inventory_counts.services, 1);
  assert.ok(context.inventory_examples.controllers.some((item: any) => item.name === 'UsersController'));
  assert.ok(context.relevant_inventory.services.some((item: any) => item.name === 'UsersService'));
  assert.ok(context.pattern_decision_matrix.some((item: any) =>
    item.pattern === 'Repository' && item.owner_categories.includes('repositories')
  ));
  assert.ok(context.agent_rules.some((rule: string) => rule.includes('business rules')));
});

test('architecture context does not promote unrelated global patterns for a targeted task', () => {
  const cas = fixtureCas();
  cas.nodes.push(
    node('legacy-controller', 'LegacyReportsController', 'controller', 'legacy/reports/reports.controller.ts', 1),
    node('legacy-model', 'LegacyReport', 'entity', 'legacy/reports/report.entity.ts', 1),
    node('legacy-view', 'LegacyReportsPage', 'component', 'legacy/reports/ReportsPage.tsx', 1),
  );
  cas.architecture_summary!.architectural_patterns = [
    ...(cas.architecture_summary!.architectural_patterns || []),
    {
      name: 'MVC',
      category: 'application-architecture',
      confidence: 0.93,
      evidence: ['legacy controller/model/view inventory'],
      node_ids: ['legacy-controller', 'legacy-model', 'legacy-view'],
      guidance: 'Preserve controller/model/view separation for legacy reports.',
    },
  ] as any;
  cas.architecture_summary!.architectural_inventory = {
    ...cas.architecture_summary!.architectural_inventory!,
    controllers: [
      ...(cas.architecture_summary!.architectural_inventory!.controllers || []),
      'legacy-controller',
    ],
    models: [
      ...(cas.architecture_summary!.architectural_inventory!.models || []),
      'legacy-model',
    ],
    views: [
      ...(cas.architecture_summary!.architectural_inventory!.views || []),
      'legacy-view',
    ],
  };

  const context = buildArchitectureContextForAgent(cas, {
    target: 'UsersService',
    files: ['src/users/users.service.ts'],
  });

  assert.ok(context.architecture_budget.includes('Service Layer'));
  assert.ok(context.architecture_budget.includes('Repository'));
  assert.ok(!context.architecture_budget.includes('MVC'));
  assert.ok(context.global_architecture_budget?.includes('MVC'));
  assert.ok(context.pattern_decision_matrix.every((item: any) => item.pattern !== 'MVC'));
  assert.ok(context.inventory_examples.controllers.every((item: any) => item.name !== 'LegacyReportsController'));
});

test('agent context scopes architecture examples to selected target even when task hints add related files', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.system = { ...cas.system, root_path: workspace } as any;
    cas.nodes.push(
      node('auth-service', 'AuthService', 'service', 'src/auth/auth.service.ts', 1),
      node('session-policy', 'SessionPolicy', 'class', 'src/auth/session.policy.ts', 1),
    );
    cas.entry_points![0] = {
      ...cas.entry_points![0],
      handler: {
        ...(cas.entry_points![0] as any).handler,
        file: 'src/users/users.service.ts',
        line: 1,
      },
    } as any;
    cas.architecture_summary!.architectural_patterns = [
      ...(cas.architecture_summary!.architectural_patterns || []),
      {
        name: 'Service Layer',
        category: 'business-logic',
        confidence: 0.91,
        evidence: ['service inventory'],
        node_ids: ['users-service', 'auth-service', 'session-policy'],
        guidance: 'Keep business rules in selected service owners.',
      },
    ] as any;
    cas.architecture_summary!.architectural_inventory = {
      ...cas.architecture_summary!.architectural_inventory!,
      services: ['users-service', 'auth-service'],
      models: [
        ...(cas.architecture_summary!.architectural_inventory!.models || []),
        'session-policy',
      ],
    };

    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'UsersService',
      instructions: 'Adjust authenticated user creation while preserving auth/session policy boundaries.',
    }) as any;

    assert.match(context.file_read_plan[0].reason, /selected target/);
    assert.match(context.file_read_plan[0].reason, /representative entry point/);
    assert.ok(context.file_read_plan.some((item: any) => item.file === 'src/auth/auth.service.ts' && /task hint/.test(item.reason)));

    const examples = [
      ...Object.values(context.work_context.architecture_context.inventory_examples || {}).flatMap((items: any) => items || []),
      ...Object.values(context.work_context.architecture_context.relevant_inventory || {}).flatMap((items: any) => items || []),
      ...context.work_context.architecture_context.pattern_decision_matrix.flatMap((row: any) => row.examples || []),
    ] as any[];
    assert.ok(examples.some((example: any) => String(example.file || '').includes('users/users.service.ts')));
    assert.ok(examples.every((example: any) => !String(example.file || '').includes('auth/')));
  });
});

test('architecture context scopes file-targeted analyzer work away from legacy API patterns', () => {
  const cas = fixtureCas();
  cas.system = {
    ...cas.system,
    type: 'MCP analyzer monorepo',
  } as any;
  cas.nodes.push(
    node('quick-description', 'buildQuickDescription', 'method', 'packages/analyzer-core/src/analyzer/core/orchestrator.ts', 7017),
    node('analyzer-service', 'CASAnalyzerService', 'service', 'packages/analyzer-core/src/analyzer/services/cas-analyzer.service.ts', 82),
    node('query-helper', 'runQuery', 'function', 'apps/mcp-server/src/query.ts', 60),
    node('query-import', 'import ../../../packages/analyzer-core/src/types/cas.types', 'import', 'apps/mcp-server/src/query.ts', 1),
    node('legacy-controller', 'WorkspacesController', 'controller', 'src/workspaces/workspaces.controller.ts', 1),
    node('legacy-model', 'workspace.entity.ts', 'file', 'src/database/entities/workspace.entity.ts', 1),
    node('legacy-view', 'ComponentsService', 'service', 'src/components/components.service.ts', 1),
  );
  cas.architecture_summary!.architectural_patterns = [
    ...(cas.architecture_summary!.architectural_patterns || []),
    {
      name: 'MVC',
      category: 'application-architecture',
      confidence: 0.95,
      evidence: ['legacy controller/model/view inventory'],
      node_ids: ['legacy-controller', 'legacy-model', 'legacy-view'],
      guidance: 'Preserve legacy controller/model/view separation.',
    },
    {
      name: 'Command Script / Automation',
      category: 'automation',
      confidence: 0.67,
      evidence: ['analyzer orchestration method'],
      node_ids: ['quick-description', 'analyzer-service', 'query-helper', 'query-import'],
      guidance: 'Preserve analyzer orchestration and helper-module split.',
    },
  ] as any;
  cas.architecture_summary!.architectural_inventory = {
    ...cas.architecture_summary!.architectural_inventory!,
    controllers: [
      ...(cas.architecture_summary!.architectural_inventory!.controllers || []),
      'legacy-controller',
    ],
    models: [
      ...(cas.architecture_summary!.architectural_inventory!.models || []),
      'legacy-model',
    ],
    views: [
      ...(cas.architecture_summary!.architectural_inventory!.views || []),
      'legacy-view',
    ],
    scripts: ['quick-description'],
    services: [
      ...(cas.architecture_summary!.architectural_inventory!.services || []),
      'analyzer-service',
    ],
    mediators: ['query-helper', 'query-import'],
  };

  const context = buildArchitectureContextForAgent(cas, {
    target: 'analysis quality MCP usefulness token savings greenfield existing project architecture idiom proof',
    files: [
      'packages/analyzer-core/src/analyzer/core/orchestrator.ts',
      'packages/analyzer-core/src/analyzer/services/cas-analyzer.service.ts',
      'apps/mcp-server/src/query.ts',
    ],
  });

  assert.ok(context.architecture_budget.includes('Command Script / Automation'));
  assert.ok(!context.architecture_budget.includes('MVC'));
  assert.ok(context.global_architecture_budget?.includes('MVC'));
  assert.ok(context.pattern_decision_matrix.every((item: any) => item.pattern !== 'MVC'));
  assert.ok(context.pattern_decision_matrix.every((item: any) =>
    (item.examples || []).every((example: any) => !String(example.file || '').includes('src/workspaces'))
  ));
  assert.ok((context.inventory_examples.controllers || []).every((item: any) => item.name !== 'WorkspacesController'));
  assert.ok((context.inventory_examples.models || []).every((item: any) => item.name !== 'workspace.entity.ts'));
  const allExamples = [
    ...Object.values(context.inventory_examples || {}).flat(),
    ...Object.values(context.relevant_inventory || {}).flat(),
    ...context.pattern_decision_matrix.flatMap((row: any) => row.examples || []),
  ] as any[];
  assert.ok(allExamples.every((example: any) => example.type !== 'import'));
  assert.ok(allExamples.every((example: any) => !String(example.name || '').startsWith('import ')));
});

test('architecture context scopes Angular feature examples to the selected feature while allowing shared API definitions', () => {
  const cas = fixtureCas();
  cas.system = {
    ...cas.system,
    type: 'Angular frontend',
  } as any;
  cas.nodes.push(
    node('company-api', 'Company', 'class', 'src/app/defs-api/company.ts', 95),
    node('reports-api', 'reports.ts', 'file', 'src/app/defs-api/reports.ts', 1),
    node('vehicle-api', 'Vehicle', 'class', 'src/app/defs-api/vehicles.ts', 1),
    node('user-api', 'User', 'class', 'src/app/defs-api/user.ts', 1),
    node('company-view', 'CompanyComponent', 'class', 'src/app/features/admin/companies/view/company.component.ts', 1),
    node('user-view', 'UserViewComponent', 'class', 'src/app/features/admin/users/view/user-view.component.ts', 1),
    node('device-view', 'AdminDeviceComponent', 'class', 'src/app/features/admin/devices/view/device.component.ts', 1),
  );
  cas.edges.push(
    { id: 'edge-company-reports', source: 'company-api', target: 'reports-api', type: 'calls' },
    { id: 'edge-company-vehicle', source: 'company-api', target: 'vehicle-api', type: 'uses' },
    { id: 'edge-company-user', source: 'company-api', target: 'user-api', type: 'uses' },
  );
  cas.architecture_summary!.architectural_patterns = [
    {
      name: 'Client SDK / API Wrapper',
      category: 'integration',
      confidence: 0.9,
      evidence: ['generated API definitions'],
      node_ids: ['company-api', 'reports-api', 'vehicle-api', 'user-api'],
      guidance: 'Keep API protocol shapes in defs-api owners.',
    },
    {
      name: 'Component/Page UI',
      category: 'presentation',
      confidence: 0.88,
      evidence: ['feature component folders'],
      node_ids: ['company-view', 'user-view', 'device-view'],
      guidance: 'Place UI behavior under the closest feature component.',
    },
  ] as any;
  cas.architecture_summary!.architectural_inventory = {
    ...cas.architecture_summary!.architectural_inventory!,
    views: ['company-view', 'user-view', 'device-view'],
    clients: ['company-api', 'reports-api'],
    packages: ['vehicle-api', 'user-api'],
  };

  const context = buildArchitectureContextForAgent(cas, {
    target: 'Company Management',
    files: [
      'src/app/defs-api/company.ts',
      'src/app/features/admin/companies/view/company.component.ts',
      'src/app/defs-api/reports.ts',
    ],
  });

  const viewExamples = [
    ...((context.relevant_inventory.views || []) as any[]),
    ...((context.inventory_examples.views || []) as any[]),
  ];
  assert.ok(viewExamples.some((example: any) => example.name === 'CompanyComponent'));
  assert.ok(viewExamples.every((example: any) => example.name !== 'UserViewComponent'));
  assert.ok(viewExamples.every((example: any) => example.name !== 'AdminDeviceComponent'));
  assert.ok((context.relevant_inventory.packages || []).some((example: any) => example.name === 'Vehicle'));
});

test('architecture context synthesizes selected-file owners instead of global examples for unbucketed files', () => {
  const cas = fixtureCas();
  cas.system = {
    ...cas.system,
    type: 'React frontend with Python service helpers',
  } as any;
  cas.nodes.push(
    node('wallet-page', 'WalletsPage.tsx', 'file', 'src/pages/WalletsPage.tsx', 1),
    node('app-route', 'signals', 'route', 'src/App.tsx', 22),
    node('dominator-class', 'Dominator', 'class', 'server/dominator.py', 116),
    node('asyncio-import', 'asyncio', 'import', 'server/dominator.py', 1),
  );
  cas.architecture_summary!.architectural_patterns = [
    {
      name: 'Component/Page UI',
      category: 'presentation',
      confidence: 0.88,
      evidence: ['React page inventory'],
      node_ids: ['wallet-page', 'app-route'],
      guidance: 'Keep UI behavior in page/component owners.',
    },
  ] as any;
  cas.architecture_summary!.architectural_inventory = {
    ...cas.architecture_summary!.architectural_inventory!,
    views: ['wallet-page'],
    controllers: ['app-route'],
    packages: [],
    scripts: [],
  };

  const context = buildArchitectureContextForAgent(cas, {
    target: 'Dominator',
    files: ['server/dominator.py'],
  });

  const allExampleFiles = [
    ...Object.values(context.inventory_examples || {}).flat().map((item: any) => item.file),
    ...Object.values(context.relevant_inventory || {}).flat().map((item: any) => item.file),
    ...context.pattern_decision_matrix.flatMap((row: any) => (row.examples || []).map((item: any) => item.file)),
  ].filter(Boolean);
  assert.ok(allExampleFiles.some((file: string) => file === 'server/dominator.py'));
  assert.ok(allExampleFiles.every((file: string) => !String(file).includes('src/pages/WalletsPage.tsx')));
  assert.ok(allExampleFiles.every((file: string) => !String(file).includes('src/App.tsx')));
  assert.ok((context.relevant_inventory.services || context.relevant_inventory.packages || []).length > 0);
  const allExamples = [
    ...Object.values(context.inventory_examples || {}).flat(),
    ...Object.values(context.relevant_inventory || {}).flat(),
    ...context.pattern_decision_matrix.flatMap((row: any) => row.examples || []),
  ] as any[];
  assert.ok(allExamples.every((example: any) => example.type !== 'import'));
  assert.ok(allExamples.every((example: any) => !String(example.name || '').startsWith('import ')));
});

test('architecture context exposes local pattern owners for architecture proposal decisions', () => {
  const cas = fixtureCas();
  cas.nodes.push(
    node('users-repository', 'UsersRepository', 'repository', 'src/users/users.repository.ts', 1),
    node('users-page', 'UsersPage', 'component', 'src/users/UsersPage.tsx', 1),
    node('users-view-model', 'UsersViewModel', 'class', 'src/users/UsersViewModel.ts', 1),
    node('create-user-handler', 'CreateUserCommandHandler', 'class', 'src/users/handlers/CreateUserCommandHandler.ts', 1),
    node('unit-of-work', 'UnitOfWork', 'class', 'src/persistence/UnitOfWork.ts', 1),
  );
  cas.architecture_summary!.architectural_patterns = [
    ...(cas.architecture_summary!.architectural_patterns || []),
    {
      name: 'MVC',
      category: 'application-architecture',
      confidence: 0.86,
      evidence: ['controller/model/view inventory'],
      node_ids: ['users-controller', 'user-entity', 'users-page'],
      guidance: 'Preserve controller/model/view separation for request and page flows.',
    },
    {
      name: 'MVVM',
      category: 'ui-state',
      confidence: 0.84,
      evidence: ['view and view-model inventory'],
      node_ids: ['users-page', 'users-view-model'],
      guidance: 'Put UI interaction state in view models rather than components.',
    },
    {
      name: 'Mediator / Handler',
      category: 'application-architecture',
      confidence: 0.82,
      evidence: ['command handler inventory'],
      node_ids: ['create-user-handler'],
      guidance: 'Add use-case handlers beside existing command/query handlers.',
    },
    {
      name: 'Unit of Work',
      category: 'data-access',
      confidence: 0.8,
      evidence: ['unit of work inventory'],
      node_ids: ['unit-of-work'],
      guidance: 'Coordinate multi-repository writes through the unit-of-work boundary.',
    },
  ] as any;
  cas.architecture_summary!.architectural_inventory = {
    ...cas.architecture_summary!.architectural_inventory!,
    views: ['users-page'],
    view_models: ['users-view-model'],
    repositories: ['users-repository'],
    mediators: ['create-user-handler'],
    unit_of_work: ['unit-of-work'],
  };

  const context = buildArchitectureContextForAgent(cas, { target: 'new users workflow', limit: 8 });
  const matrix = context.pattern_decision_matrix;

  assert.ok(context.inventory_examples.models.some((item: any) => item.name === 'User'));
  assert.ok(context.inventory_examples.views.some((item: any) => item.name === 'UsersPage'));
  assert.ok(context.inventory_examples.controllers.some((item: any) => item.name === 'UsersController'));
  assert.ok(matrix.some((item: any) => item.pattern === 'MVC' && item.owner_categories.includes('controllers') && item.owner_categories.includes('models')));
  assert.ok(matrix.some((item: any) => item.pattern === 'MVVM' && item.owner_categories.includes('view_models')));
  assert.ok(matrix.some((item: any) => item.pattern === 'Mediator / Handler' && item.owner_categories.includes('mediators')));
  assert.ok(matrix.some((item: any) => item.pattern === 'Unit of Work' && item.owner_categories.includes('unit_of_work')));
});

test('small-repo agent contexts retain compact architecture decision context', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.nodes = cas.nodes.slice(0, 3);
    cas.edges = cas.edges.slice(0, 2);
    cas.test_suites = [];

    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'UsersService',
      instructions: 'Make a small service change.',
    });

    const compactContext = context as any;
    assert.match(compactContext.context_profile || '', /small-repo-minimal|micro-repo|token-minimal/);
    assert.ok(compactContext.work_context.architecture_context);
    assert.ok(compactContext.work_context.architecture_context.pattern_decision_matrix.length > 0);
    assert.ok(compactContext.work_context.architecture_context.agent_rules.some((rule: string) => /architectural style|pattern/i.test(rule)));
  });
});

test('preflightAgentChange explains fit, impacts, and required checks before edits', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    const review = await preflightAgentChange(cas, workspace, {
      target: 'UsersService',
      planText: 'Modify tenant-scoped user creation behavior.',
      files: ['src/users/users.service.ts'],
      diffText: [
        'diff --git a/src/users/users.service.ts b/src/users/users.service.ts',
        '+++ b/src/users/users.service.ts',
        '+  return this.repo.create(dto);',
      ].join('\n'),
      includeWorkingTree: false,
    });

    assert.equal(review.product, 'agent_change_preflight');
    assert.equal(review.status, 'warn');
    assert.equal(review.verdict, 'fits_with_warnings');
    assert.ok(review.change_shape.categories.includes('auth-or-tenant'));
    assert.ok(review.findings.some((finding: any) => finding.id === 'behavioral-invariant-impact'));
    assert.ok(review.findings.some((finding: any) => finding.evidence_source === 'plan-text-heuristic'));
    assert.ok(review.findings.some((finding: any) => finding.evidence_source === 'cas-analysis'));
    assert.equal(review.signal_quality.counts.tests, 1);
    assert.ok(review.plan_output_block.include_in_agent_plan);
  });
});

test('agent context honors explicit file path targets before semantic fallback', async () => {
  await withWorkspace(async workspace => {
    const context = await getAgentContext(fixtureCas(), workspace, {
      task_type: 'modify',
      target: 'src/users/entities/user.entity.ts',
      instructions: 'Change the persisted User shape.',
    });

    assert.equal(context.selected_node?.name, 'User');
    assert.equal(context.file_read_plan[0].file, 'src/users/entities/user.entity.ts');
    assert.ok(context.target_resolution.candidates.every((candidate: any) =>
      candidate.file === 'src/users/entities/user.entity.ts' || candidate.score < 250
    ));
  });
});

test('agent context resolves explicit paths whose namespace resembles sample code', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.nodes = [node(
      'controller_UserController',
      'UserController',
      'controller',
      'src/main/java/com/example/UserController.java',
      1,
    )];

    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'src/main/java/com/example/UserController.java',
    });

    assert.equal(context.selected_node?.id, 'controller_UserController');
    assert.equal(context.target_resolution.gaps.length, 0);
  });
});

test('agent context keeps explicit related paths ahead of generic semantic matches', async () => {
  await withWorkspace(async workspace => {
    const context = await getAgentContext(fixtureCas(), workspace, {
      task_type: 'review',
      target: 'hosted analyzer deployment proof',
      instructions: 'Review the release path without drifting into unrelated UI tests.',
      related_paths: ['src/users/entities/user.entity.ts', 'src/users/users.service.ts'],
      response_profile: 'capsule-only',
    }) as any;

    assert.deepEqual(context.files.slice(0, 2), [
      'src/users/entities/user.entity.ts',
      'src/users/users.service.ts',
    ]);
  });
});

test('agent context does not anchor exact file targets to incidental import nodes', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.nodes.push(
      node('import-cli-path', 'import path', 'import', 'apps/mcp-server/src/cli.ts', 1) as any,
      node('import-cli-fs', 'import fs-extra', 'import', 'apps/mcp-server/src/cli.ts', 2) as any,
    );

    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'apps/mcp-server/src/cli.ts',
      instructions: 'Update CLI behavior.',
    });

    assert.equal(context.selected_node, null);
    assert.equal(context.file_read_plan[0].file, 'apps/mcp-server/src/cli.ts');
  });
});

test('agent context surfaces target-scoped AI description enrichment only when narrative is weak', async () => {
  await withWorkspace(async workspace => {
    const context = await getAgentContext(fixtureCas(), workspace, {
      task_type: 'modify',
      target: 'UsersService',
      instructions: 'Explain and adjust user creation behavior without broad exploration.',
    }) as any;

    assert.equal(context.work_context.description_context.status, 'target-description-needs-ai');
    assert.equal(context.work_context.description_context.target.id, 'users-service');
    assert.ok(context.work_context.description_context.reasons.some((reason: string) => /missing|source/.test(reason)));
    assert.ok(context.next_mcp_calls.some((call: any) =>
      call.tool === 'generate_element_description' &&
      call.args.target === 'users-service' &&
      call.args.target_kind === 'service'
    ));

    const capsule = await getAgentContext(fixtureCas(), workspace, {
      task_type: 'modify',
      target: 'UsersService',
      instructions: 'Explain and adjust user creation behavior without broad exploration.',
      response_profile: 'capsule-only',
    }) as any;
    assert.match(capsule.context_capsule, /desc UsersService/);
  });
});

test('agent context ignores generic capability suffixes when resolving targets', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.nodes.push(
      node('payments-service', 'PaymentsService', 'service', 'src/payments/payments.service.ts', 1),
      node('portfolio-management-service', 'PortfolioManagementService', 'service', 'src/business/services/portfolio-management/portfolio-management.service.ts', 1),
    );

    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'Payments Management',
      instructions: 'Make a small idiomatic change without duplicating existing behavior.',
    });

    assert.equal(context.selected_node?.name, 'PaymentsService');
    assert.equal(context.file_read_plan[0].file, 'src/payments/payments.service.ts');
  });
});

test('agent context prefers active analyzer source over legacy lexical matches for analyzer maintenance', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.nodes.push(
      node('legacy-analyzer-method', 'analyzer', 'method', 'legacy/database/typescript/database-client.ts', 111) as any,
      node('language-analyzer-method', 'analyze', 'method', 'packages/analyzer-core/src/analyzer/languages/typescript-javascript-analyzer.ts', 326) as any,
      node('active-capability-summary', 'buildQuickDescription', 'method', 'packages/analyzer-core/src/analyzer/core/orchestrator.ts', 6660) as any,
    );

    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'capability summaries analyzer usefulness review',
      instructions: 'Improve CAS capability summaries and analysis usefulness review output.',
    });

    assert.equal(context.selected_node?.name, 'buildQuickDescription');
    assert.equal(context.file_read_plan[0].file, 'packages/analyzer-core/src/analyzer/core/orchestrator.ts');
  });
});

test('agent context resolves exact module filenames from the working tree before stale semantic matches', async () => {
  await withWorkspace(async workspace => {
    fs.mkdirSync(path.join(workspace, 'apps', 'mcp-server', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'apps', 'mcp-server', 'src', 'description-enrichment.ts'),
      'export async function generateElementDescription() { return "description"; }\n',
    );

    const cas = fixtureCas();
    cas.nodes.push(
      node('legacy-description-method', 'description', 'method', 'packages/analyzer-core/src/database/entities/component-connection.entity.ts', 182) as any,
      node('legacy-description-service', 'DescriptionService', 'service', 'legacy/api/description.service.ts', 12) as any,
    );

    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'description-enrichment',
      instructions: 'Improve manual AI description enrichment without broad file exploration.',
    });

    assert.equal(context.file_read_plan[0].file, 'apps/mcp-server/src/description-enrichment.ts');
    assert.equal(context.selected_node, null);
    assert.ok(context.target_resolution.gaps.some((gap: string) => gap.includes('no CAS node resolved')));
  });
});

test('agent context keeps task-hint files out of architecture placement guidance', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.system = {
      ...cas.system,
      type: 'MCP analyzer monorepo',
    } as any;
    cas.nodes.push(
      node('quick-description', 'buildQuickDescription', 'method', 'packages/analyzer-core/src/analyzer/core/orchestrator.ts', 7017),
      node('analyzer-service', 'CASAnalyzerService', 'service', 'packages/analyzer-core/src/analyzer/services/cas-analyzer.service.ts', 82),
      node('auth-service', 'AuthService', 'service', 'packages/analyzer-core/src/auth/auth.service.ts', 9),
    );
    cas.architecture_summary!.architectural_patterns = [
      {
        name: 'Service Layer',
        category: 'business-logic',
        confidence: 0.91,
        evidence: ['analyzer service inventory'],
        node_ids: ['quick-description', 'analyzer-service', 'auth-service'],
        guidance: 'Keep analyzer orchestration in analyzer services.',
      },
    ] as any;
    cas.architecture_summary!.architectural_inventory = {
      ...cas.architecture_summary!.architectural_inventory!,
      services: ['analyzer-service', 'auth-service'],
    };

    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'buildQuickDescription',
      instructions: 'Improve analyzer output without changing auth.',
    });

    const examples = [
      ...Object.values(context.work_context.architecture_context.inventory_examples || {}).flatMap((items: any) => items || []),
      ...Object.values(context.work_context.architecture_context.relevant_inventory || {}).flatMap((items: any) => items || []),
    ] as any[];
    assert.ok(examples.some((example: any) => String(example.file || '').includes('src/analyzer')));
    assert.ok(examples.every((example: any) => !String(example.file || '').includes('src/auth')));
  });
});

test('agent context infers focused tests from the workspace when CAS test links are missing', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    delete (cas as any).test_suites;
    cas.edges = (cas.edges || []).filter(edge => edge.type !== 'tests');

    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'src/users/users.service.ts',
      instructions: 'Change service behavior without broad test exploration.',
    });

    assert.equal(context.validation_plan.strategy, 'focused-tests-first');
    assert.ok(context.validation_plan.tests_to_inspect.some((testFile: any) =>
      testFile.file === 'src/users/users.service.spec.ts'
    ));
    assert.ok(context.validation_plan.commands.some((command: any) =>
      command.scope === 'focused-test' && command.command.includes('src/users/users.service.spec.ts')
    ));
  });
});

test('agent context excludes Klauro proof artifacts from task-hint source files', async () => {
  await withWorkspace(async workspace => {
    const generatedDir = path.join(workspace, '.klauro-existing-task-live-audit-feature', 'run', 'with-klauro', 'src', 'domain');
    fs.mkdirSync(path.join(workspace, 'src', 'domain'), { recursive: true });
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'domain', 'task.ts'), 'export class Task {}');
    fs.writeFileSync(path.join(generatedDir, 'task.ts'), 'export class Task {}');

    const cas = fixtureCas();
    cas.system.root_path = workspace;
    cas.nodes.push(
      node('task-domain', 'Task', 'entity', 'src/domain/task.ts', 1) as any,
      node('generated-task-domain', 'Task', 'entity', '.klauro-existing-task-live-audit-feature/run/with-klauro/src/domain/task.ts', 1) as any,
    );

    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'audit task domain model',
      instructions: 'Add audit domain behavior without reading generated proof artifacts.',
    });

    const files = context.file_read_plan.map((item: any) => item.file);
    assert.ok(files.some((file: string) => file === 'src/domain/task.ts'));
    assert.ok(files.every((file: string) => !file.includes('.klauro-existing-task-live')));
  });
});

test('buildCodebaseAgentRules creates a living repo-specific guide', () => {
  const rules = buildCodebaseAgentRules(fixtureCas(), '/tmp/example', {
    target: 'UsersService',
    files: ['src/users/users.service.ts'],
  });

  assert.equal(rules.product, 'codebase_agent_rules');
  assert.ok(rules.rules.default_agent_rule.includes('Ask Klauro'));
  assert.ok(rules.rules.idiom_rules.some((rule: any) => rule.rule.includes('Tests use spec')));
  assert.ok(rules.rules.invariant_rules.some((rule: any) => rule.rule.includes('tenant')));
  assert.equal(rules.signal_quality.counts.patterns, 0);
  assert.ok(rules.signal_quality.warnings.some((warning: string) => warning.includes('patterns')));
  assert.ok(rules.confidence_notes.length > 0);
});

test('explainChangeShape maps diffs to graph nodes, idioms, invariants, and tests', () => {
  const explanation = explainChangeShape(fixtureCas(), '/tmp/example', {
    target: 'UsersService',
    files: ['src/users/users.service.ts', 'src/users/users.service.spec.ts'],
    diffText: [
      'diff --git a/src/users/users.service.ts b/src/users/users.service.ts',
      '+++ b/src/users/users.service.ts',
      '+  return this.repo.create(dto);',
    ].join('\n'),
  });

  assert.equal(explanation.product, 'change_shape_explanation');
  assert.equal(explanation.status, 'ready');
  assert.ok(explanation.affected_graph.node_count >= 1);
  assert.ok(explanation.affected_idioms.selected_idioms.length > 0);
  assert.ok(explanation.confidence_notes.some((note: string) => note.includes('patterns')));
  assert.ok(explanation.explanation.some(line => line.includes('repo-local idiom')));
});

test('validateAgentChange blocks non-idiomatic post-edit diffs', async () => {
  await withWorkspace(workspace => {
    const validation = validateAgentChange(fixtureCas(), workspace, {
      target: 'UsersService',
      files: ['src/users/entities/user.entity.ts'],
      diffText: [
        'diff --git a/src/users/entities/user.entity.ts b/src/users/entities/user.entity.ts',
        '+++ b/src/users/entities/user.entity.ts',
        '+  @Property()',
        '+  nickname!: string;',
      ].join('\n'),
      includeWorkingTree: false,
    });

    assert.equal(validation.product, 'agent_change_validation');
    assert.equal(validation.status, 'fail');
    assert.equal(validation.verdict, 'does_not_fit_yet');
    assert.ok(validation.findings.every((finding: any) => finding.evidence_source));
    assert.ok(validation.required_checks.some(check => check.toLowerCase().includes('migration')));
    assert.match(validation.finalization_rule, /^Advisory:/);
  });
});

test('readiness, start context, and agent context surface dominant unanalyzed languages', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    (cas.system as any).technologies = {
      ...(cas.system as any).technologies,
      unanalyzed_languages: [{ name: 'Ruby', files: 289, share_of_source: 79 }],
    };

    const readiness = evaluateAgentReadiness(cas, workspace);
    const languageGate = readiness.gates.find(item => item.id === 'language-coverage');
    assert.equal(languageGate?.status, 'fail');
    assert.equal(
      languageGate?.detail,
      'Ruby is 79% of source but not analyzed; CAS covers only the analyzed remainder',
    );
    assert.ok(readiness.adoption_gaps.includes(
      'language-coverage: Ruby is 79% of source but not analyzed; CAS covers only the analyzed remainder',
    ));
    assert.equal(readiness.agent_context_ready, false);

    const expectedNote = 'Ruby is 79% of source (289 files) but not analyzed; CAS covers only the analyzed remainder. Fall back to direct file reading for the Ruby portion.';
    const startContext = getAgentStartContext(cas, workspace);
    assert.equal(startContext.readiness.language_coverage_note, expectedNote);

    const agentContext = await getAgentContext(cas, workspace, { task_type: 'orient' });
    assert.equal(agentContext.readiness.language_coverage_note, expectedNote);
  });
});

test('readiness has no language coverage gate when no unanalyzed language dominates', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    (cas.system as any).technologies = {
      ...(cas.system as any).technologies,
      unanalyzed_languages: [{ name: 'Lua', files: 6, share_of_source: 4 }],
    };

    const readiness = evaluateAgentReadiness(cas, workspace);
    assert.equal(readiness.gates.find(item => item.id === 'language-coverage'), undefined);

    const context = getAgentStartContext(cas, workspace);
    assert.equal(context.readiness.language_coverage_note, undefined);
  });
});

test('readiness accepts complete call chains as relationship detail when method-call rows are unavailable', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.method_calls = [];
    cas.call_chains = [{
      id: 'chain-create-user',
      chain_type: 'entry-to-exit',
      entry_point: {
        entry_point_id: 'entry-users-create',
        node_id: 'users-controller',
        method_name: 'create',
      },
      call_path: [{ call_id: 'controller-service', node_id: 'users-service', method_name: 'create', depth: 1 }],
      characteristics: {},
      risk_analysis: {},
    } as any];

    const readiness = evaluateAgentReadiness(cas, workspace);
    const relationshipGate = readiness.gates.find(item => item.id === 'relationship-detail');
    assert.equal(relationshipGate?.status, 'pass');
    assert.equal(relationshipGate?.score, 100);
    assert.match(relationshipGate?.detail || '', /1 complete call chains/);
  });
});

test('readiness does not reduce the score for an explicitly optional dimension', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.nodes = cas.nodes.map(item => ({ ...item, source: { ...item.source, file: 'lib/main.dart' } }));
    cas.security_boundaries = [];
    cas.security_contexts = [];

    const readiness = evaluateAgentReadiness(cas, workspace);
    const securityGate = readiness.gates.find(item => item.id === 'security');
    assert.equal(readiness.profile.kind, 'mobile-app');
    assert.equal(securityGate?.status, 'pass');
    assert.equal(securityGate?.score, 100);
  });
});

test('readiness accepts an evidence-backed absence of security enforcement', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.security_boundaries = [];
    cas.security_contexts = [];
    cas.security_summary = {
      boundaries: [],
      unprotected_sensitive_ops: [],
      assumed_vs_enforced: { enforced: 0, assumed: 0, missing: 0 },
    };

    const readiness = evaluateAgentReadiness(cas, workspace);
    const securityGate = readiness.gates.find(item => item.id === 'security');

    assert.equal(readiness.profile.kind, 'backend-service');
    assert.equal(securityGate?.status, 'pass');
    assert.equal(securityGate?.score, 100);
    assert.equal(securityGate?.detail, 'No security enforcement or unprotected sensitive operations found');
  });
});

test('readiness warns when security evidence reports missing enforcement', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.security_boundaries = [];
    cas.security_contexts = [];
    cas.security_summary = {
      boundaries: [],
      unprotected_sensitive_ops: ['entry-create-user'],
      assumed_vs_enforced: { enforced: 0, assumed: 0, missing: 1 },
    };

    const readiness = evaluateAgentReadiness(cas, workspace);
    const securityGate = readiness.gates.find(item => item.id === 'security');

    assert.equal(securityGate?.status, 'warn');
    assert.equal(securityGate?.score, 80);
  });
});

test('readiness rejects completed comprehension with no published product capabilities', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.layers_ready = { layers: [{ layer: 'L5', name: 'comprehension', status: 'ready' }] } as never;
    cas.capabilities = [];
    if (cas.product_map) cas.product_map.capabilities = [];
    cas.enhanced_system_purpose = {
      ...(cas.enhanced_system_purpose || {}),
      capability_catalog_coverage: {
        evidence_families: 12,
        published_capabilities: 0,
        status: 'rejected',
        reason: 'catalog omitted grounded evidence families',
      },
    } as any;

    const readiness = evaluateAgentReadiness(cas, workspace);
    const capabilityGate = readiness.gates.find(item => item.id === 'product-comprehension');

    assert.equal(capabilityGate?.status, 'fail');
    assert.equal(readiness.agent_context_ready, false);
    assert.equal(readiness.comprehension_ready, false);
    assert.equal(readiness.analysis_only_understanding_ready, false);
    assert.ok(readiness.adoption_gaps.some(gap => gap.startsWith('product-comprehension:')));
  });
});

test('readiness refuses agent context when canonical comprehension is unavailable', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.layers_ready = { layers: [{ layer: 'L5', name: 'comprehension', status: 'not_loaded' }] } as never;
    cas.capabilities = [];
    cas.flow_graph = {
      ...(cas.flow_graph || {} as any),
      capability_candidates: [{ id: 'candidate', name: 'Route inventory', operations: [] } as any],
    } as any;
    if (cas.product_map) cas.product_map.capabilities = [];

    const readiness = evaluateAgentReadiness(cas, workspace);
    const comprehensionGate = readiness.gates.find(item => item.id === 'product-comprehension');

    assert.equal(readiness.comprehension_ready, false);
    assert.equal(readiness.analysis_only_understanding_ready, false);
    assert.equal(readiness.comprehension.status, 'unavailable');
    assert.equal(readiness.comprehension.structural_candidates, 1);
    assert.equal(comprehensionGate?.status, 'fail');
    assert.equal(readiness.agent_context_ready, false);
  });
});

test('agent context carries target-scoped pillar digests when pillar data touches the target', async () => {
  await withWorkspace(async workspace => {
    const cas = pillarFixtureCas();
    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'UsersService',
    });

    const journeyContext = context.work_context.journey_context;
    assert.ok(journeyContext, 'journey_context missing');
    assert.equal(journeyContext.total_matching, 1);
    assert.equal(journeyContext.journeys[0].id, 'journey-create-user');
    assert.equal(journeyContext.journeys[0].kind, 'user-facing');
    assert.ok(journeyContext.journeys[0].boundaries.includes('JWT auth'));
    assert.equal(journeyContext.journeys[0].tests, 1);
    assert.ok(!journeyContext.journeys.some((journey: any) => journey.id === 'journey-billing-export'));

    const lineageContext = context.work_context.lineage_context;
    assert.ok(lineageContext, 'lineage_context missing');
    assert.equal(lineageContext.total_matching, 1);
    assert.equal(lineageContext.entities[0].entity, 'User');
    assert.equal(lineageContext.entities[0].access, 'writes');
    assert.equal(lineageContext.entities[0].sensitive, true);
    assert.deepEqual(lineageContext.entities[0].sensitive_fields, ['email']);
    assert.ok(!lineageContext.entities.some((entity: any) => entity.entity === 'Invoice'));

    const conformanceContext = context.work_context.conformance_context;
    assert.ok(conformanceContext, 'conformance_context missing');
    assert.equal(conformanceContext.scope, 'module');
    assert.equal(conformanceContext.deviations[0].kind, 'unguarded-entry-point');
    assert.equal(conformanceContext.deviations[0].severity, 'error');
    assert.ok(!conformanceContext.deviations.some((deviation: any) => deviation.file.startsWith('src/billing/')));

    for (const digest of [journeyContext.journeys, lineageContext.entities, conformanceContext.deviations]) {
      assert.ok(JSON.stringify(digest).length <= 600, `pillar digest exceeds token budget: ${JSON.stringify(digest).length} chars`);
    }
  });
});

test('agent context bounds journey digests and reports the true match count', async () => {
  await withWorkspace(async workspace => {
    const cas = pillarFixtureCas();
    const journeys = (cas as any).user_journeys;
    const base = journeys[0];
    for (let index = 0; index < 7; index += 1) {
      journeys.push({ ...base, id: `journey-extra-${index}`, name: `Extra user flow ${index}`, criticality: 'medium' });
    }
    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'UsersService',
    });
    const journeyContext = context.work_context.journey_context;
    assert.ok(journeyContext);
    assert.equal(journeyContext.total_matching, 8);
    assert.ok(journeyContext.journeys.length <= 5);
    assert.equal(journeyContext.journeys[0].id, 'journey-create-user');
    assert.ok(JSON.stringify(journeyContext.journeys).length <= 600);
  });
});

test('agent context pillar digests match entity targets through terminal entities and lineage rows', async () => {
  await withWorkspace(async workspace => {
    const cas = pillarFixtureCas();
    (cas as any).data_lineage[0].writers = [];
    (cas as any).data_lineage[0].readers = [];
    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'User',
    });
    assert.equal(context.selected_node?.name, 'User');
    const journeyContext = context.work_context.journey_context;
    assert.ok(journeyContext, 'journey_context missing for entity target');
    assert.equal(journeyContext.journeys[0].id, 'journey-create-user');
    const lineageContext = context.work_context.lineage_context;
    assert.ok(lineageContext, 'lineage_context missing for entity target');
    assert.equal(lineageContext.entities[0].entity, 'User');
    assert.equal(lineageContext.entities[0].access, 'target-entity');
  });
});

test('agent context omits pillar digests when no pillar data exists', async () => {
  await withWorkspace(async workspace => {
    const context = await getAgentContext(fixtureCas(), workspace, {
      task_type: 'modify',
      target: 'UsersService',
    });
    assert.ok(!('journey_context' in context.work_context));
    assert.ok(!('lineage_context' in context.work_context));
    assert.ok(!('conformance_context' in context.work_context));
  });
});

test('agent context omits pillar digests when pillar data exists but misses the target', async () => {
  await withWorkspace(async workspace => {
    const cas = pillarFixtureCas();
    (cas as any).user_journeys = [(cas as any).user_journeys[1]];
    (cas as any).data_lineage = [(cas as any).data_lineage[1]];
    (cas as any).paradigm_conformance[0].deviations = (cas as any).paradigm_conformance[0].deviations.filter(
      (deviation: any) => deviation.file.startsWith('src/billing/'),
    );
    const context = await getAgentContext(cas, workspace, {
      task_type: 'modify',
      target: 'UsersService',
    });
    assert.ok(!('journey_context' in context.work_context));
    assert.ok(!('lineage_context' in context.work_context));
    assert.ok(!('conformance_context' in context.work_context));
  });
});

test('compacted agent contexts preserve pillar digests', async () => {
  for (const profile of ['small-repo-minimal', 'token-minimal', 'tiny', 'micro']) {
    await withWorkspace(async workspace => {
      const previous = process.env.KLAURO_AGENT_CONTEXT_PROFILE;
      process.env.KLAURO_AGENT_CONTEXT_PROFILE = profile;
      try {
        const context = await getAgentContext(pillarFixtureCas(), workspace, {
          task_type: 'modify',
          target: 'UsersService',
        });
        assert.ok(context.work_context.journey_context, `${profile}: journey_context dropped`);
        assert.equal(context.work_context.journey_context.journeys[0].id, 'journey-create-user');
        assert.ok(context.work_context.lineage_context, `${profile}: lineage_context dropped`);
        assert.equal(context.work_context.lineage_context.entities[0].entity, 'User');
        assert.ok(context.work_context.conformance_context, `${profile}: conformance_context dropped`);
        assert.equal(context.work_context.conformance_context.deviations[0].severity, 'error');
      } finally {
        if (previous === undefined) delete process.env.KLAURO_AGENT_CONTEXT_PROFILE;
        else process.env.KLAURO_AGENT_CONTEXT_PROFILE = previous;
      }
    });
  }
});

test('compacted agent contexts do not invent pillar digests when data is absent', async () => {
  await withWorkspace(async workspace => {
    const previous = process.env.KLAURO_AGENT_CONTEXT_PROFILE;
    process.env.KLAURO_AGENT_CONTEXT_PROFILE = 'small-repo-minimal';
    try {
      const context = await getAgentContext(fixtureCas(), workspace, {
        task_type: 'modify',
        target: 'UsersService',
      });
      assert.ok(!('journey_context' in context.work_context));
      assert.ok(!('lineage_context' in context.work_context));
      assert.ok(!('conformance_context' in context.work_context));
    } finally {
      if (previous === undefined) delete process.env.KLAURO_AGENT_CONTEXT_PROFILE;
      else process.env.KLAURO_AGENT_CONTEXT_PROFILE = previous;
    }
  });
});

test('start context and agent context lead with the sensitive-data exposure digest', async () => {
  await withWorkspace(async workspace => {
    const cas = pillarFixtureCas();
    const expectedLine = 'User: 1 unguarded paths, external_transfer: false, sensitive fields: email';

    const startContext = getAgentStartContext(cas, workspace, {});
    const exposure = (startContext as any).sensitive_data_exposure;
    assert.ok(exposure, 'sensitive_data_exposure missing from start context');
    assert.equal(exposure.total_exposed_entities, 1);
    assert.deepEqual(exposure.highest_risk, [expectedLine]);
    assert.match(exposure.instruction, /before answering security/);
    assert.equal(Object.keys(exposure)[0], 'instruction');
    const startContextKeys = Object.keys(startContext);
    assert.ok(startContextKeys.indexOf('sensitive_data_exposure') < startContextKeys.indexOf('readiness'),
      'exposure digest should precede readiness in the start context');

    const agentContext = await getAgentContext(cas, workspace, { task_type: 'modify', target: 'UsersService' });
    const contextExposure = (agentContext as any).sensitive_data_exposure;
    assert.ok(contextExposure, 'sensitive_data_exposure missing from agent context');
    assert.deepEqual(contextExposure.highest_risk, [expectedLine]);
    const agentContextKeys = Object.keys(agentContext);
    assert.ok(agentContextKeys.indexOf('sensitive_data_exposure') < agentContextKeys.indexOf('work_context'),
      'exposure digest should precede work_context in the context');

    const lineageContext = agentContext.work_context.lineage_context;
    assert.ok(lineageContext, 'lineage_context missing');
    assert.equal(Object.keys(lineageContext)[0], 'headline');
    assert.equal(lineageContext.headline, expectedLine);
    assert.match(String(lineageContext.instruction), /before answering security/);
    const workContextKeys = Object.keys(agentContext.work_context);
    assert.ok(workContextKeys.indexOf('lineage_context') < workContextKeys.indexOf('journey_context'),
      'lineage_context should precede journey_context');
  });
});

test('exposure digest calls out paths covered only by non-auth guards', async () => {
  await withWorkspace(async workspace => {
    const cas = pillarFixtureCas();
    (cas as any).data_lineage[0].exposure = {
      unguarded_paths: 26,
      non_auth_guarded_paths: 22,
      external_transfer: false,
      sensitive: true,
    };
    const startContext = getAgentStartContext(cas, workspace, {});
    const exposure = (startContext as any).sensitive_data_exposure;
    assert.ok(exposure, 'sensitive_data_exposure missing from start context');
    assert.deepEqual(exposure.highest_risk, [
      'User: 26 unguarded paths (22 with non-auth guards only), external_transfer: false, sensitive fields: email',
    ]);

    const agentContext = await getAgentContext(cas, workspace, { task_type: 'modify', target: 'UsersService' });
    const lineageContext = agentContext.work_context.lineage_context;
    assert.ok(lineageContext, 'lineage_context missing');
    const userRow = (lineageContext.entities as any[]).find(entity => entity.entity === 'User');
    assert.ok(userRow, 'User row missing from lineage context entities');
    assert.equal(userRow.unguarded_paths, 26);
    assert.equal(userRow.non_auth_guarded_paths, 22);
  });
});

test('exposure digest is omitted when no sensitive entity has unguarded or external paths', async () => {
  await withWorkspace(async workspace => {
    const bareContext = getAgentStartContext(fixtureCas(), workspace, {});
    assert.ok(!('sensitive_data_exposure' in bareContext));

    const cas = pillarFixtureCas();
    (cas as any).data_lineage[0].exposure = { unguarded_paths: 0, external_transfer: false, sensitive: true };
    const startContext = getAgentStartContext(cas, workspace, {});
    assert.ok(!('sensitive_data_exposure' in startContext));

    const agentContext = await getAgentContext(cas, workspace, { task_type: 'modify', target: 'UsersService' });
    assert.ok(!('sensitive_data_exposure' in agentContext));
    const lineageContext = agentContext.work_context.lineage_context;
    assert.ok(lineageContext, 'lineage_context should still match the target');
    assert.ok(!('headline' in lineageContext));
    assert.ok(!('instruction' in lineageContext));
  });
});

test('compacted agent contexts preserve the exposure digest and lineage headline', async () => {
  for (const profile of ['small-repo-minimal', 'token-minimal', 'tiny', 'micro']) {
    await withWorkspace(async workspace => {
      const previous = process.env.KLAURO_AGENT_CONTEXT_PROFILE;
      process.env.KLAURO_AGENT_CONTEXT_PROFILE = profile;
      try {
        const context = await getAgentContext(pillarFixtureCas(), workspace, {
          task_type: 'modify',
          target: 'UsersService',
        });
        assert.ok((context as any).sensitive_data_exposure, `${profile}: sensitive_data_exposure dropped`);
        const lineageContext = context.work_context.lineage_context;
        assert.ok(lineageContext, `${profile}: lineage_context dropped`);
        assert.equal(lineageContext.headline, 'User: 1 unguarded paths, external_transfer: false, sensitive fields: email', `${profile}: lineage headline dropped`);
        assert.match(String(lineageContext.instruction), /before answering security/, `${profile}: lineage instruction dropped`);
      } finally {
        if (previous === undefined) delete process.env.KLAURO_AGENT_CONTEXT_PROFILE;
        else process.env.KLAURO_AGENT_CONTEXT_PROFILE = previous;
      }
    });
  }
});

test('agent tool plan names the valid answer packs when a step runs one', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    const reviewPlan = getAgentToolPlan(cas, { path: workspace, task: { task_type: 'review' } });
    assert.ok(reviewPlan.steps.some(step => step.tool === 'run_answer_pack'));
    assert.ok((reviewPlan as any).answer_packs, 'answer_packs guidance missing');
    assert.ok((reviewPlan as any).answer_packs.includes("'mastery'"));
    assert.ok((reviewPlan as any).answer_packs.includes('security'));
    assert.ok((reviewPlan as any).answer_packs.includes('Do not guess other pack names'));

    const modifyPlan = getAgentToolPlan(cas, { path: workspace, task: { task_type: 'modify', target: 'UsersService' } });
    assert.ok(!modifyPlan.steps.some(step => step.tool === 'run_answer_pack'));
    assert.ok(!('answer_packs' in modifyPlan));
  });
});

test('broad orientation uses exposed comprehension tools in one unique order', async () => {
  await withWorkspace(async workspace => {
    const plan = getAgentToolPlan(fixtureCas(), {
      path: workspace,
      task: {
        task_type: 'orient',
        instructions: 'Understand the product, architecture, and major user journeys end to end.',
      },
    });
    const exposed = new Set([
      'get_agent_start_context',
      'get_summary',
      'get_product_map',
      'get_conceptual_analysis',
      'get_user_journeys',
      'run_answer_pack',
    ]);

    assert.deepEqual(plan.steps.map(step => step.order), [1, 2, 3, 4, 5, 6]);
    assert.equal(new Set(plan.steps.map(step => step.tool)).size, plan.steps.length);
    assert.ok(plan.steps.every(step => exposed.has(step.tool)));
    assert.ok(plan.steps.some(step => step.tool === 'get_product_map'));
    assert.ok(plan.steps.some(step => step.tool === 'get_conceptual_analysis'));
    assert.ok(plan.steps.some(step => step.tool === 'get_user_journeys'));
    assert.ok(!plan.steps.some(step => step.tool === 'open_agent_workbench'));
  });
});

test('broad orientation avoids arbitrary internal targets and edit-oriented plans', async () => {
  await withWorkspace(async workspace => {
    const cas = pillarFixtureCas();
    cas.nodes.push(
      node('internal-benchmark', 'runInFlightBenchmark', 'function', 'scripts/benchmarks/in-flight.ts', 1),
      node('parser-main', 'main', 'function', 'native/parser/src/main.rs', 1),
    );
    for (let index = 0; index < 20; index += 1) {
      cas.edges.push({
        id: `edge-internal-${index}`,
        source: 'internal-benchmark',
        target: index % 2 === 0 ? 'users-service' : 'users-controller',
        type: 'calls',
      } as any);
    }
    cas.entry_points = [
      {
        id: 'entry-parser-cli',
        name: 'main',
        type: 'cli',
        source_node: 'parser-main',
        handler: { node_id: 'parser-main', method_name: 'main', file: 'native/parser/src/main.rs', line: 1 },
      },
      ...(cas.entry_points || []),
    ];

    const task = {
      task_type: 'orient' as const,
      instructions: 'Understand the product, architecture, and major user journeys end to end.',
    };
    const start = getAgentStartContext(cas, workspace, task) as any;
    const context = await getAgentContext(cas, workspace, task) as any;

    assert.equal(start.starting_points.entry_points[0].id, 'entry-users-create');
    assert.ok(start.starting_points.connected_nodes.every((item: any) => item.id !== 'internal-benchmark'));
    assert.equal(context.target_resolution.selected_node_id, null);
    assert.equal(context.selected_node, null);
    assert.equal(context.context_profile, 'read-only-orientation');
    assert.equal(context.execution_brief, undefined);
    assert.equal(context.validation_plan, undefined);
    assert.equal(context.file_read_plan, undefined);
    assert.ok(JSON.stringify(context).length < 12_000);
  });
});

test('agent start context carries a one-line product orientation when a product map exists', async () => {
  await withWorkspace(async workspace => {
    const startContext = getAgentStartContext(pillarFixtureCas(), workspace, {});
    assert.ok(startContext.product_orientation);
    assert.match(String(startContext.product_orientation), /Tenant-scoped user management/);
    assert.match(String(startContext.product_orientation), /2 journeys/);
    assert.match(String(startContext.product_orientation), /1 sensitive entities/);

    const bare = getAgentStartContext(fixtureCas(), workspace, {});
    assert.ok(!('product_orientation' in bare));
  });
});

function pillarFixtureCas(): CASOutput {
  const cas = fixtureCas();
  (cas as any).user_journeys = [
    {
      id: 'journey-create-user',
      name: 'Create tenant user',
      journey_kind: 'user-facing',
      entry_point_id: 'entry-users-create',
      entry: { type: 'http', name: 'POST /users', method: 'POST', path_or_trigger: '/users', handler_node_id: 'users-service' },
      steps: [
        { node_id: 'users-controller', name: 'UsersController', layer: 'entry', depth: 0 },
        { node_id: 'users-service', name: 'UsersService', layer: 'business', depth: 1 },
      ],
      terminal_effects: { entities_written: ['User'], entities_read: [], external_services: [], messages_emitted: [] },
      terminal_entities: [{ name: 'User', access: 'created', terminal_kind: 'entity' }],
      security_boundaries: [{ name: 'JWT auth', mechanism: 'jwt' }],
      tests_covering: ['src/users/users.service.spec.ts'],
      criticality: 'critical',
      call_chain_ids: [],
      exit_point_ids: [],
    },
    {
      id: 'journey-billing-export',
      name: 'Billing export',
      journey_kind: 'scheduled',
      entry_point_id: 'entry-billing-export',
      entry: { type: 'schedule', name: 'billing export' },
      steps: [{ node_id: 'billing-job', name: 'BillingJob', layer: 'business', depth: 0 }],
      terminal_effects: { entities_written: ['Invoice'], entities_read: [], external_services: [], messages_emitted: [] },
      terminal_entities: [],
      security_boundaries: [],
      tests_covering: [],
      criticality: 'low',
      call_chain_ids: [],
      exit_point_ids: [],
    },
  ];
  (cas as any).data_lineage = [
    {
      entity_id: 'entity-user',
      entity_name: 'User',
      sensitive_fields: ['email'],
      writers: [{ node_id: 'users-service', file: 'src/users/users.service.ts', via: 'create' }],
      readers: [{ node_id: 'users-controller', file: 'src/users/users.controller.ts', via: 'list' }],
      external_recipients: [],
      boundaries_crossed: [],
      journeys_carrying: ['journey-create-user'],
      exposure: { unguarded_paths: 1, external_transfer: false, sensitive: true },
    },
    {
      entity_id: 'entity-invoice',
      entity_name: 'Invoice',
      sensitive_fields: [],
      writers: [{ node_id: 'billing-job', file: 'src/billing/billing-job.ts', via: 'run' }],
      readers: [],
      external_recipients: [],
      boundaries_crossed: [],
      journeys_carrying: [],
      exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
    },
  ];
  (cas as any).paradigm_conformance = [
    {
      paradigm: 'guarded-http-entry-points',
      description: 'HTTP entry points use auth guards.',
      adoption: { following_count: 9, comparable_count: 10, adoption_rate: 0.9, evidence_files: [] },
      deviations: [
        { file: 'src/users/users.controller.ts', node_id: 'users-controller', kind: 'unguarded-entry-point', detail: 'POST /users/import lacks an auth guard.', severity: 'error' },
        { file: 'src/billing/billing-job.ts', node_id: 'billing-job', kind: 'direct-data-access', detail: 'Job queries the database directly.', severity: 'warning' },
      ],
    },
  ];
  (cas as any).product_map = {
    identity: { name: 'Fixture API', domain: 'user-management', domain_source: 'deterministic', description: 'Tenant-scoped user API', description_source: 'deterministic', unanalyzed_languages: [] },
    capabilities: [
      { name: 'Tenant-scoped user management', description: '', description_source: 'deterministic', category: 'core', criticality: 'critical', journeys: [], entities: ['User'], tests_present: true, risk_level: 'high' },
    ],
    journeys: { total: 2, user_facing: 1, system: 0, scheduled: 1, top: [] },
    data: { entities: 2, sensitive: ['User'], exposure_highlights: [] },
    conventions: { paradigms: [], open_deviations: { error: 1, warning: 1, info: 0 } },
    health: { tests: { total: 1, passing: 1, failing: 0 }, implementation: { complete: 4, partial: 0, stubs: 0, not_implemented: 0, deprecated: 0 }, top_risks: [] },
    coverage_caveats: [],
  };
  return cas;
}

test('composite test scripts are broad and never receive fabricated focused arguments', async () => {
  await withWorkspace(async workspace => {
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
      scripts: { test: 'npm run test:jest && npm run test:node', 'test:jest': 'jest', 'test:node': 'node --test "src/**/*.test.ts"' },
    }));
    const context = await getAgentContext(fixtureCas(), workspace, { task_type: 'modify', target: 'UsersService' }) as any;
    assert.equal(context.validation_plan.strategy, 'repo-script-fallback');
    assert.ok(context.validation_plan.commands.some((command: any) => command.command === 'npm test' && command.scope === 'broad-test'));
    assert.ok(context.validation_plan.commands.every((command: any) => command.scope !== 'focused-test' && !command.command.includes(' -- ')));
    assert.ok(context.validation_plan.gaps.some((gap: string) => /unverified focused-file/.test(gap)));
    assert.match(context.validation_plan.run_policy, /before executing any broad suite/);
    assert.ok(context.execution_brief.validate.every((command: string) => !command.includes('npm test')));
    const compact = await getAgentContext(fixtureCas(), workspace, { task_type: 'modify', target: 'UsersService', response_profile: 'first-turn' }) as any;
    assert.ok(!JSON.stringify(compact.execution?.validate || []).includes('npm test'));
  });
});

test('a focused sibling package does not certify a composite target test script', async () => {
  await withWorkspace(async workspace => {
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'npm run first && npm run second' } }));
    const sibling = path.join(workspace, 'packages', 'checks');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    fs.writeFileSync(path.join(sibling, 'users.service.spec.ts'), 'describe("UsersService", () => {});');
    const cas = fixtureCas();
    const target = cas.nodes.find(node => node.name === 'UsersService')!;
    cas.test_suites!.push({
      id: 'sibling-tests', name: 'Sibling checks', file_path: 'packages/checks/users.service.spec.ts',
      test_type: 'unit', framework: 'jest', tests: [], coverage: { nodes_tested: [target.id] },
    });
    const context = await getAgentContext(cas, workspace, { task_type: 'modify', target: 'UsersService' }) as any;
    assert.notEqual(context.validation_plan.strategy, 'focused-tests-first');
    assert.match(context.validation_plan.run_policy, /before executing any broad suite/);
    assert.ok(context.validation_plan.gaps.some((gap: string) => /unverified focused-file/.test(gap)));
  });
});

test('unknown JavaScript runners are not invented when no test script exists', async () => {
  await withWorkspace(async workspace => {
    fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
    const context = await getAgentContext(fixtureCas(), workspace, { task_type: 'modify', target: 'UsersService' }) as any;
    assert.equal(context.validation_plan.strategy, 'manual-validation-required');
    assert.ok(context.validation_plan.commands.every((command: any) => !command.command.startsWith('npm test')));
    assert.ok(context.validation_plan.gaps.some((gap: string) => /No focused test command/.test(gap)));
  });
});

test('malformed package script values do not crash validation planning', async () => {
  await withWorkspace(async workspace => {
    for (const value of [42, {}, null]) {
      fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: value } }));
      const context = await getAgentContext(fixtureCas(), workspace, { task_type: 'modify', target: 'UsersService' }) as any;
      assert.equal(context.validation_plan.strategy, 'manual-validation-required');
      assert.ok(context.validation_plan.gaps.length > 0);
    }
  });
});

test('filename-neighbor tests remain useful without claiming explicit target coverage', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    for (const suite of cas.test_suites || []) {
      delete suite.coverage;
      for (const item of suite.tests) delete item.targets;
    }
    const context = await getAgentContext(cas, workspace, { task_type: 'modify', target: 'UsersService' }) as any;
    assert.equal(context.validation_plan.strategy, 'focused-tests-first');
    assert.ok(context.validation_plan.commands.some((command: any) => command.scope === 'focused-test' && command.confidence < 0.9));
    assert.ok(context.validation_plan.gaps.some((gap: string) => /explicit CAS links/.test(gap)));
    assert.ok(context.validation_plan.commands.some((command: any) => command.command.includes('users.service.spec.ts')));
  });
});

async function withWorkspace(run: (workspace: string) => void | Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-agent-workflow-test-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'jest', typecheck: 'tsc --noEmit' } }));
    fs.mkdirSync(path.join(root, 'src', 'users', 'entities'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'users', 'users.service.ts'), 'export class UsersService {}\n');
    fs.writeFileSync(path.join(root, 'src', 'users', 'users.service.spec.ts'), 'describe("UsersService", () => {});\n');
    fs.writeFileSync(path.join(root, 'src', 'users', 'entities', 'user.entity.ts'), 'export class User {}\n');
    await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function fixtureCas(): CASOutput {
  return {
    id: 'analysis_test',
    version: '1.10.0',
    generated_at: new Date().toISOString(),
    system: {
      name: 'Fixture API',
      type: 'api',
      description: 'Tenant-scoped user API',
      technologies: {
        languages: [{ name: 'TypeScript', percentage: 100 }],
        frameworks: [{ name: 'NestJS' }],
        databases: [{ name: 'PostgreSQL' }],
      },
    },
    nodes: [
      node('users-service', 'UsersService', 'service', 'src/users/users.service.ts', 1),
      node('users-controller', 'UsersController', 'controller', 'src/users/users.controller.ts', 1),
      node('user-entity', 'User', 'entity', 'src/users/entities/user.entity.ts', 1),
      node('users-test', 'UsersService spec', 'test', 'src/users/users.service.spec.ts', 1),
    ],
    edges: [
      { id: 'edge-controller-service', source: 'users-controller', target: 'users-service', type: 'calls' },
      { id: 'edge-service-entity', source: 'users-service', target: 'user-entity', type: 'uses' },
      { id: 'edge-test-service', source: 'users-test', target: 'users-service', type: 'tests' },
    ],
    entry_points: [
      { id: 'entry-users-create', name: 'POST /users', type: 'http', source_node: 'users-controller', handler: { node_id: 'users-service', name: 'create' } },
    ],
    exit_points: [
      { id: 'exit-user-db', name: 'User data access', type: 'database', source_node: 'users-service' },
    ],
    analyzer_contributions: [
      { analyzer_name: 'fixture', nodes_created: 4, edges_created: 3 },
    ],
    architecture_summary: {
      system_type: 'api',
      total_files: 4,
      architectural_patterns: [
        {
          name: 'Service Layer',
          category: 'business-logic',
          confidence: 0.9,
          evidence: ['1 service/use-case node'],
          node_ids: ['users-service'],
          guidance: 'Put business rules in services/use-cases and keep entry points thin.',
        },
        {
          name: 'Repository',
          category: 'data-access',
          confidence: 0.72,
          evidence: ['entity-backed data access'],
          node_ids: ['user-entity'],
          guidance: 'Use the repository/store layer for persistence access instead of reaching into storage from controllers or UI code.',
        },
      ],
      architectural_inventory: {
        models: ['user-entity'],
        views: [],
        controllers: ['users-controller'],
        view_models: [],
        services: ['users-service'],
        repositories: [],
        clients: [],
        mediators: [],
        unit_of_work: [],
        singletons: [],
        scripts: [],
        packages: [],
      },
      pattern_balance: {
        status: 'balanced',
        detected_count: 2,
        risks: [],
        recommendations: ['Use detected patterns as placement guidance, then verify against local examples and tests.'],
      },
      layers: {
        presentation: { controllers: 1, endpoints: 1 },
        business: { services: 1 },
        data: { entities: 1 },
      },
    },
    test_suites: [
      {
        id: 'suite-users-service',
        name: 'UsersService',
        file_path: 'src/users/users.service.spec.ts',
        test_type: 'unit',
        framework: 'jest',
        tests: [{ id: 'test-create-user', name: 'creates tenant-scoped user', test_type: 'unit', assertions: [] }],
      },
    ],
    codebase_idioms: [
      {
        id: 'idiom-testing',
        category: 'testing',
        name: 'Tests use spec files beside services',
        description: 'Service behavior is covered by colocated spec files.',
        confidence: 0.92,
        prevalence: 1,
        evidence: [{ type: 'file', file: 'src/users/users.service.spec.ts', description: 'colocated service spec' }],
        positive_examples: [{ idiom_id: 'idiom-testing', name: 'UsersService spec', file: 'src/users/users.service.spec.ts', line: 1, explanation: 'Tests live beside the service.' }],
        affected_scopes: { files: ['src/users/users.service.ts'], file_globs: ['src/**/*.service.ts'], node_ids: ['users-service'], node_types: ['service'] },
        agent_guidance: {
          do: ['Update or add focused colocated spec files for service behavior changes.'],
          avoid: ['Do not change service behavior without checking nearby specs.'],
          validation: ['Run validate_codebase_idioms after edits.'],
        },
        deviations: [],
      },
      {
        id: 'idiom-migrations',
        category: 'migrations',
        name: 'Schema changes go through migrations',
        description: 'Entity changes require migration coverage.',
        confidence: 0.9,
        prevalence: 1,
        evidence: [{ type: 'file', file: 'src/users/entities/user.entity.ts', description: 'entity file' }],
        positive_examples: [{ idiom_id: 'idiom-migrations', name: 'User entity', file: 'src/users/entities/user.entity.ts', line: 1, explanation: 'Persisted entity.' }],
        affected_scopes: { files: ['src/users/entities/user.entity.ts'], file_globs: ['src/**/entities/*.ts'], node_ids: ['user-entity'], node_types: ['entity'] },
        agent_guidance: {
          do: ['Add or update a migration when changing persisted entity shape.'],
          avoid: ['Do not edit entities without migration review.'],
          validation: ['Run validate_codebase_idioms and validate_behavioral_invariants.'],
        },
        deviations: [],
      },
    ],
    idiom_examples: [],
    idiom_summary: {
      total: 2,
      high_confidence: 2,
      violations: 0,
      by_category: { testing: 1, migrations: 1 },
      top_idioms: ['idiom-testing', 'idiom-migrations'],
    },
    behavioral_invariants: [
      {
        id: 'invariant-user-tenant',
        name: 'User tenant scope',
        invariant_type: 'tenant-scope',
        description: 'User reads and writes must preserve organization scope.',
        confidence: 'high',
        scope: {
          file_paths: ['src/users/users.service.ts', 'src/users/entities/user.entity.ts'],
          node_ids: ['users-service', 'user-entity'],
          entity_names: ['User'],
          field_names: ['organizationId'],
        },
        enforcement: [{ type: 'service', file: 'src/users/users.service.ts', node_id: 'users-service', description: 'service enforces tenant filter' }],
        evidence: [{ source: 'node', id: 'users-service', file: 'src/users/users.service.ts', line: 1 }],
        related_tests: ['src/users/users.service.spec.ts'],
        related_boundaries: [],
        related_entities: ['User'],
        gaps: [],
      },
    ],
    change_risks: [
      {
        node_id: 'users-service',
        risk_level: 'high',
        risk_factors: [
          { factor: 'security-sensitive', severity: 'high', details: 'Creates tenant-scoped users.' },
          { factor: 'critical-path', severity: 'medium', details: 'Backs the POST /users entry point.' },
        ],
        downstream_impact: {
          direct_callers: ['users-controller'],
          transitive_callers: [],
          affected_call_chains: [],
          affected_entry_points: ['entry-users-create'],
        },
        test_protection: {
          has_direct_tests: true,
          has_integration_tests: false,
          test_ids: ['test-create-user'],
        },
        stability_context: {
          recent_churn: false,
          commit_count_30d: 0,
          bug_fix_density: 0,
        },
        recommendations: ['Inspect tenant-scope tests before changing user creation.'],
      },
    ],
    change_risk_summary: {
      high_risk_nodes: ['users-service'],
      untested_critical_paths: [],
      recent_hotspots: [],
    },
    capabilities: [
      {
        id: 'capability-users',
        name: 'Tenant-scoped user management',
        description: 'Creates and manages users while preserving organization tenant scope.',
        category: 'core',
        operations: [
          {
            entry_point_id: 'entry-users-create',
            entry_point_type: 'http',
            action: 'create tenant-scoped user',
            path_or_command: 'src/users/users.service.ts',
          },
        ],
        related_entities: ['User'],
        related_domains: ['users', 'tenant-scope'],
        criticality: 'critical',
        criticality_factors: ['tenant scope'],
      },
    ],
    analysis_errors: [],
  } as unknown as CASOutput;
}

function node(id: string, name: string, type: string, file: string, line: number) {
  return {
    id,
    name,
    type,
    category: type === 'test' ? 'test' : 'code',
    source: { file, line },
  };
}
