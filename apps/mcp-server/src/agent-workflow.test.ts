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
    assert.ok(packet.agent_rules.idiom_rules.some((rule: any) => rule.category === 'testing'));
    assert.equal(packet.signal_quality.overall, 'partial');
    assert.ok(packet.signal_quality.warnings.some((warning: string) => warning.includes('reusable patterns')));
    assert.ok(packet.evidence_policy.must_confirm_in_source.length > 0);
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

async function withWorkspace(run: (workspace: string) => void | Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-agent-workflow-test-'));
  try {
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
