import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectCodebaseIdioms, type IdiomDetectionInput } from '../../backend/src/analyzer/core/idiom-detector';
import type {
  CASBehavioralInvariant,
  CASDecorator,
  CASEdge,
  CASLibrary,
  CASNode,
  CASOutput,
  CASTestSuite,
} from '../../backend/src/types/cas.types';
import {
  buildIdiomContextForAgent,
  getCodebaseIdioms,
  getIdiomExamples,
  validateCodebaseIdioms,
} from './idiom-query';

const repoRoot = path.resolve(__dirname, '..');
const fixturesRoot = path.join(repoRoot, 'fixtures', 'idioms');
const fixtureNames = ['nestjs-api', 'react-app', 'python-api', 'rust-service', 'mixed-monorepo'];

test('detectCodebaseIdioms extracts local conventions across representative fixture repos', () => {
  const aggregateCategories = new Set<string>();
  const results = new Map<string, ReturnType<typeof detectCodebaseIdioms>>();

  for (const fixtureName of fixtureNames) {
    const input = buildDetectionInput(fixtureName);
    const result = detectCodebaseIdioms(input);
    results.set(fixtureName, result);

    assert.ok(result.idioms.length >= 3, `${fixtureName} should expose several repo-local idioms`);
    assert.equal(result.summary.total, result.idioms.length);
    assert.ok(result.examples.length > 0, `${fixtureName} should emit positive idiom examples`);
    for (const idiom of result.idioms) {
      assert.ok(idiom.confidence >= 0.45, `${fixtureName}:${idiom.id} should have a usable confidence`);
      assert.ok(idiom.evidence.length > 0, `${fixtureName}:${idiom.id} should be evidence-backed`);
      assert.ok(idiom.agent_guidance.do.length > 0, `${fixtureName}:${idiom.id} should guide agents`);
      aggregateCategories.add(idiom.category);
    }
  }

  for (const category of [
    'naming',
    'file-organization',
    'module-boundary',
    'dependency-injection',
    'data-access',
    'error-handling',
    'validation',
    'auth-tenant-scope',
    'logging',
    'testing',
    'migrations',
    'async-style',
    'configuration',
  ]) {
    assert.ok(aggregateCategories.has(category), `expected aggregate fixtures to cover ${category}`);
  }

  assert.ok(results.get('nestjs-api')!.idioms.some(idiom => idiom.category === 'dependency-injection'));
  assert.ok(results.get('react-app')!.idioms.some(idiom => idiom.name.includes('PascalCase')));
  assert.ok(results.get('python-api')!.idioms.some(idiom => idiom.name.includes('snake_case')));
  assert.ok(results.get('rust-service')!.idioms.some(idiom => idiom.category === 'error-handling'));
  assert.ok(results.get('mixed-monorepo')!.idioms.some(idiom => idiom.category === 'module-boundary'));
});

test('idiom MCP helpers return compact, target-filterable context with examples', () => {
  const input = buildDetectionInput('nestjs-api');
  const result = detectCodebaseIdioms(input);
  const cas = casFromDetection('nestjs-api', input, result);

  const all = getCodebaseIdioms(cas, { limit: 5 });
  assert.equal(all.limit, 5);
  assert.ok(all.total >= 5);
  assert.ok(all.idioms.every(idiom => idiom.evidence_count > 0));

  const filtered = getCodebaseIdioms(cas, { category: 'dependency-injection', target: 'users.service', limit: 10 });
  assert.ok(filtered.idioms.length >= 1);
  assert.ok(filtered.idioms.every(idiom => idiom.category === 'dependency-injection'));

  const examples = getIdiomExamples(cas, { category: 'testing', target: 'users.service', limit: 5 });
  assert.ok(examples.examples.some(example => example.file.includes('users.service.spec.ts')));

  const context = buildIdiomContextForAgent(cas, {
    files: ['src/users/users.service.ts', 'src/users/entities/user.entity.ts'],
    limit: 6,
  });
  assert.ok(context.selected_idioms.length > 0);
  assert.ok(context.do.length > 0);
  assert.ok(context.validation.some(item => item.includes('validate_codebase_idioms')));
});

