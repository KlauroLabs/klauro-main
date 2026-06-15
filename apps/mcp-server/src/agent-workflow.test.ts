import test from 'node:test';
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
import { buildArchitectureContextForAgent, evaluateAgentReadiness, formatExecutionCapsule, getAgentStartContext, getAgentToolPlan, getAgentWorkPacket } from './agent-adoption';
import { benchmarkAgentContextCodecs, formatAgentContextCapsule, parseAgentContextCapsule } from './agent-context-codec';
import { ingestTelemetryBatch } from './telemetry-ingestion';

test('openAgentWorkbench returns a product-level packet for agent work', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    const packet = await openAgentWorkbench(cas, workspace, {
      task_type: 'modify',
      target: 'UsersService',
      instructions: 'Change user creation behavior',
    });

    assert.equal(packet.product, 'agent_workbench');
    assert.equal(packet.task_packet.selected_node?.name, 'UsersService');
    assert.ok(packet.task_packet.file_read_plan.some((item: any) => item.file === 'src/users/users.service.ts'));
    assert.equal(packet.task_packet.work_context.capability_memory.status, 'possible-existing-capability');
    assert.ok(packet.task_packet.work_context.capability_memory.reuse_decisions_required.some((decision: any) =>
      decision.existing_capability === 'Tenant-scoped user management'
    ));
    assert.ok(packet.task_packet.work_context.architecture_context.architecture_budget.includes('Service Layer'));
    assert.ok(packet.task_packet.work_context.risk_context.target_risk);
    assert.equal(packet.task_packet.work_context.risk_context.target_risk.name, 'UsersService');
    assert.ok(packet.task_packet.work_context.risk_context.agent_rules.some((rule: string) => rule.includes('assess_change_risk')));
    assert.equal(packet.task_packet.execution_brief.mode, 'minimal-execution');
    assert.ok(packet.task_packet.execution_brief.read_first.includes('src/users/users.service.ts'));
    assert.ok(packet.task_packet.execution_brief.token_policy.source_files <= 5);
    assert.match(packet.task_packet.execution_brief.stop_rule, /stop/i);
    assert.match(packet.task_packet.execution_brief.capsule, /^K5\|m\|/);
    assert.ok(packet.task_packet.execution_brief.capsule.length < JSON.stringify(packet.task_packet.execution_brief).length / 2);
    assert.ok(packet.agent_rules.idiom_rules.some((rule: any) => rule.category === 'testing'));
    assert.equal(packet.signal_quality.overall, 'partial');
    assert.ok(packet.signal_quality.warnings.some((warning: string) => warning.includes('reusable patterns')));
    assert.ok(packet.evidence_policy.must_confirm_in_source.length > 0);
  });
});

test('first-turn work packets include a compact K15 context capsule that agents can execute without broad JSON', async () => {
  await withWorkspace(async workspace => {
    const packet = await getAgentWorkPacket(fixtureCas(), workspace, {
      task_type: 'modify',
      target: 'UsersService',
      instructions: 'Change tenant-scoped user creation behavior.',
      response_profile: 'first-turn',
    }) as any;

    assert.equal(packet.context_capsule.format, 'K15');
    assert.match(packet.context_capsule.capsule, /^K15m[A-Za-z0-9]* UsersService/m);
    assert.match(packet.context_capsule.capsule, /^I/m);
    assert.match(packet.context_capsule.capsule, /^V/m);
    assert.ok(packet.context_capsule.estimated_tokens < Math.ceil(JSON.stringify(packet).length / 4));

    const parsed = parseAgentContextCapsule(packet.context_capsule.capsule);
    assert.equal(parsed.version, 'K15');
    assert.ok(parsed.files.some(file => file.includes('src/users/users.service.ts')));
    assert.ok(parsed.rules.some(rule => /idioms|risk|reuse|F/i.test(rule)));
  });
});

