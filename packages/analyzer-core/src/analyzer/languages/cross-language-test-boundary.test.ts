// Regression coverage for task #126: `tests_present` was wrong on most
// supported languages because language analyzers never tagged their own
// test-file nodes (`metadata.is_test` / `category: 'test'`). Without that
// tag, the cross-language test-coverage graph walk (TestFrameworkAnalyzer's
// isTestOwnedNode / attachDetailedTestGraph) could only start a traversal
// from its own synthetic suite/case nodes — which carry no `calls` edges of
// their own — never from the language analyzer's real test-function nodes,
// which DO have call edges into production code. Every capability/journey
// then reported `tests_present: false` even when `test_summary` counted
// real passing tests: a flat self-contradiction. Go was fixed first
// (go-analyzer.ts's applyTestFileBoundary); this file proves the same fix
// for the other seven affected languages, one subtest per language, each
// using that ecosystem's OWN test convention as evidence (never a shared
// filename heuristic — see each analyzer's own applyTestFileBoundary doc
// comment for why).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { RubyAnalyzer } from './ruby-analyzer';
import { PythonAnalyzer } from './python-analyzer';
import { CSharpAnalyzer } from './csharp-analyzer';
import { JavaAnalyzer } from './java-analyzer';
import { RustAnalyzer } from './rust-analyzer';
import { KotlinAnalyzer } from './kotlin-analyzer';
import { SwiftAnalyzer } from './swift-analyzer';
import { TestFrameworkAnalyzer } from '../frameworks/testing/test-framework-analyzer';
import type { CASContribution } from '../../types/cas.types';

async function withTempDir(prefix: string, fn: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fn(root);
  } finally {
    await fs.remove(root);
  }
}

// Shared assertions for every language: the language analyzer tags its own
// test-file nodes AND leaves a `calls` edge a downstream coverage walk can
// traverse; the cross-language TestFrameworkAnalyzer independently discovers
// at least one suite/case from the same fixture (proving test_summary and
// the per-capability coverage signal are no longer looking at different,
// contradictory pictures of the same project).
function assertBoundaryTagging(language: CASContribution, productionNodeName: string) {
  const productionNode = language.nodes.find(node => node.name === productionNodeName);
  assert.ok(productionNode, `production node "${productionNodeName}" exists`);
  assert.notEqual(productionNode!.metadata?.is_test, true, 'production node is not tagged as test');
  assert.notEqual(productionNode!.category, 'test', 'production node is not categorized as test');

  const testNodes = language.nodes.filter(node => node.metadata?.is_test === true);
  assert.ok(testNodes.length > 0, 'at least one node was tagged is_test');
  assert.ok(testNodes.every(node => node.category === 'test'), 'every is_test node is also category=test');
  assert.ok(testNodes.every(node => node.tags?.includes('test-code')), 'every is_test node carries the test-code tag');

  return { productionNode: productionNode!, testNodes };
}

test('RubyAnalyzer tags Minitest test/*_test.rb nodes and links calls into production code', async () => {
  await withTempDir('klauro-ruby-test-boundary-', async (root) => {
    await fs.ensureDir(path.join(root, 'lib'));
    await fs.ensureDir(path.join(root, 'test'));
    // Ruby's own call-graph resolution (buildCallEdges) only resolves calls
    // that carry a resolvable receiver (bare same-class calls, or a
    // constant-receiver call to a known class's singleton method) — it does
    // not resolve bare top-level function calls. A class singleton method
    // called via its constant receiver is the same proven shape the
    // analyzer's own call-graph tests use.
    await fs.writeFile(
      path.join(root, 'lib', 'calculator.rb'),
      ['class Calculator', '  def self.add(a, b)', '    a + b', '  end', 'end'].join('\n')
    );
    await fs.writeFile(
      path.join(root, 'test', 'calculator_test.rb'),
      [
        "require 'minitest/autorun'",
        "require_relative '../lib/calculator'",
        '',
        'class CalculatorTest < Minitest::Test',
        '  def test_add',
        '    Calculator.add(1, 2)',
        '  end',
        'end',
      ].join('\n')
    );

    const analyzer = new RubyAnalyzer();
    const language = await analyzer.analyze({ projectPath: root });
    const { productionNode, testNodes } = assertBoundaryTagging(language, 'add');
    assert.ok(testNodes.some(node => node.name === 'test_add'), 'test_add method node is tagged');
    assert.ok(language.edges.some(edge =>
      edge.type === 'calls' && edge.target === productionNode.id &&
      testNodes.some(node => node.id === edge.source)
    ), 'a tagged test node has a calls edge into the production node');

    const tests = await new TestFrameworkAnalyzer().analyze({
      projectPath: root,
      existingAnalysis: [language],
    });
    assert.ok(tests.nodes.some(node => node.type === 'test'), 'TestFrameworkAnalyzer discovers a Ruby suite/case');
  });
});

