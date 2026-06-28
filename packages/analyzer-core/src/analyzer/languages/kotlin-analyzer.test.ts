import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KotlinAnalyzer } from './kotlin-analyzer';

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kotlin-analyzer-test-'));

  // App.kt: package, interface, a class extending it (supertype form), a
  // Composable function, and a top-level main.
  const app = [
    'package demo',
    '',
    'import androidx.compose.runtime.Composable',
    '',
    'interface Repo',
    '',
    'class UserService : Repo {',
    '    fun load() {',
    '        fetch()',
    '    }',
    '',
    '    private fun fetch() {}',
    '}',
    '',
    '@Composable',
    'fun Screen() {}',
    '',
    'fun main() {',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'App.kt'), app);

  return dir;
}

test('KotlinAnalyzer.canAnalyze returns true for a kotlin project', async () => {
  const dir = makeTempProject();
  try {
    const analyzer = new KotlinAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('KotlinAnalyzer.analyze extracts types, functions, inheritance, compose, calls, entry points', async () => {
  const dir = makeTempProject();
  try {
    const analyzer = new KotlinAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    // Type nodes: Repo (interface) + UserService (class).
    const repo = cas.nodes.find(n => n.name === 'Repo');
    const userService = cas.nodes.find(n => n.name === 'UserService');
    assert.ok(repo, 'Repo type node exists');
    assert.ok(userService, 'UserService type node exists');
    assert.equal(repo!.type, 'interface', 'Repo is an interface node');
    assert.equal(userService!.type, 'class', 'UserService is a class node');

    // Function/method nodes: load, fetch, Screen, main.
    const fnNodes = cas.nodes.filter(n => n.type === 'function' || n.type === 'method');
    const fnNames = fnNodes.map(n => n.name).sort();
    assert.deepEqual(fnNames, ['Screen', 'fetch', 'load', 'main'], 'extracts all functions');

    const load = fnNodes.find(n => n.name === 'load')!;
    const fetch = fnNodes.find(n => n.name === 'fetch')!;
    const screen = fnNodes.find(n => n.name === 'Screen')!;
    const main = fnNodes.find(n => n.name === 'main')!;
    assert.ok(load.source?.file && load.source?.line, 'load has source file+line');
    assert.equal(fetch.metadata?.attributes?.visibility, 'private', 'fetch is private');

    // Inheritance edge UserService -> Repo (implements, since Repo is an interface).
    const inheritEdge = cas.edges.find(e =>
      e.source === userService!.id && e.target === repo!.id &&
      (e.type === 'implements' || e.type === 'extends')
    );
    assert.ok(inheritEdge, 'inheritance edge UserService -> Repo exists');

    // Screen tagged compose-fn.
    assert.ok(screen.tags?.includes('compose-fn'), 'Screen tagged compose-fn');

    // calls edge load -> fetch.
    const callEdge = cas.edges.find(e =>
      e.type === 'calls' && e.source === load.id && e.target === fetch.id
    );
    assert.ok(callEdge, 'calls edge load -> fetch exists');

    // main is an entry point.
    const mainEntry = (cas.entry_points || []).find(ep => ep.source_node === main.id);
    assert.ok(mainEntry, 'main is registered as an entry point');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
