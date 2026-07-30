import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ElixirAnalyzer } from './elixir-analyzer';

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elixir-analyzer-test-'));
  fs.writeFileSync(
    path.join(dir, 'math.ex'),
    [
      'defmodule App.Math do',
      '  def add(a, b), do: sum(a, b)',
      '  defp sum(a, b), do: a + b',
      'end',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(dir, 'server.ex'),
    [
      'defmodule App.Server do',
      '  use GenServer',
      '',
      '  def init(s), do: {:ok, s}',
      'end',
      '',
    ].join('\n')
  );
  return dir;
}

test('ElixirAnalyzer.canAnalyze returns true for an elixir project', async () => {
  const dir = makeProject();
  try {
    const analyzer = new ElixirAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ElixirAnalyzer.analyze extracts modules, functions, calls, tags, and entry points', async () => {
  const dir = makeProject();
  try {
    const analyzer = new ElixirAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    const modules = cas.nodes!.filter(n => n.type === 'module');
    const mathMod = modules.find(n => n.qualified_name === 'App.Math');
    const serverMod = modules.find(n => n.qualified_name === 'App.Server');
    assert.ok(mathMod, 'should have module App.Math');
    assert.ok(serverMod, 'should have module App.Server');

    const functions = cas.nodes!.filter(n => n.type === 'function');
    const add = functions.find(n => n.name === 'add');
    const sum = functions.find(n => n.name === 'sum');
    const init = functions.find(n => n.name === 'init');
    assert.ok(add, 'should have function add');
    assert.ok(sum, 'should have function sum');
    assert.ok(init, 'should have function init');

    // Visibility tags
    assert.equal(add!.metadata?.access_modifier, 'public');
    assert.equal(sum!.metadata?.access_modifier, 'private');

    // calls edge add -> sum
    const callEdge = cas.edges!.find(
      e => e.type === 'calls' && e.source === add!.id && e.target === sum!.id
    );
    assert.ok(callEdge, "should have a 'calls' edge add -> sum");

    // App.Server tagged genserver
    assert.ok(
      (serverMod!.tags || []).includes('elixir:genserver'),
      'App.Server should be tagged genserver'
    );

    // an entry point exists (init OTP callback)
    assert.ok((cas.entry_points || []).length > 0, 'should have at least one entry point');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Regression fixture for task #84: the per-file line-based Elixir parser is
// a best-effort heuristic (do/end depth stack + regex matchers), not a real
// grammar, and this repo's per-file glob loop previously called it with no
// per-file guard. Any thrown exception on ONE file propagated to the
// analyze()-level catch and turned into "Elixir analysis failed" for the
// WHOLE repo, discarding every module/function already found in every other
// file. Assert the opposite: one file blowing up degrades gracefully to a
// named warning for that file, while the rest of the repo still analyzes.
test('ElixirAnalyzer.analyze isolates a single file that throws during parsing — other files still analyze', async () => {
  const dir = makeProject();
  const original = (ElixirAnalyzer.prototype as any).parseElixirFile;
  (ElixirAnalyzer.prototype as any).parseElixirFile = function (
    relativePath: string,
    fullPath: string,
    content: string
  ) {
    if (relativePath === 'math.ex') {
      throw new Error('synthetic parse failure (regression fixture for task #84)');
    }
    return original.call(this, relativePath, fullPath, content);
  };
  try {
    const analyzer = new ElixirAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    // The healthy file (server.ex) still contributed its module/function —
    // the whole-repo analysis did not abort.
    const modules = cas.nodes!.filter(n => n.type === 'module');
    assert.ok(
      modules.some(n => n.qualified_name === 'App.Server'),
      'App.Server should still be extracted even though math.ex threw'
    );
    assert.ok(
      !modules.some(n => n.qualified_name === 'App.Math'),
      'App.Math (the file that threw) should be absent, not silently swallowed'
    );

    // The failure is named, not silently swallowed.
    const warnings = (cas.analyzer_metadata as any)?.warnings || [];
    assert.ok(
      warnings.some((w: string) => w.includes('math.ex') && w.includes('synthetic parse failure')),
      `expected a warning naming math.ex and the failure reason, got: ${JSON.stringify(warnings)}`
    );
  } finally {
    (ElixirAnalyzer.prototype as any).parseElixirFile = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