test('PythonAnalyzer tags pytest test_*.py nodes and links calls into production code', async () => {
  await withTempDir('klauro-python-test-boundary-', async (root) => {
    await fs.writeFile(path.join(root, 'calculator.py'), 'def add(a, b):\n    return a + b\n');
    await fs.writeFile(
      path.join(root, 'test_calculator.py'),
      ['from calculator import add', '', 'def test_add():', '    assert add(1, 2) == 3', ''].join('\n')
    );

    const analyzer = new PythonAnalyzer();
    const language = await analyzer.analyze({ projectPath: root });
    const { productionNode, testNodes } = assertBoundaryTagging(language, 'add');
    assert.ok(testNodes.some(node => node.name === 'test_add'), 'test_add function node is tagged');
    assert.ok(language.edges.some(edge =>
      edge.type === 'calls' && edge.target === productionNode.id &&
      testNodes.some(node => node.id === edge.source)
    ), 'a tagged test node has a calls edge into the production node');

    const tests = await new TestFrameworkAnalyzer().analyze({
      projectPath: root,
      existingAnalysis: [language],
    });
    assert.ok(tests.nodes.some(node => node.type === 'test'), 'TestFrameworkAnalyzer discovers a pytest suite/case');
  });
});

test('CSharpAnalyzer tags *Tests.cs nodes (previously excluded from the glob entirely)', async () => {
  await withTempDir('klauro-csharp-test-boundary-', async (root) => {
    await fs.writeFile(
      path.join(root, 'Calculator.cs'),
      [
        'namespace Demo',
        '{',
        '    public class Calculator',
        '    {',
        '        public int Add(int a, int b)',
        '        {',
        '            return a + b;',
        '        }',
        '    }',
        '}',
      ].join('\n')
    );
    await fs.writeFile(
      path.join(root, 'CalculatorTests.cs'),
      [
        'using Xunit;',
        '',
        'namespace Demo',
        '{',
        '    public class CalculatorTests',
        '    {',
        '        [Fact]',
        '        public void Add_ReturnsSum()',
        '        {',
        '        }',
        '    }',
        '}',
      ].join('\n')
    );

    const analyzer = new CSharpAnalyzer();
    const language = await analyzer.analyze({ projectPath: root });
    // The core regression: CalculatorTests.cs used to be dropped from the
    // glob entirely (excludeTests=true), so NO node for it ever existed.
    const testClassNode = language.nodes.find(node => node.name === 'CalculatorTests');
    assert.ok(testClassNode, 'CalculatorTests class node now exists (file is no longer excluded)');
    assertBoundaryTagging(language, 'Add');

    const tests = await new TestFrameworkAnalyzer().analyze({
      projectPath: root,
      existingAnalysis: [language],
    });
    assert.ok(tests.nodes.some(node => node.type === 'test'), 'TestFrameworkAnalyzer discovers an xUnit suite/case');
  });
});