test('capsule-only work packets avoid expanded JSON when token savings matter most', async () => {
  await withWorkspace(async workspace => {
    const firstTurn = await getAgentWorkPacket(fixtureCas(), workspace, {
      task_type: 'modify',
      target: 'UsersService',
      instructions: 'Change tenant-scoped user creation behavior.',
      response_profile: 'first-turn',
    }) as any;
    const capsuleOnly = await getAgentWorkPacket(fixtureCas(), workspace, {
      task_type: 'modify',
      target: 'UsersService',
      instructions: 'Change tenant-scoped user creation behavior.',
      response_profile: 'capsule-only',
    }) as any;

    assert.equal(capsuleOnly.packet_profile, 'capsule-only');
    assert.match(capsuleOnly.context_capsule, /^K15m[A-Za-z0-9]* UsersService/m);
    assert.match(capsuleOnly.execution_capsule, /^K5\|m\|UsersService/m);
    assert.ok(Array.isArray(capsuleOnly.files));
    assert.ok(!('work_context' in capsuleOnly));
    assert.ok(!('file_read_plan' in capsuleOnly));
    assert.ok(capsuleOnly.estimated_tokens < Math.ceil(JSON.stringify(firstTurn).length / 4) / 2);
  });
});

test('agent work packets include telemetry-backed operational priorities for debug/runtime tasks', async () => {
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

      const packet = await getAgentWorkPacket(cas, workspace, {
        task_type: 'debug',
        target: 'what bugs should I address today',
        instructions: 'Use runtime impact to pick the most important bug and preserve local idioms.',
      }) as any;

      assert.equal(packet.work_context.operational_priorities.status, 'ready');
      assert.equal(packet.work_context.operational_priorities.sources.ingested, 1);
      assert.equal(packet.work_context.operational_priorities.priorities[0].source, 'ingested');
      assert.equal(packet.work_context.operational_priorities.priorities[0].runtime.errors, 1);
      assert.equal(packet.work_context.operational_priorities.priorities[0].runtime.estimated_volume, 42);
      const operationalTarget = packet.work_context.operational_priorities.priorities[0].static_target ||
        packet.work_context.operational_priorities.priorities[0].target;
      assert.match(operationalTarget.file, /users\.service\.ts/);
      assert.ok(packet.next_mcp_calls.some((call: any) => call.tool === 'get_operational_priorities'));

      const capsuleOnly = await getAgentWorkPacket(cas, workspace, {
        task_type: 'debug',
        target: 'what bugs should I address today',
        instructions: 'Use runtime impact to pick the most important bug and preserve local idioms.',
        response_profile: 'capsule-only',
      }) as any;
      assert.match(capsuleOnly.context_capsule, /ops .*runtime/);
      assert.match(capsuleOnly.context_capsule, /1err/);
    } finally {
      if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
      else process.env.KLAURO_STORAGE_PATH = previousStorage;
      fs.rmSync(storageRoot, { recursive: true, force: true });
    }
  });
});

