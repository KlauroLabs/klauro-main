import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { TypeScriptJavaScriptAnalyzer } from './typescript-javascript-analyzer';
import { TestFrameworkAnalyzer } from '../frameworks/testing/test-framework-analyzer';
import { MockingLibraryAnalyzer } from '../libraries/testing/mocking-library-analyzer';

test('TypeScript retains a separate test graph with helpers, calls, mocks, and exact tested-code edges', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-ts-test-boundary-'));
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'boundary-fixture',
      devDependencies: { vitest: '^3.0.0' },
    }));
    await fs.ensureDir(path.join(root, '__tests__'));
    await fs.writeFile(path.join(root, 'calculator.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    await fs.writeFile(
      path.join(root, '__tests__', 'test-support.ts'),
      "import { vi } from 'vitest';\nvi.mock('../mailer');\nexport function makeOperands() { return [1, 2] as const; }\n"
    );
    const testFilePath = path.join(root, '__tests__', 'calculator.spec.ts');
    await fs.writeFile(
      testFilePath,
      [
        "import { describe, it, expect, vi } from 'vitest';",
        "import { add } from '../calculator';",
        "vi.mock('./clock');",
        'function assertAddition() { expect(add(1, 2)).toBe(3); }',
        "describe('calculator', () => {",
        "  it('adds', () => { assertAddition(); });",
        '});',
      ].join('\n')
    );

    const languageAnalyzer = new TypeScriptJavaScriptAnalyzer();
    const language = await languageAnalyzer.analyze({ projectPath: root });
    const productionNode = language.nodes.find(node => node.name === 'add');
    const allTestNodes = language.nodes.filter(node => node.source?.file?.includes('__tests__/'));
    const testNodes = allTestNodes.filter(node => node.source?.file?.endsWith('__tests__/calculator.spec.ts'));
    const helperNode = testNodes.find(node => node.name === 'assertAddition');
    assert.ok(productionNode);
    assert.ok(helperNode, 'named test helpers remain ordinary callable graph nodes');
    assert.ok(testNodes.length > 0);
    assert.ok(allTestNodes.every(node => node.metadata?.is_test === true && node.category === 'test'));
    assert.ok(allTestNodes.some(node => node.name === 'makeOperands'), 'test-directory helpers do not need a .test/.spec suffix');
    assert.strictEqual(productionNode.metadata?.is_test, undefined);
    assert.ok(language.edges.some(edge =>
      edge.type === 'calls' && edge.source === helperNode.id && edge.target === productionNode.id
    ), 'test-helper calls into production code remain in the canonical call graph');
    assert.ok(language.entry_points.every(entry =>
      !testNodes.some(node => node.id === entry.source_node)
    ), 'test code never becomes a product entry point');
    assert.ok(language.exit_points.every(exit =>
      !testNodes.some(node => node.id === exit.source_node)
    ), 'test code never becomes a product exit point');

    const incremental = await languageAnalyzer.analyzeFileSingle({
      filePath: testFilePath,
      relativePath: '__tests__/calculator.spec.ts',
      projectPath: root,
      contentHash: 'test-change',
      existingAnalysis: [language],
    });
    assert.ok(incremental.nodes.length > 0);
    assert.ok(incremental.nodes.every(node => node.metadata?.is_test === true && node.category === 'test'));
    assert.strictEqual(incremental.entryPoints.length, 0);
    assert.strictEqual(incremental.exitPoints.length, 0);
    assert.ok(incremental.edges.some(edge =>
      edge.type === 'calls' && edge.target === productionNode.id
    ), 'incremental test analysis retains calls into unchanged production code');

    const mocking = await new MockingLibraryAnalyzer().analyze({ projectPath: root });
    const mockNode = mocking.nodes.find(node =>
      node.type === 'mock' && node.source?.file?.endsWith('__tests__/calculator.spec.ts')
    );
    assert.ok(mockNode, 'mock declarations remain first-class test graph nodes');
    assert.ok(mocking.edges.some(edge => edge.type === 'mocks' && edge.source === mockNode.id));
    assert.ok(mocking.nodes.some(node =>
      node.type === 'mock' && node.source?.file?.endsWith('__tests__/test-support.ts')
    ), 'mock declarations in test-directory helper files do not need a .test/.spec suffix');

    const tests = await new TestFrameworkAnalyzer().analyze({
      projectPath: root,
      existingAnalysis: [language, mocking],
    });
    const suiteNodes = tests.nodes.filter(node => node.type === 'test' && node.subcategories?.includes('suite'));
    const caseNodes = tests.nodes.filter(node => node.type === 'test' && !node.subcategories?.includes('suite'));
    assert.strictEqual(suiteNodes.length, 1);
    assert.strictEqual(caseNodes.length, 1);
    assert.strictEqual(tests.entry_points.length, 0);
    assert.strictEqual(tests.edges.filter(edge => edge.type === 'covers').length, 1);
    assert.ok(tests.edges.some(edge =>
      edge.type === 'contains' && edge.target === helperNode.id
    ), 'suite categorization links to retained test helpers');
    assert.ok(tests.edges.some(edge =>
      edge.type === 'mocks' && edge.target === mockNode.id
    ), 'suite categorization links to retained mocks');
    assert.ok(tests.edges.some(edge =>
      edge.type === 'tests' && edge.source === caseNodes[0].id &&
      edge.target === productionNode.id && edge.metadata?.attributes?.exact === true
    ), 'the individual test case follows its real helper call chain to the tested production function');
  } finally {
    await fs.remove(root);
  }
});