test('JavaAnalyzer tags *Test.java nodes (previously excluded from the glob entirely)', async () => {
  await withTempDir('klauro-java-test-boundary-', async (root) => {
    await fs.ensureDir(path.join(root, 'src', 'main', 'java', 'demo'));
    await fs.ensureDir(path.join(root, 'src', 'test', 'java', 'demo'));
    await fs.writeFile(
      path.join(root, 'src', 'main', 'java', 'demo', 'Calculator.java'),
      ['package demo;', '', 'public class Calculator {', '    public int add(int a, int b) {', '        return a + b;', '    }', '}'].join('\n')
    );
    await fs.writeFile(
      path.join(root, 'src', 'test', 'java', 'demo', 'CalculatorTest.java'),
      [
        'package demo;',
        '',
        'import org.junit.Test;',
        '',
        'public class CalculatorTest {',
        '    @Test',
        '    public void testAdd() {',
        '    }',
        '}',
      ].join('\n')
    );

    const analyzer = new JavaAnalyzer();
    const language = await analyzer.analyze({ projectPath: root });
    // The core regression: CalculatorTest.java used to be dropped from the
    // glob entirely (`**/test/**`, `**/*Test.java` ignore patterns), so NO
    // node for it ever existed — not just an untagged one.
    const testClassNode = language.nodes.find(node => node.name === 'CalculatorTest');
    assert.ok(testClassNode, 'CalculatorTest class node now exists (file is no longer excluded)');
    assertBoundaryTagging(language, 'add');

    const tests = await new TestFrameworkAnalyzer().analyze({
      projectPath: root,
      existingAnalysis: [language],
    });
    assert.ok(tests.nodes.some(node => node.type === 'test'), 'TestFrameworkAnalyzer discovers a JUnit suite/case');
  });
});

test('RustAnalyzer tags #[test] fns AND #[cfg(test)] mod helpers (no filename signal exists)', async () => {
  await withTempDir('klauro-rust-test-boundary-', async (root) => {
    await fs.ensureDir(path.join(root, 'src'));
    await fs.writeFile(
      path.join(root, 'src', 'lib.rs'),
      [
        'pub fn add(a: i32, b: i32) -> i32 {',
        '    a + b',
        '}',
        '',
        '#[cfg(test)]',
        'mod tests {',
        '    use super::add;',
        '',
        '    fn helper_operands() -> (i32, i32) {',
        '        (1, 2)',
        '    }',
        '',
        '    #[test]',
        '    fn test_add() {',
        '        let (a, b) = helper_operands();',
        '        add(a, b);',
        '    }',
        '}',
      ].join('\n')
    );

    const analyzer = new RustAnalyzer();
    const language = await analyzer.analyze({ projectPath: root });
    const productionNode = language.nodes.find(node => node.name === 'add');
    assert.ok(productionNode, 'production node "add" exists');
    assert.notEqual(productionNode!.metadata?.is_test, true, 'production add() is not tagged as test');

    const attributedTest = language.nodes.find(node => node.name === 'test_add');
    assert.ok(attributedTest, 'test_add node exists');
    assert.equal(attributedTest!.metadata?.is_test, true, '#[test]-attributed fn is tagged is_test');
    assert.equal(attributedTest!.category, 'test');

    // The harder case: helper_operands has NO #[test] attribute of its own —
    // it is only inside the #[cfg(test)] mod block. Rust has no filename
    // convention here (no `_test.rs` suffix), so this can only be caught by
    // scanning for the enclosing #[cfg(test)] module, which is what
    // findCfgTestModuleRanges does.
    const helper = language.nodes.find(node => node.name === 'helper_operands');
    assert.ok(helper, 'helper_operands node exists');
    assert.equal(helper!.metadata?.is_test, true, 'un-attributed helper inside #[cfg(test)] mod is still tagged is_test');
    assert.equal(helper!.category, 'test');

    assert.ok(language.edges.some(edge =>
      edge.type === 'calls' && edge.source === attributedTest!.id && edge.target === productionNode!.id
    ), 'test_add has a calls edge into add()');

    const tests = await new TestFrameworkAnalyzer().analyze({
      projectPath: root,
      existingAnalysis: [language],
    });
    assert.ok(tests.nodes.some(node => node.type === 'test'), 'TestFrameworkAnalyzer discovers a rust-test suite/case');
  });
});