test('validateCodebaseIdioms flags non-idiomatic diffs that still could be functionally correct', () => {
  const input = buildDetectionInput('nestjs-api');
  const result = detectCodebaseIdioms(input);
  const cas = casFromDetection('nestjs-api', input, result);
  const validation = validateCodebaseIdioms(cas, input.projectPath, {
    includeWorkingTree: false,
    files: ['src/users/entities/user.entity.ts', 'src/users/users.service.ts'],
    diffText: [
      'diff --git a/src/users/entities/user.entity.ts b/src/users/entities/user.entity.ts',
      '+++ b/src/users/entities/user.entity.ts',
      '+  @Property()',
      '+  nickname!: string;',
      'diff --git a/src/users/users.service.ts b/src/users/users.service.ts',
      '+++ b/src/users/users.service.ts',
      '+  console.log("creating user");',
      '+  if (!dto.email) throw new Error("missing email");',
    ].join('\n'),
  });

  assert.equal(validation.status, 'fail');
  assert.ok(validation.violations.some(item => item.category === 'migrations' && item.severity === 'error'));
  assert.ok(validation.violations.some(item => item.category === 'logging'));
  assert.ok(validation.violations.some(item => item.category === 'error-handling'));
  assert.ok(validation.violations.some(item => item.category === 'testing'));
  assert.ok(validation.required_checks.length > 0);
});

function buildDetectionInput(fixtureName: string): IdiomDetectionInput {
  const projectPath = path.join(fixturesRoot, fixtureName);
  const files = walkFiles(projectPath);
  const nodes = files.flatMap(file => nodesFromFile(projectPath, file));
  const testSuites = files
    .filter(isTestPath)
    .map((file, index): CASTestSuite => ({
      id: `test-${fixtureName}-${index + 1}`,
      name: path.basename(file),
      file_path: file,
      test_type: 'unit',
      framework: file.endsWith('.py') ? 'pytest' : file.endsWith('.rs') ? 'cargo-test' : 'jest/vitest',
      tests: [],
    }));

  return {
    projectPath,
    nodes,
    edges: moduleEdges(nodes),
    entryPoints: [],
    exitPoints: dataNodes(nodes).map((node, index) => ({
      id: `exit-${fixtureName}-${index + 1}`,
      source_node: node.id,
      type: 'database' as const,
      name: `${node.name} data access`,
      metadata: { file: node.source?.file },
    })),
    testSuites,
    behavioralInvariants: behavioralInvariants(fixtureName, nodes, files),
    decorators: decoratorsFromFiles(projectPath, files, nodes),
    patterns: [],
    libraries: librariesForFixture(fixtureName),
    configuration: {
      environment_variables: [
        { name: 'DATABASE_URL', required: true },
        { name: 'LOG_LEVEL', required: false },
      ],
    },
    analysisFacts: [],
  };
}

function casFromDetection(
  fixtureName: string,
  input: IdiomDetectionInput,
  result: ReturnType<typeof detectCodebaseIdioms>
): CASOutput {
  return {
    cas_version: '1.9.0',
    analysis_timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    analysis_id: `idiom-test-${fixtureName}`,
    system: {
      id: fixtureName,
      name: fixtureName,
      type: fixtureName.includes('monorepo') ? 'monorepo' : 'application',
      root_path: input.projectPath,
    },
    nodes: input.nodes,
    edges: input.edges,
    entry_points: input.entryPoints,
    exit_points: input.exitPoints,
    analyzer_contributions: [],
    progressive_levels: { total_levels: 1 },
    test_suites: input.testSuites,
    behavioral_invariants: input.behavioralInvariants,
    decorators: input.decorators,
    libraries: input.libraries,
    configuration: input.configuration,
    codebase_idioms: result.idioms,
    idiom_summary: result.summary,
    idiom_examples: result.examples,
    idiom_violations: result.violations,
  };
}

