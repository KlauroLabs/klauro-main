import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { TestFrameworkAnalyzer } from './test-framework-analyzer';
import { linkHttpTestCoverage } from '../../core/http-test-coverage';

/**
 * Real-fixture end-to-end coverage for the cross-language test analyzer. Uses
 * node:test (not jest) because the jest global setup mocks fs/glob, which this
 * analyzer relies on for real filesystem discovery.
 */

async function makeProject(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `test-framework-${name}-`));
}

function suiteNodes(nodes: any[]) {
  return nodes.filter(n => n.type === 'test' && n.subcategories?.includes('suite'));
}
function caseNodes(nodes: any[]) {
  return nodes.filter(n => n.type === 'test' && !n.subcategories?.includes('suite'));
}

test('canAnalyze is gated on real framework evidence, not bare test-file naming', async () => {
  const root = await makeProject('gate');
  try {
    // A .test.ts file with no framework import — must NOT trigger (jest owns
    // generic describe/it; this analyzer needs a distinguishing import).
    await fs.writeFile(path.join(root, 'plain.test.ts'), `const x = 1;\nexport default x;\n`);
    const analyzer = new TestFrameworkAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), false);

    // Add a vitest import — now the evidence gate passes.
    await fs.writeFile(
      path.join(root, 'sum.test.ts'),
      `import { describe, it, expect } from 'vitest';\nimport { sum } from './sum';\ndescribe('sum', () => {\n  it('adds', () => { expect(sum(1,2)).toBe(3); });\n});\n`
    );
    assert.strictEqual(await analyzer.canAnalyze(root), true);
  } finally {
    await fs.remove(root);
  }
});

test('Vitest: emits suite + case test nodes and a covers edge to the imported subject', async () => {
  const root = await makeProject('vitest');
  try {
    await fs.writeFile(path.join(root, 'sum.ts'), `export function sum(a: number, b: number) { return a + b; }\n`);
    await fs.writeFile(
      path.join(root, 'sum.test.ts'),
      `import { describe, it, expect } from 'vitest';
import { sum } from './sum';

describe('sum', () => {
  it('adds two numbers', () => { expect(sum(1, 2)).toBe(3); });
  it('handles zero', () => { expect(sum(0, 0)).toBe(0); });
});
`
    );
    // A file node the covers-edge resolver can target.
    const existing = [{
      nodes: [{ id: 'file_sum', name: 'sum.ts', type: 'file', source: { file: path.join(root, 'sum.ts'), line: 1 } }],
      edges: [], entry_points: [], exit_points: [], analyzer_metadata: {} as any,
    }];

    const analyzer = new TestFrameworkAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root, existingAnalysis: existing as any });

    const suites = suiteNodes(contribution.nodes);
    const cases = caseNodes(contribution.nodes);
    assert.strictEqual(suites.length, 1);
    assert.strictEqual(cases.length, 2);
    assert.strictEqual(suites[0].metadata?.framework, 'vitest');
    assert.deepEqual(cases.map(c => c.name).sort(), ['adds two numbers', 'handles zero']);

    // Tests are modeled in the dedicated suite/case graph, not as operational
    // entry points.
    assert.strictEqual(contribution.entry_points.length, 0);

    const coversEdge = contribution.edges.find(e => e.type === 'covers');
    assert.ok(coversEdge, 'should emit a covers edge to the subject-under-test');
    assert.strictEqual(coversEdge!.target, 'file_sum');
  } finally {
    await fs.remove(root);
  }
});

test('pytest: extracts test_ functions and does not fabricate covers edges', async () => {
  const root = await makeProject('pytest');
  try {
    await fs.writeFile(
      path.join(root, 'test_math.py'),
      `import pytest
from .calc import add

def test_add():
    assert add(1, 2) == 3

@pytest.mark.skip(reason="wip")
def test_subtract():
    assert True
`
    );
    const analyzer = new TestFrameworkAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), true);
    const contribution = await analyzer.analyze({ projectPath: root });

    const cases = caseNodes(contribution.nodes);
    assert.deepEqual(cases.map(c => c.name).sort(), ['test_add', 'test_subtract']);
    assert.strictEqual(suiteNodes(contribution.nodes)[0].metadata?.framework, 'pytest');
    // Subject .calc has no node in this analysis -> no covers edge fabricated.
    assert.strictEqual(contribution.edges.filter(e => e.type === 'covers').length, 0);
  } finally {
    await fs.remove(root);
  }
});

test('Go: extracts func TestXxx(t *testing.T)', async () => {
  const root = await makeProject('go');
  try {
    await fs.writeFile(
      path.join(root, 'math_test.go'),
      `package math

import "testing"

func TestAdd(t *testing.T) {
    if Add(1, 2) != 3 { t.Fail() }
}

func TestSub(t *testing.T) {
    if Sub(3, 1) != 2 { t.Fail() }
}
`
    );
    const analyzer = new TestFrameworkAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });
    const cases = caseNodes(contribution.nodes);
    assert.deepEqual(cases.map(c => c.name).sort(), ['TestAdd', 'TestSub']);
    assert.strictEqual(suiteNodes(contribution.nodes)[0].metadata?.framework, 'go-test');
  } finally {
    await fs.remove(root);
  }
});

test('Rust: extracts #[test] and #[tokio::test] functions', async () => {
  const root = await makeProject('rust');
  try {
    await fs.writeFile(
      path.join(root, 'lib_test.rs'),
      `#[cfg(test)]
mod tests {
    #[test]
    fn adds() { assert_eq!(2 + 2, 4); }

    #[tokio::test]
    async fn awaits() { assert!(true); }
}
`
    );
    const analyzer = new TestFrameworkAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });
    const cases = caseNodes(contribution.nodes);
    assert.deepEqual(cases.map(c => c.name).sort(), ['adds', 'awaits']);
    assert.strictEqual(suiteNodes(contribution.nodes)[0].metadata?.framework, 'rust-test');
  } finally {
    await fs.remove(root);
  }
});