test('RustAnalyzer tags every node in a Cargo tests/ integration-test file', async () => {
  await withTempDir('klauro-rust-integration-test-boundary-', async (root) => {
    await fs.ensureDir(path.join(root, 'tests'));
    await fs.writeFile(path.join(root, 'lib.rs'), 'pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n');
    await fs.writeFile(
      path.join(root, 'tests', 'integration.rs'),
      ['fn shared_helper() -> i32 {', '    1', '}', '', '#[test]', 'fn test_add_integration() {', '    shared_helper();', '}'].join('\n')
    );

    const analyzer = new RustAnalyzer();
    const language = await analyzer.analyze({ projectPath: root });
    const helper = language.nodes.find(node => node.name === 'shared_helper');
    assert.ok(helper, 'shared_helper node exists');
    assert.equal(helper!.metadata?.is_test, true, 'a plain fn under tests/ is tagged is_test even without #[test]');
    assert.equal(helper!.category, 'test');
  });
});

test('KotlinAnalyzer tags *Test.kt nodes and links calls into production code', async () => {
  await withTempDir('klauro-kotlin-test-boundary-', async (root) => {
    await fs.writeFile(path.join(root, 'Calculator.kt'), 'fun add(a: Int, b: Int): Int {\n    return a + b\n}\n');
    await fs.writeFile(
      path.join(root, 'CalculatorTest.kt'),
      [
        'import org.junit.Test',
        '',
        'class CalculatorTest {',
        '    @Test',
        '    fun testAdd() {',
        '        add(1, 2)',
        '    }',
        '}',
      ].join('\n')
    );

    const analyzer = new KotlinAnalyzer();
    const language = await analyzer.analyze({ projectPath: root });
    const { productionNode, testNodes } = assertBoundaryTagging(language, 'add');
    assert.ok(testNodes.some(node => node.name === 'testAdd'), 'testAdd method node is tagged');
    assert.ok(language.edges.some(edge =>
      edge.type === 'calls' && edge.target === productionNode.id &&
      testNodes.some(node => node.id === edge.source)
    ), 'a tagged test node has a calls edge into the production node');

    const tests = await new TestFrameworkAnalyzer().analyze({
      projectPath: root,
      existingAnalysis: [language],
    });
    assert.ok(tests.nodes.some(node => node.type === 'test'), 'TestFrameworkAnalyzer discovers a JUnit (Kotlin) suite/case');
  });
});

test('SwiftAnalyzer tags *Tests.swift nodes under Tests/ and links calls into production code', async () => {
  await withTempDir('klauro-swift-test-boundary-', async (root) => {
    const sources = path.join(root, 'Sources', 'App');
    const tests = path.join(root, 'Tests', 'AppTests');
    await fs.ensureDir(sources);
    await fs.ensureDir(tests);
    await fs.writeFile(path.join(sources, 'Calculator.swift'), 'func add(_ a: Int, _ b: Int) -> Int {\n    return a + b\n}\n');
    await fs.writeFile(
      path.join(tests, 'CalculatorTests.swift'),
      [
        'import XCTest',
        '@testable import App',
        '',
        'final class CalculatorTests: XCTestCase {',
        '    func testAdd() {',
        '        add(1, 2)',
        '    }',
        '}',
      ].join('\n')
    );

    const analyzer = new SwiftAnalyzer();
    const language = await analyzer.analyze({ projectPath: root });
    const { testNodes } = assertBoundaryTagging(language, 'add');
    assert.ok(testNodes.some(node => node.name === 'testAdd'), 'testAdd method node is tagged');

    const testFrameworkResult = await new TestFrameworkAnalyzer().analyze({
      projectPath: root,
      existingAnalysis: [language],
    });
    assert.ok(testFrameworkResult.nodes.some(node => node.type === 'test'), 'TestFrameworkAnalyzer discovers an XCTest suite/case (previously unregistered)');
  });
});