test('TypeScript single-file analysis preserves calls into unchanged project files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-ts-incremental-call-'));
  try {
    const servicePath = path.join(root, 'order-service.ts');
    const routePath = path.join(root, 'server.ts');
    await fs.writeFile(servicePath, 'export function calculateTotal(lines: number[]) { return lines.reduce((sum, line) => sum + line, 0); }\n');
    await fs.writeFile(
      routePath,
      "import { calculateTotal } from './order-service';\nexport function orderHandler(lines: number[]) { return calculateTotal(lines); }\n"
    );

    const analyzer = new TypeScriptJavaScriptAnalyzer();
    const baseline = await analyzer.analyze({ projectPath: root });
    await fs.writeFile(
      routePath,
      "import { calculateTotal } from './order-service';\nexport function orderHandler(lines: number[]) { return calculateTotal(lines); }\nexport function summaryHandler() { return 'ready'; }\n"
    );

    const incremental = await analyzer.analyzeFileSingle({
      filePath: routePath,
      relativePath: 'server.ts',
      projectPath: root,
      contentHash: 'changed',
      existingAnalysis: [baseline],
    });

    const target = baseline.nodes.find(node => node.name === 'calculateTotal');
    const source = incremental.nodes.find(node => node.name === 'orderHandler');
    assert.ok(target);
    assert.ok(source);
    assert.ok(incremental.edges.some(edge =>
      edge.type === 'calls' && edge.source === source.id && edge.target === target.id
    ));
  } finally {
    await fs.remove(root);
  }
});

test('TypeScript analyzes a first-party source file larger than five MiB', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-ts-large-source-'));
  try {
    const content = 'export function largeFileExport() { return 42; }\n/*' + 'x'.repeat(5 * 1024 * 1024 + 1) + '*/\n';
    await fs.writeFile(path.join(root, 'large.ts'), content);
    const result = await new TypeScriptJavaScriptAnalyzer().analyze({ projectPath: root });
    assert.ok(result.nodes.some(node => node.name === 'largeFileExport'));
    assert.equal(result.analyzer_metadata?.analysis_scope?.complete, true);
    assert.equal(result.analyzer_metadata?.analysis_scope?.files_analyzed, 1);
    assert.deepEqual(result.analyzer_metadata?.framework_specific?.omitted_source_files, undefined);
  } finally {
    await fs.remove(root);
  }
});