test('JUnit: extracts @Test methods', async () => {
  const root = await makeProject('junit');
  try {
    await fs.writeFile(
      path.join(root, 'CalcTest.java'),
      `import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class CalcTest {
    @Test
    void addsNumbers() { assertEquals(3, Calc.add(1, 2)); }

    @Test
    void subtractsNumbers() { assertEquals(1, Calc.sub(2, 1)); }
}
`
    );
    const analyzer = new TestFrameworkAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });
    const cases = caseNodes(contribution.nodes);
    assert.deepEqual(cases.map(c => c.name).sort(), ['addsNumbers', 'subtractsNumbers']);
    assert.strictEqual(suiteNodes(contribution.nodes)[0].metadata?.framework, 'junit');
  } finally {
    await fs.remove(root);
  }
});

test('JUnit HTTP request literals cover only the matching canonical route', async () => {
  const root = await makeProject('junit-http');
  try {
    const testDirectory = path.join(root, 'src/test/java/org/example/samples/records');
    await fs.ensureDir(testDirectory);
    await fs.writeFile(
      path.join(testDirectory, 'RecordResourceTest.java'),
      `import org.junit.jupiter.api.Test;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

class RecordResourceTest {
    @Test
    void fetchesSelectedRecords() throws Exception {
        mvc.perform(get("/records?recordId=11,22"));
    }
}
`
    );
    const existing = [{
      nodes: [
        { id: 'controller_records', name: 'RecordResource', type: 'controller' },
        { id: 'route_records_get', name: 'GET /records', type: 'route', metadata: { attributes: { method: 'GET', path: '/records' } } },
        { id: 'route_records_post', name: 'POST /records', type: 'route', metadata: { attributes: { method: 'POST', path: '/records' } } },
        { id: 'handler_records_get', name: 'fetchSelectedRecords', type: 'method' },
      ],
      edges: [{ id: 'controller_exposes_get', source: 'controller_records', target: 'route_records_get', type: 'exposes' }],
      entry_points: [
        { id: 'entry_records_get', source_node: 'route_records_get', type: 'http', trigger: { method: 'GET', path: '/records' }, handler: { node_id: 'handler_records_get' } },
        { id: 'entry_records_post', source_node: 'route_records_post', type: 'http', trigger: { method: 'POST', path: '/records' } },
      ],
      exit_points: [],
      analyzer_metadata: {} as any,
    }];

    const contribution = await new TestFrameworkAnalyzer().analyze({
      projectPath: root,
      existingAnalysis: existing as any,
    });
    const testCase = caseNodes(contribution.nodes)[0];
    const mergedEdges = [...existing[0].edges, ...contribution.edges] as any;
    linkHttpTestCoverage(
      [...existing[0].nodes, ...contribution.nodes] as any,
      mergedEdges,
      existing[0].entry_points as any,
    );
    const testedTargets = mergedEdges
      .filter(edge => edge.type === 'tests' && edge.source === testCase.id)
      .map(edge => edge.target);
    assert.deepEqual(testedTargets.sort(), ['controller_records', 'handler_records_get', 'route_records_get']);
    assert.strictEqual(
      mergedEdges.find(edge => edge.type === 'tests')?.metadata?.attributes?.evidence,
      'http-request-literal'
    );
  } finally {
    await fs.remove(root);
  }
});

test('JUnit: extracts Kotlin backtick test names', async () => {
  const root = await makeProject('junit-kotlin');
  try {
    await fs.writeFile(
      path.join(root, 'PlaybackPolicyTest.kt'),
      `import org.junit.Test

class PlaybackPolicyTest {
    @Test
    fun \`child mode never honors exclusions\`() {}

    @Test
    fun regularName() {}
}
`
    );
    const analyzer = new TestFrameworkAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });
    assert.deepEqual(caseNodes(contribution.nodes).map(node => node.name).sort(), [
      'child mode never honors exclusions',
      'regularName',
    ]);
  } finally {
    await fs.remove(root);
  }
});

test('RSpec: extracts it blocks from describe do ... end', async () => {
  const root = await makeProject('rspec');
  try {
    await fs.writeFile(
      path.join(root, 'calc_spec.rb'),
      `require 'rspec'

RSpec.describe Calc do
  it 'adds numbers' do
    expect(Calc.add(1, 2)).to eq(3)
  end

  it 'subtracts numbers' do
    expect(Calc.sub(2, 1)).to eq(1)
  end
end
`
    );
    const analyzer = new TestFrameworkAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });
    const cases = caseNodes(contribution.nodes);
    assert.deepEqual(cases.map(c => c.name).sort(), ['adds numbers', 'subtracts numbers']);
    assert.strictEqual(suiteNodes(contribution.nodes)[0].metadata?.framework, 'rspec');
  } finally {
    await fs.remove(root);
  }
});

test('does not double-own a Jest-style file that lacks distinguishing evidence', async () => {
  const root = await makeProject('nojest');
  try {
    // Plain jest describe/it with no vitest/mocha/etc import — jest-analyzer owns
    // this; TestFrameworkAnalyzer must stay out.
    await fs.writeFile(
      path.join(root, 'thing.test.ts'),
      `describe('thing', () => { it('works', () => { expect(1).toBe(1); }); });\n`
    );
    const analyzer = new TestFrameworkAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });
    assert.strictEqual(suiteNodes(contribution.nodes).length, 0);
  } finally {
    await fs.remove(root);
  }
});