test('K15 agent context language beats JSON-like and binary cache formats on balanced agent-use score', () => {
  const compact = {
    packet_profile: 'first-turn',
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
  assert.equal(benchmark.recommendation, 'k15-agent-context-language');
  const k15 = benchmark.results.find(result => result.name === 'k15-agent-context-language')!;
  const k14 = benchmark.results.find(result => result.name === 'k14-agent-context-language')!;
  const k13 = benchmark.results.find(result => result.name === 'k13-agent-context-language')!;
  const k12 = benchmark.results.find(result => result.name === 'k12-agent-context-language')!;
  const k11 = benchmark.results.find(result => result.name === 'k11-agent-context-language')!;
  const k10 = benchmark.results.find(result => result.name === 'k10-agent-context-language')!;
  const k9 = benchmark.results.find(result => result.name === 'k9-agent-context-language')!;
  const k8 = benchmark.results.find(result => result.name === 'k8-agent-context-language')!;
  const k7 = benchmark.results.find(result => result.name === 'k7-agent-context-language')!;
  const k6 = benchmark.results.find(result => result.name === 'k6-context-capsule')!;
  const minJson = benchmark.results.find(result => result.name === 'min-json')!;
  const gzip = benchmark.results.find(result => result.name === 'gzip-k7-base64')!;
  const messagePack = benchmark.results.find(result => result.name === 'messagepack-base64-proxy')!;

  assert.ok(k15.estimated_tokens < minJson.estimated_tokens);
  assert.ok(k15.estimated_tokens < k14.estimated_tokens);
  assert.ok(k15.estimated_tokens < k13.estimated_tokens);
  assert.ok(k15.estimated_tokens < k12.estimated_tokens);
  assert.ok(k15.estimated_tokens < k11.estimated_tokens);
  assert.ok(k15.estimated_tokens < k10.estimated_tokens);
  assert.ok(k15.estimated_tokens < k9.estimated_tokens);
  assert.ok(k15.estimated_tokens < k8.estimated_tokens);
  assert.ok(k15.estimated_tokens < k7.estimated_tokens);
  assert.ok(k15.estimated_tokens < k6.estimated_tokens);
  assert.ok(k15.token_reduction_vs_min_json > k14.token_reduction_vs_min_json);
  assert.ok(k15.promptish_tokens < minJson.promptish_tokens);
  assert.ok(k15.promptish_tokens < k14.promptish_tokens);
  assert.ok(k15.promptish_tokens < k13.promptish_tokens);
  assert.ok(k15.promptish_tokens < k12.promptish_tokens);
  assert.ok(k15.promptish_tokens < k11.promptish_tokens);
  assert.ok(k15.promptish_token_reduction_vs_min_json > k14.promptish_token_reduction_vs_min_json);
  assert.ok(k15.context_slots_per_100_promptish_tokens > k14.context_slots_per_100_promptish_tokens);
  assert.ok(k15.balanced_score > gzip.balanced_score);
  assert.ok(k15.balanced_score > messagePack.balanced_score);
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

test('agent work packet exposes compact risk context for broad tasks before a node is selected', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    const packet = await getAgentWorkPacket(cas, workspace, {
      task_type: 'modify',
      target: 'improve account safety behavior',
    });

    assert.equal(packet.work_context.risk_context.status, 'ready');
    assert.ok(packet.work_context.risk_context.summary.total_high_risk_nodes >= 1);
    assert.ok(packet.work_context.risk_context.repo_top_risks.some((risk: any) => risk.name === 'UsersService'));
    assert.ok(packet.work_context.risk_context.agent_rules.some((rule: string) => rule.includes('repo_top_risks')));
  });
});

