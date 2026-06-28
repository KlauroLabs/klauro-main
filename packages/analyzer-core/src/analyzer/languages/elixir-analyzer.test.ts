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