function nodesFromFile(projectPath: string, relativeFile: string): CASNode[] {
  const absolute = path.join(projectPath, relativeFile);
  const raw = fs.readFileSync(absolute, 'utf8');
  const language = languageForFile(relativeFile);
  const nodes: CASNode[] = [];

  for (const match of raw.matchAll(/\b(?:export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    nodes.push(node(relativeFile, match[1], typeForSymbol(relativeFile, match[1]), language, raw));
  }
  for (const match of raw.matchAll(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    nodes.push(node(relativeFile, match[1], typeForSymbol(relativeFile, match[1], 'function'), language, raw));
  }
  for (const match of raw.matchAll(/\b(?:export\s+)?(?:const|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
    nodes.push(node(relativeFile, match[1], typeForSymbol(relativeFile, match[1], 'constant'), language, raw));
  }
  for (const match of raw.matchAll(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    nodes.push(node(relativeFile, match[1], 'function', language, raw));
  }
  for (const match of raw.matchAll(/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    nodes.push(node(relativeFile, match[1], 'function', language, raw));
  }
  for (const match of raw.matchAll(/^\s{2,}(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)) {
    nodes.push(node(relativeFile, match[1], 'method', language, raw));
  }

  return dedupeNodes(nodes);
}

function node(file: string, name: string, type: string, language: string, raw: string): CASNode {
  return {
    id: `${file}:${name}`.replace(/[^A-Za-z0-9_-]+/g, '_'),
    name,
    type,
    source: {
      file,
      line: lineFor(raw, name),
      raw,
    },
    metadata: {
      language,
      is_async: /\basync\b|Promise<|await\s+|anyhow::Result|Result</.test(raw),
      is_test: isTestPath(file),
    },
  };
}

function typeForSymbol(file: string, name: string, fallback = 'class'): string {
  const text = `${file} ${name}`;
  if (/controller/i.test(text)) return 'controller';
  if (/service/i.test(text)) return 'service';
  if (/repository/i.test(text)) return 'repository';
  if (/module/i.test(text)) return 'module';
  if (/guard/i.test(text)) return 'guard';
  if (/dto|request|schema/i.test(text)) return 'dto';
  if (/entity|model/i.test(text)) return 'entity';
  if (/\.(tsx|jsx)$/i.test(file) && /^[A-Z]/.test(name)) return 'component';
  if (/^use[A-Z]/.test(name)) return 'hook';
  return fallback;
}

function moduleEdges(nodes: CASNode[]): CASEdge[] {
  const modules = nodes.filter(item => /module/i.test(item.type) || /Module$/.test(item.name));
  const edges: CASEdge[] = [];
  for (const moduleNode of modules) {
    const moduleDir = path.dirname(moduleNode.source?.file || '');
    for (const peer of nodes) {
      if (peer.id === moduleNode.id) continue;
      if (path.dirname(peer.source?.file || '') === moduleDir) {
        edges.push({
          id: `edge-${moduleNode.id}-${peer.id}`,
          source: moduleNode.id,
          target: peer.id,
          type: 'contains',
          metadata: {
            confidence: 0.82,
            locations: [{ file: moduleNode.source?.file, line: moduleNode.source?.line }],
          },
        });
      }
    }
  }
  return edges;
}

function decoratorsFromFiles(projectPath: string, files: string[], nodes: CASNode[]): CASDecorator[] {
  const decorators: CASDecorator[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(projectPath, file), 'utf8');
    const targetNode = nodes.find(item => item.source?.file === file);
    if (!targetNode) continue;
    raw.split('\n').forEach((line, index) => {
      const match = line.match(/@([A-Za-z_][A-Za-z0-9_]*)/);
      if (!match) return;
      decorators.push({
        id: `decorator-${file}-${index + 1}`.replace(/[^A-Za-z0-9_-]+/g, '_'),
        target_node: targetNode.id,
        decorator_info: {
          name: match[1],
          type: 'class',
          framework: file.endsWith('.ts') ? 'NestJS' : 'unknown',
          source_location: { file, line: index + 1, column: Math.max(1, line.indexOf('@') + 1) },
        },
        semantic_meaning: {
          category: decoratorCategory(match[1]),
          behavior: `${match[1]} decorator`,
          affects_runtime: true,
        },
      });
    });
  }
  return decorators;
}

function decoratorCategory(name: string): CASDecorator['semantic_meaning']['category'] {
  if (/Controller|Post|Get|Put|Delete|Patch/.test(name)) return 'routing';
  if (/Guard|UseGuards/.test(name)) return 'security';
  if (/Inject|Injectable|Module/.test(name)) return 'injection';
  if (/Is|Min|Max|Validate/.test(name)) return 'validation';
  if (/Config/.test(name)) return 'configuration';
  return 'other';
}

function behavioralInvariants(fixtureName: string, nodes: CASNode[], files: string[]): CASBehavioralInvariant[] {
  const authNodes = nodes.filter(item => /auth|tenant|guard|scope/i.test([item.name, item.type, item.source?.file || '', item.source?.raw || ''].join(' ')));
  const invariants: CASBehavioralInvariant[] = [];
  if (authNodes.length > 0) {
    invariants.push({
      id: `${fixtureName}-tenant-scope`,
      name: 'Tenant scope is preserved',
      invariant_type: 'tenant-scope',
      description: 'Tenant/org scoped behavior must keep tenant filters and guards.',
      scope: {
        node_ids: authNodes.map(item => item.id),
        file_paths: unique(authNodes.map(item => item.source?.file).filter(Boolean) as string[]),
      },
      enforcement: authNodes.map(item => ({
        source: 'code',
        mechanism: 'tenant guard or tenant filter',
        confidence: 'enforced',
        node_id: item.id,
        file: item.source?.file,
        line: item.source?.line,
      })),
      evidence: authNodes.map(item => ({
        source: 'node',
        id: item.id,
        file: item.source?.file,
        line: item.source?.line,
      })),
      confidence: 'high',
    });
  }
  if (files.some(file => /migration/i.test(file))) {
    invariants.push({
      id: `${fixtureName}-migration-contract`,
      name: 'Schema changes use migrations',
      invariant_type: 'migration-contract',
      description: 'Persisted shape changes are paired with migration artifacts.',
      scope: { file_paths: files.filter(file => /migration/i.test(file)) },
      enforcement: files.filter(file => /migration/i.test(file)).map(file => ({
        source: 'migration',
        mechanism: 'migration file',
        confidence: 'enforced',
        file,
      })),
      evidence: files.filter(file => /migration/i.test(file)).map(file => ({
        source: 'migration_file',
        file,
      })),
      confidence: 'high',
    });
  }
  return invariants;
}

function dataNodes(nodes: CASNode[]): CASNode[] {
  return nodes.filter(item => /repository|entity|model|schema|db|sql/i.test([item.name, item.type, item.source?.file || ''].join(' ')));
}

function librariesForFixture(fixtureName: string): CASLibrary[] {
  const names: Record<string, string[]> = {
    'nestjs-api': ['MikroORM', 'class-validator'],
    'react-app': ['TanStack Query'],
    'python-api': ['SQLAlchemy', 'Pydantic'],
    'rust-service': ['sqlx', 'thiserror'],
    'mixed-monorepo': ['NestJS', 'React', 'Zod'],
  };
  return (names[fixtureName] || []).map(name => ({
    id: `library-${fixtureName}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    version: 'fixture',
    type: 'production',
    category: 'framework',
    usage_statistics: { import_count: 1 },
  }));
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else {
        files.push(path.relative(root, absolute).replace(/\\/g, '/'));
      }
    }
  };
  visit(root);
  return files.sort();
}

function isTestPath(file: string): boolean {
  return /(^|\/)(__tests__|tests?|spec|e2e)(\/|$)|(\.|_|-)(test|spec)\.[a-z0-9]+$/i.test(file);
}

function languageForFile(file: string): string {
  if (/\.(ts|tsx|js|jsx)$/i.test(file)) return 'TypeScript';
  if (/\.py$/i.test(file)) return 'Python';
  if (/\.rs$/i.test(file)) return 'Rust';
  return 'Unknown';
}

function lineFor(raw: string, name: string): number {
  const index = raw.split('\n').findIndex(line => line.includes(name));
  return index >= 0 ? index + 1 : 1;
}

function dedupeNodes(nodes: CASNode[]): CASNode[] {
  const seen = new Set<string>();
  return nodes.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