test('agent work packet prioritizes documentation files for documentation tasks', async () => {
  await withWorkspace(async workspace => {
    fs.mkdirSync(path.join(workspace, 'docs', 'mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'docs', 'mcp', 'ANALYSIS-PERFECTION-AUDIT.md'),
      '# Analysis Perfection Audit\n\nCurrent proof evidence.\n',
    );
    const cas = fixtureCas();
    cas.system = { ...cas.system, root_path: workspace } as any;

    const packet = await getAgentWorkPacket(cas, workspace, {
      task_type: 'modify',
      target: 'analysis perfection audit documentation and MCP work packet evidence',
    });

    assert.equal(packet.selected_node, null);
    assert.equal(packet.file_read_plan[0]?.file, 'docs/mcp/ANALYSIS-PERFECTION-AUDIT.md');
    assert.match(packet.file_read_plan[0]?.reason || '', /task hint related file/);
  });
});

test('agent work packet treats audit proof targets as documentation-first', async () => {
  await withWorkspace(async workspace => {
    fs.mkdirSync(path.join(workspace, 'docs', 'mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'docs', 'mcp', 'ANALYSIS-PERFECTION-AUDIT.md'),
      '# Analysis Perfection Audit\n\nStorage maintenance MCP proof evidence.\n',
    );
    const cas = fixtureCas();
    cas.system = { ...cas.system, root_path: workspace } as any;
    cas.nodes.push(node('coverage-evidence', 'evidence', 'function', 'apps/mcp-server/src/agent-task-family-coverage.ts', 825));

    const packet = await getAgentWorkPacket(cas, workspace, {
      task_type: 'modify',
      target: 'storage maintenance MCP tools and analysis perfection audit evidence',
    });

    assert.equal(packet.selected_node, null);
    assert.equal(packet.file_read_plan[0]?.file, 'docs/mcp/ANALYSIS-PERFECTION-AUDIT.md');
  });
});

test('agent work packet does not treat docs-heavy inference tasks as documentation edits', async () => {
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

    const packet = await getAgentWorkPacket(cas, workspace, {
      task_type: 'modify',
      target: 'adversarial domain profile inference docs heavy SDK embedded examples monorepo product summary',
    });

    assert.notEqual(packet.selected_node, null);
    assert.ok(
      ['DomainExtractor', 'classifyAnalysisProfile'].includes(packet.selected_node?.name || ''),
      `expected analyzer source target, got ${packet.selected_node?.name || 'none'}`,
    );
    assert.ok(!packet.file_read_plan[0]?.file.endsWith('.md'));
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

test('agent work packet scopes architecture examples to selected target even when task hints add related files', async () => {
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

    const packet = await getAgentWorkPacket(cas, workspace, {
      task_type: 'modify',
      target: 'UsersService',
      instructions: 'Adjust authenticated user creation while preserving auth/session policy boundaries.',
    }) as any;

    assert.match(packet.file_read_plan[0].reason, /selected target/);
    assert.match(packet.file_read_plan[0].reason, /representative entry point/);
    assert.ok(packet.file_read_plan.some((item: any) => item.file === 'src/auth/auth.service.ts' && /task hint/.test(item.reason)));

    const examples = [
      ...Object.values(packet.work_context.architecture_context.inventory_examples || {}).flatMap((items: any) => items || []),
      ...Object.values(packet.work_context.architecture_context.relevant_inventory || {}).flatMap((items: any) => items || []),
      ...packet.work_context.architecture_context.pattern_decision_matrix.flatMap((row: any) => row.examples || []),
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

test('small-repo work packets retain compact architecture decision context', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.nodes = cas.nodes.slice(0, 3);
    cas.edges = cas.edges.slice(0, 2);
    cas.test_suites = [];

    const packet = await getAgentWorkPacket(cas, workspace, {
      task_type: 'modify',
      target: 'UsersService',
      instructions: 'Make a small service change.',
    });

    const compactPacket = packet as any;
    assert.match(compactPacket.packet_profile || '', /small-repo-minimal|micro-repo|token-minimal/);
    assert.ok(compactPacket.work_context.architecture_context);
    assert.ok(compactPacket.work_context.architecture_context.pattern_decision_matrix.length > 0);
    assert.ok(compactPacket.work_context.architecture_context.agent_rules.some((rule: string) => /architectural style|pattern/i.test(rule)));
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

test('agent work packet honors explicit file path targets before semantic fallback', async () => {
  await withWorkspace(async workspace => {
    const packet = await getAgentWorkPacket(fixtureCas(), workspace, {
      task_type: 'modify',
      target: 'src/users/entities/user.entity.ts',
      instructions: 'Change the persisted User shape.',
    });

    assert.equal(packet.selected_node?.name, 'User');
    assert.equal(packet.file_read_plan[0].file, 'src/users/entities/user.entity.ts');
    assert.ok(packet.target_resolution.candidates.every((candidate: any) =>
      candidate.file === 'src/users/entities/user.entity.ts' || candidate.score < 250
    ));
  });
});

test('agent work packet surfaces target-scoped AI description enrichment only when narrative is weak', async () => {
  await withWorkspace(async workspace => {
    const packet = await getAgentWorkPacket(fixtureCas(), workspace, {
      task_type: 'modify',
      target: 'UsersService',
      instructions: 'Explain and adjust user creation behavior without broad exploration.',
    }) as any;

    assert.equal(packet.work_context.description_context.status, 'target-description-needs-ai');
    assert.equal(packet.work_context.description_context.target.id, 'users-service');
    assert.ok(packet.work_context.description_context.reasons.some((reason: string) => /missing|source/.test(reason)));
    assert.ok(packet.next_mcp_calls.some((call: any) =>
      call.tool === 'generate_element_description' &&
      call.args.target === 'users-service' &&
      call.args.target_kind === 'service'
    ));

    const capsule = await getAgentWorkPacket(fixtureCas(), workspace, {
      task_type: 'modify',
      target: 'UsersService',
      instructions: 'Explain and adjust user creation behavior without broad exploration.',
      response_profile: 'capsule-only',
    }) as any;
    assert.match(capsule.context_capsule, /desc UsersService/);
  });
});

test('agent work packet ignores generic capability suffixes when resolving targets', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.nodes.push(
      node('payments-service', 'PaymentsService', 'service', 'src/payments/payments.service.ts', 1),
      node('portfolio-management-service', 'PortfolioManagementService', 'service', 'src/business/services/portfolio-management/portfolio-management.service.ts', 1),
    );

    const packet = await getAgentWorkPacket(cas, workspace, {
      task_type: 'modify',
      target: 'Payments Management',
      instructions: 'Make a small idiomatic change without duplicating existing behavior.',
    });

    assert.equal(packet.selected_node?.name, 'PaymentsService');
    assert.equal(packet.file_read_plan[0].file, 'src/payments/payments.service.ts');
  });
});

test('agent work packet prefers active analyzer source over legacy lexical matches for analyzer maintenance', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    cas.nodes.push(
      node('legacy-analyzer-method', 'analyzer', 'method', 'legacy/database/typescript/database-client.ts', 111) as any,
      node('language-analyzer-method', 'analyze', 'method', 'packages/analyzer-core/src/analyzer/languages/typescript-javascript-analyzer.ts', 326) as any,
      node('active-capability-summary', 'buildQuickDescription', 'method', 'packages/analyzer-core/src/analyzer/core/orchestrator.ts', 6660) as any,
    );

    const packet = await getAgentWorkPacket(cas, workspace, {
      task_type: 'modify',
      target: 'capability summaries analyzer usefulness review',
      instructions: 'Improve CAS capability summaries and analysis usefulness review output.',
    });

    assert.equal(packet.selected_node?.name, 'buildQuickDescription');
    assert.equal(packet.file_read_plan[0].file, 'packages/analyzer-core/src/analyzer/core/orchestrator.ts');
  });
});

test('agent work packet resolves exact module filenames from the working tree before stale semantic matches', async () => {
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

    const packet = await getAgentWorkPacket(cas, workspace, {
      task_type: 'modify',
      target: 'description-enrichment',
      instructions: 'Improve manual AI description enrichment without broad file exploration.',
    });

    assert.equal(packet.file_read_plan[0].file, 'apps/mcp-server/src/description-enrichment.ts');
    assert.equal(packet.selected_node, null);
    assert.ok(packet.target_resolution.gaps.some((gap: string) => gap.includes('no CAS node resolved')));
  });
});