test('TypeScript records exact source omission diagnostics and incomplete scope when parsing fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-ts-parser-omission-'));
  try {
    const source = 'export const parserFailureFixture = true;\n';
    await fs.writeFile(path.join(root, 'broken.ts'), source);
    const analyzer = new TypeScriptJavaScriptAnalyzer();
    (analyzer as any).tsExtractor.extractFromSource = () => { throw new Error('forced parser failure'); };
    const result = await analyzer.analyze({ projectPath: root });
    assert.equal(result.analyzer_metadata?.analysis_scope?.complete, false);
    assert.equal(result.analyzer_metadata?.analysis_scope?.files_eligible, 1);
    assert.equal(result.analyzer_metadata?.analysis_scope?.files_analyzed, 0);
    assert.equal(result.analyzer_metadata?.analysis_scope?.files_skipped, 1);
    assert.match(result.analyzer_metadata?.analysis_scope?.incomplete_reason || '', /1 source file/);
    assert.deepEqual(result.analyzer_metadata?.framework_specific?.omitted_source_files, [{
      path: 'broken.ts',
      reason: 'parser failed: forced parser failure',
      bytes: Buffer.byteLength(source),
    }]);
    assert.match((result.analyzer_metadata?.warnings || []).join('\n'), /broken\.ts could not be parsed/);
  } finally {
    await fs.remove(root);
  }
});
test('TypeScript treats recovered parser artifacts as complete but records genuine partial syntax exactly', async () => {
  const recoveredRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-ts-recovered-syntax-'));
  const partialRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-ts-partial-syntax-'));
  try {
    await fs.writeFile(path.join(recoveredRoot, 'valid.tsx'), [
      'export function View() { return <p>Use <span>&&</span></p>; }',
      'export async function load(importOriginal: Function) { return importOriginal<typeof import("pkg")>(); }',
      'export function check(expect: Function, html: string, prefix: string) { expect(html).toContain(`${prefix}<span>value</span>`); }',
    ].join('\n'));
    const recovered = await new TypeScriptJavaScriptAnalyzer().analyze({ projectPath: recoveredRoot });
    assert.equal(recovered.analyzer_metadata?.analysis_scope?.complete, true);
    assert.equal(recovered.analyzer_metadata?.analysis_scope?.files_skipped, 0);
    assert.equal(recovered.analyzer_metadata?.framework_specific?.partial_source_files, undefined);
    assert.doesNotMatch((recovered.analyzer_metadata?.warnings || []).join('\n'), /could not fully recognize|syntax errors/);

    const malformed = 'export function broken(: number { return 1; }\n';
    await fs.writeFile(path.join(partialRoot, 'broken.ts'), malformed);
    const partial = await new TypeScriptJavaScriptAnalyzer().analyze({ projectPath: partialRoot });
    assert.equal(partial.analyzer_metadata?.analysis_scope?.complete, false);
    assert.equal(partial.analyzer_metadata?.analysis_scope?.files_analyzed, 1);
    // Partially parsed is not skipped: the file was analyzed and its recovered
    // declarations are in the output. The two counts are reported separately.
    assert.equal(partial.analyzer_metadata?.analysis_scope?.files_skipped, 0);
    assert.equal(partial.analyzer_metadata?.analysis_scope?.files_partial, 1);
    assert.equal(partial.analyzer_metadata?.analysis_scope?.omitted_paths, undefined);
    assert.deepEqual(partial.analyzer_metadata?.analysis_scope?.partial_paths, ['broken.ts']);
    assert.match(partial.analyzer_metadata?.analysis_scope?.incomplete_reason || '', /1 source file\(s\) were only partially parsed/);
    assert.deepEqual(partial.analyzer_metadata?.framework_specific?.partial_source_files, [{
      path: 'broken.ts',
      reason: partial.analyzer_metadata?.framework_specific?.partial_source_files[0].reason,
      bytes: Buffer.byteLength(malformed),
    }]);
    assert.match(partial.analyzer_metadata?.framework_specific?.partial_source_files[0].reason, /unparsed syntax near line 1/);
    assert.match((partial.analyzer_metadata?.warnings || []).join('\n'), /broken\.ts contains a construct our parser could not fully recognize/);
  } finally {
    await Promise.all([
      fs.remove(recoveredRoot),
      fs.remove(partialRoot),
    ]);
  }
});
