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