test('agent work packet keeps task-hint files out of architecture placement guidance', async () => {
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

    const packet = await getAgentWorkPacket(cas, workspace, {
      task_type: 'modify',
      target: 'buildQuickDescription',
      instructions: 'Improve analyzer output without changing auth.',
    });

    const examples = [
      ...Object.values(packet.work_context.architecture_context.inventory_examples || {}).flatMap((items: any) => items || []),
      ...Object.values(packet.work_context.architecture_context.relevant_inventory || {}).flatMap((items: any) => items || []),
    ] as any[];
    assert.ok(examples.some((example: any) => String(example.file || '').includes('src/analyzer')));
    assert.ok(examples.every((example: any) => !String(example.file || '').includes('src/auth')));
  });
});

test('agent work packet infers focused tests from the workspace when CAS test links are missing', async () => {
  await withWorkspace(async workspace => {
    const cas = fixtureCas();
    delete (cas as any).test_suites;
    cas.edges = (cas.edges || []).filter(edge => edge.type !== 'tests');

    const packet = await getAgentWorkPacket(cas, workspace, {
      task_type: 'modify',
      target: 'src/users/users.service.ts',
      instructions: 'Change service behavior without broad test exploration.',
    });

    assert.equal(packet.validation_plan.strategy, 'focused-tests-first');
    assert.ok(packet.validation_plan.tests_to_inspect.some((testFile: any) =>
      testFile.file === 'src/users/users.service.spec.ts'
    ));
    assert.ok(packet.validation_plan.commands.some((command: any) =>
      command.scope === 'focused-test' && command.command.includes('src/users/users.service.spec.ts')
    ));
  });
});

