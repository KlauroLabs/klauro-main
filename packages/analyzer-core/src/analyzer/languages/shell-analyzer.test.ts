import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ShellAnalyzer } from './shell-analyzer';

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-analyzer-test-'));

  // lib.sh: defines foo() and bar(), where bar calls foo. No shebang.
  const lib = [
    '#!/usr/bin/env bash',
    '# helper library',
    'foo() {',
    '  echo "in foo"',
    '}',
    '',
    'function bar {',
    '  # TODO: improve bar',
    '  foo',
    '  echo "in bar"',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'lib.sh'), lib);

  // main.sh: shebang + sources lib.sh + calls curl (external)
  const main = [
    '#!/bin/sh',
    '. ./lib.sh',
    'bar',
    'curl https://example.com',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'main.sh'), main);

  return dir;
}

test('ShellAnalyzer.canAnalyze returns true for a shell project', async () => {
  const dir = makeTempProject();
  try {
    const analyzer = new ShellAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ShellAnalyzer.analyze extracts functions, calls, sources, and entry points', async () => {
  const dir = makeTempProject();
  try {
    const analyzer = new ShellAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    // Function nodes for foo + bar
    const functionNodes = cas.nodes.filter(n => n.type === 'function');
    const functionNames = functionNodes.map(n => n.name).sort();
    assert.deepEqual(functionNames, ['bar', 'foo'], 'should extract foo and bar');

    const foo = functionNodes.find(n => n.name === 'foo')!;
    const bar = functionNodes.find(n => n.name === 'bar')!;
    assert.ok(foo, 'foo node exists');
    assert.ok(bar, 'bar node exists');
    assert.equal(foo.metadata?.language, 'shell');
    assert.ok(foo.source?.file && foo.source?.line, 'foo has source file+line');

    // 'calls' edge bar -> foo
    const callEdge = cas.edges.find(e =>
      e.type === 'calls' && e.source === bar.id && e.target === foo.id
    );
    assert.ok(callEdge, "should have a 'calls' edge from bar to foo");

    // Sourcing edge: main.sh imports lib.sh
    const sourceEdge = cas.edges.find(e => e.type === 'imports');
    assert.ok(sourceEdge, "should have an 'imports' (source) edge");

    // Entry points: both files have shebangs
    const entryNames = (cas.entry_points || []).map(e => e.name);
    assert.ok(
      entryNames.some(n => n.includes('main.sh')),
      'main.sh (shebang) should be an entry point'
    );
    const mainEntry = (cas.entry_points || []).find(entry => entry.name.includes('main.sh'));
    assert.equal(mainEntry?.metadata?.cli_origin, 'filesystem-executable');
    assert.equal(mainEntry?.metadata?.cli_product_role, 'supporting-mechanism');
    assert.equal((cas.entry_points || []).length, 2, 'semantic role must not remove shell entries');

    // External command exit point for curl
    const curlExit = (cas.exit_points || []).find(e => e.name.includes('curl'));
    assert.ok(curlExit, 'curl should be an external exit point');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ShellAnalyzer treats conventional build and test scripts as CLI entry points without a shebang', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-command-surface-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'build.sh'), 'cargo build --release\n');
    fs.writeFileSync(path.join(dir, 'test.sh'), 'cargo test\n');

    const cas = await new ShellAnalyzer().analyze({ projectPath: dir });
    const names = (cas.entry_points || []).map(entry => entry.name);

    assert.ok(names.includes('Shell script: build.sh'));
    assert.ok(names.includes('Shell script: test.sh'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