test('agent work packet excludes Klauro proof artifacts from task-hint source files', async () => {
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

    const packet = await getAgentWorkPacket(cas, workspace, {
      task_type: 'modify',
      target: 'audit task domain model',
      instructions: 'Add audit domain behavior without reading generated proof artifacts.',
    });

    const files = packet.file_read_plan.map((item: any) => item.file);
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

test('readiness, start context, and work packet surface dominant unanalyzed languages', async () => {
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
    assert.equal(readiness.default_use, false);

    const expectedNote = 'Ruby is 79% of source (289 files) but not analyzed; CAS covers only the analyzed remainder. Fall back to direct file reading for the Ruby portion.';
    const context = getAgentStartContext(cas, workspace);
    assert.equal(context.readiness.language_coverage_note, expectedNote);

    const packet = await getAgentWorkPacket(cas, workspace, { task_type: 'orient' });
    assert.equal(packet.readiness.language_coverage_note, expectedNote);
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

test('agent work packet carries target-scoped pillar digests when pillar data touches the target', async () => {
  await withWorkspace(async workspace => {
    const cas = pillarFixtureCas();
    const packet = await getAgentWorkPacket(cas, workspace, {
      task_type: 'modify',
      target: 'UsersService',
    });

    const journeyContext = packet.work_context.journey_context;
    assert.ok(journeyContext, 'journey_context missing');
    assert.equal(journeyContext.total_matching, 1);
    assert.equal(journeyContext.journeys[0].id, 'journey-create-user');
    assert.equal(journeyContext.journeys[0].kind, 'user-facing');
    assert.ok(journeyContext.journeys[0].boundaries.includes('JWT auth'));
    assert.equal(journeyContext.journeys[0].tests, 1);
    assert.ok(!journeyContext.journeys.some((journey: any) => journey.id === 'journey-billing-export'));

    const lineageContext = packet.work_context.lineage_context;
    assert.ok(lineageContext, 'lineage_context missing');
    assert.equal(lineageContext.total_matching, 1);
    assert.equal(lineageContext.entities[0].entity, 'User');
    assert.equal(lineageContext.entities[0].access, 'writes');
    assert.equal(lineageContext.entities[0].sensitive, true);
    assert.deepEqual(lineageContext.entities[0].sensitive_fields, ['email']);
    assert.ok(!lineageContext.entities.some((entity: any) => entity.entity === 'Invoice'));

    const conformanceContext = packet.work_context.conformance_context;
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

test('agent work packet bounds journey digests and reports the true match count', async () => {
  await withWorkspace(async workspace => {
    const cas = pillarFixtureCas();
    const journeys = (cas as any).user_journeys;
    const base = journeys[0];
    for (let index = 0; index < 7; index += 1) {
      journeys.push({ ...base, id: `journey-extra-${index}`, name: `Extra user flow ${index}`, criticality: 'medium' });
    }
    const packet = await getAgentWorkPacket(cas, workspace, {
      task_type: 'modify',
      target: 'UsersService',
    });
    const journeyContext = packet.work_context.journey_context;
    assert.ok(journeyContext);
    assert.equal(journeyContext.total_matching, 8);
    assert.ok(journeyContext.journeys.length <= 5);
    assert.equal(journeyContext.journeys[0].id, 'journey-create-user');
    assert.ok(JSON.stringify(journeyContext.journeys).length <= 600);
  });
});

test('agent work packet pillar digests match entity targets through terminal entities and lineage rows', async () => {
  await withWorkspace(async workspace => {
    const cas = pillarFixtureCas();
    (cas as any).data_lineage[0].writers = [];
    (cas as any).data_lineage[0].readers = [];
    const packet = await getAgentWorkPacket(cas, workspace, {
      task_type: 'modify',
      target: 'User',
    });
    assert.equal(packet.selected_node?.name, 'User');
    const journeyContext = packet.work_context.journey_context;
    assert.ok(journeyContext, 'journey_context missing for entity target');
    assert.equal(journeyContext.journeys[0].id, 'journey-create-user');
    const lineageContext = packet.work_context.lineage_context;
    assert.ok(lineageContext, 'lineage_context missing for entity target');
    assert.equal(lineageContext.entities[0].entity, 'User');
    assert.equal(lineageContext.entities[0].access, 'target-entity');
  });
});

test('agent work packet omits pillar digests when no pillar data exists', async () => {
  await withWorkspace(async workspace => {
    const packet = await getAgentWorkPacket(fixtureCas(), workspace, {
      task_type: 'modify',
      target: 'UsersService',
    });
    assert.ok(!('journey_context' in packet.work_context));
    assert.ok(!('lineage_context' in packet.work_context));
    assert.ok(!('conformance_context' in packet.work_context));
  });
});

test('agent work packet omits pillar digests when pillar data exists but misses the target', async () => {
  await withWorkspace(async workspace => {
    const cas = pillarFixtureCas();
    (cas as any).user_journeys = [(cas as any).user_journeys[1]];
    (cas as any).data_lineage = [(cas as any).data_lineage[1]];
    (cas as any).paradigm_conformance[0].deviations = (cas as any).paradigm_conformance[0].deviations.filter(
      (deviation: any) => deviation.file.startsWith('src/billing/'),
    );
    const packet = await getAgentWorkPacket(cas, workspace, {
      task_type: 'modify',
      target: 'UsersService',
    });
    assert.ok(!('journey_context' in packet.work_context));
    assert.ok(!('lineage_context' in packet.work_context));
    assert.ok(!('conformance_context' in packet.work_context));
  });
});

test('compacted work packets preserve pillar digests', async () => {
  for (const profile of ['small-repo-minimal', 'token-minimal', 'tiny', 'micro']) {
    await withWorkspace(async workspace => {
      const previous = process.env.KLAURO_AGENT_PACKET_PROFILE;
      process.env.KLAURO_AGENT_PACKET_PROFILE = profile;
      try {
        const packet = await getAgentWorkPacket(pillarFixtureCas(), workspace, {
          task_type: 'modify',
          target: 'UsersService',
        });
        assert.ok(packet.work_context.journey_context, `${profile}: journey_context dropped`);
        assert.equal(packet.work_context.journey_context.journeys[0].id, 'journey-create-user');
        assert.ok(packet.work_context.lineage_context, `${profile}: lineage_context dropped`);
        assert.equal(packet.work_context.lineage_context.entities[0].entity, 'User');
        assert.ok(packet.work_context.conformance_context, `${profile}: conformance_context dropped`);
        assert.equal(packet.work_context.conformance_context.deviations[0].severity, 'error');
      } finally {
        if (previous === undefined) delete process.env.KLAURO_AGENT_PACKET_PROFILE;
        else process.env.KLAURO_AGENT_PACKET_PROFILE = previous;
      }
    });
  }
});

test('compacted work packets do not invent pillar digests when data is absent', async () => {
  await withWorkspace(async workspace => {
    const previous = process.env.KLAURO_AGENT_PACKET_PROFILE;
    process.env.KLAURO_AGENT_PACKET_PROFILE = 'small-repo-minimal';
    try {
      const packet = await getAgentWorkPacket(fixtureCas(), workspace, {
        task_type: 'modify',
        target: 'UsersService',
      });
      assert.ok(!('journey_context' in packet.work_context));
      assert.ok(!('lineage_context' in packet.work_context));
      assert.ok(!('conformance_context' in packet.work_context));
    } finally {
      if (previous === undefined) delete process.env.KLAURO_AGENT_PACKET_PROFILE;
      else process.env.KLAURO_AGENT_PACKET_PROFILE = previous;
    }
  });
});

test('start context and work packet lead with the sensitive-data exposure digest', async () => {
  await withWorkspace(async workspace => {
    const cas = pillarFixtureCas();
    const expectedLine = 'User: 1 unguarded paths, external_transfer: false, sensitive fields: email';

    const context = getAgentStartContext(cas, workspace, {});
    const exposure = (context as any).sensitive_data_exposure;
    assert.ok(exposure, 'sensitive_data_exposure missing from start context');
    assert.equal(exposure.total_exposed_entities, 1);
    assert.deepEqual(exposure.highest_risk, [expectedLine]);
    assert.match(exposure.instruction, /before answering security/);
    assert.equal(Object.keys(exposure)[0], 'instruction');
    const contextKeys = Object.keys(context);
    assert.ok(contextKeys.indexOf('sensitive_data_exposure') < contextKeys.indexOf('readiness'),
      'exposure digest should precede readiness in the start context');

    const packet = await getAgentWorkPacket(cas, workspace, { task_type: 'modify', target: 'UsersService' });
    const packetExposure = (packet as any).sensitive_data_exposure;
    assert.ok(packetExposure, 'sensitive_data_exposure missing from work packet');
    assert.deepEqual(packetExposure.highest_risk, [expectedLine]);
    const packetKeys = Object.keys(packet);
    assert.ok(packetKeys.indexOf('sensitive_data_exposure') < packetKeys.indexOf('work_context'),
      'exposure digest should precede work_context in the packet');

    const lineageContext = packet.work_context.lineage_context;
    assert.ok(lineageContext, 'lineage_context missing');
    assert.equal(Object.keys(lineageContext)[0], 'headline');
    assert.equal(lineageContext.headline, expectedLine);
    assert.match(String(lineageContext.instruction), /before answering security/);
    const workContextKeys = Object.keys(packet.work_context);
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
    const context = getAgentStartContext(cas, workspace, {});
    const exposure = (context as any).sensitive_data_exposure;
    assert.ok(exposure, 'sensitive_data_exposure missing from start context');
    assert.deepEqual(exposure.highest_risk, [
      'User: 26 unguarded paths (22 with non-auth guards only), external_transfer: false, sensitive fields: email',
    ]);

    const packet = await getAgentWorkPacket(cas, workspace, { task_type: 'modify', target: 'UsersService' });
    const lineageContext = packet.work_context.lineage_context;
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
    const context = getAgentStartContext(cas, workspace, {});
    assert.ok(!('sensitive_data_exposure' in context));

    const packet = await getAgentWorkPacket(cas, workspace, { task_type: 'modify', target: 'UsersService' });
    assert.ok(!('sensitive_data_exposure' in packet));
    const lineageContext = packet.work_context.lineage_context;
    assert.ok(lineageContext, 'lineage_context should still match the target');
    assert.ok(!('headline' in lineageContext));
    assert.ok(!('instruction' in lineageContext));
  });
});

test('compacted work packets preserve the exposure digest and lineage headline', async () => {
  for (const profile of ['small-repo-minimal', 'token-minimal', 'tiny', 'micro']) {
    await withWorkspace(async workspace => {
      const previous = process.env.KLAURO_AGENT_PACKET_PROFILE;
      process.env.KLAURO_AGENT_PACKET_PROFILE = profile;
      try {
        const packet = await getAgentWorkPacket(pillarFixtureCas(), workspace, {
          task_type: 'modify',
          target: 'UsersService',
        });
        assert.ok((packet as any).sensitive_data_exposure, `${profile}: sensitive_data_exposure dropped`);
        const lineageContext = packet.work_context.lineage_context;
        assert.ok(lineageContext, `${profile}: lineage_context dropped`);
        assert.equal(lineageContext.headline, 'User: 1 unguarded paths, external_transfer: false, sensitive fields: email', `${profile}: lineage headline dropped`);
        assert.match(String(lineageContext.instruction), /before answering security/, `${profile}: lineage instruction dropped`);
      } finally {
        if (previous === undefined) delete process.env.KLAURO_AGENT_PACKET_PROFILE;
        else process.env.KLAURO_AGENT_PACKET_PROFILE = previous;
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
    system_capabilities: [
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
