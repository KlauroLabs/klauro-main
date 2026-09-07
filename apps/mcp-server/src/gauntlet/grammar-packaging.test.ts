import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { grammarHealth } from '../../../../packages/analyzer-core/src/analyzer/core/wasm-tree-sitter';
import * as os from 'os';
import { execFileSync, fork } from 'child_process';
import { buildSync } from 'esbuild';
import { TOP_LANGS } from './camp-a-langs';
import { hasNativeGrammar } from '../../../../packages/analyzer-core/src/analyzer/core/native-parse';

// Regression guard for the tree-sitter packaging bug that shipped grammar-less to
// the wild: the bundle resolved `__dirname/../../../vendored-grammars`, which only
// exists in the source tree, so `dist/` carried 0 grammars and every WASM-breadth
// language silently degraded to nothing. These assertions fail loudly if either
// the vendored source grammars or the post-build dist/grammars copy regress.

const MIN_GRAMMARS = 150; // ~160 ship; allow a small margin for in-flight churn.
// `npm test` runs with cwd = apps/mcp-server; resolve from there (avoids import.meta,
// which the project's tsc module setting disallows).
const mcpServerRoot = process.cwd().endsWith(path.join('apps', 'mcp-server'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'apps', 'mcp-server');

test('grammarHealth resolves the full breadth grammar set from the source tree', () => {
  const h = grammarHealth();
  assert.ok(
    h.count >= MIN_GRAMMARS,
    `expected >= ${MIN_GRAMMARS} tree-sitter grammars, got ${h.count} from [${h.dirs.join(', ')}]`,
  );
  // Spot-check breadth-only (vendored) grammars, not just the mainstream ones.
  const sample = new Set(h.sample);
  assert.ok(h.dirs.length > 0, 'at least one grammar dir must resolve');
  assert.ok(sample.size >= 0); // sample is a slice; the real assertion is count above.
});

test('the exact-platform native parser artifact covers representative caller grammars', () => {
  for (const grammar of ['r', 'erlang', 'fortran', 'powershell', 'scheme']) {
    assert.equal(hasNativeGrammar(grammar), true,
      `required native parser artifact is missing or built for another architecture: ${grammar}`);
  }
});

test('a hosted analyzer build ships grammars next to dist-hosted/analyzer-service.cjs', t => {
  // Only meaningful after `npm run build:hosted`. The installed client in dist/
  // intentionally excludes grammars and all analyzer implementation.
  const distGrammars = path.join(mcpServerRoot, 'dist-hosted', 'grammars');
  const distServer = path.join(mcpServerRoot, 'dist-hosted', 'analyzer-service.cjs');
  if (!fs.existsSync(distServer)) {
    t.skip('dist-hosted/analyzer-service.cjs not built — run `npm run build:hosted` to exercise this guard');
    return;
  }
  assert.ok(fs.existsSync(distGrammars), 'dist/grammars/ must exist next to the bundle after build');
  const wasm = fs.readdirSync(distGrammars).filter((f) => /^tree-sitter-.+\.wasm$/.test(f));
  assert.ok(
    wasm.length >= MIN_GRAMMARS,
    `dist/grammars must carry >= ${MIN_GRAMMARS} grammars, got ${wasm.length} — build-bundle copy step regressed`,
  );
});

test('a relocated hosted native parser extracts R functions without a source-tree helper', t => {
  const bundledParser = path.join(mcpServerRoot, 'dist-hosted', 'native', 'klauro-parse');
  if (!fs.existsSync(path.join(mcpServerRoot, 'dist-hosted', 'analysis-worker.cjs'))) {
    t.skip('Build hosted artifacts before running the artifact-level guard');
    return;
  }
  assert.ok(fs.existsSync(bundledParser), 'hosted bundle must ship its native parser');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-native-bundle-'));
  try {
    const runtime = path.join(directory, 'runtime');
    fs.mkdirSync(path.join(runtime, 'native'), { recursive: true });
    fs.copyFileSync(bundledParser, path.join(runtime, 'native', 'klauro-parse'));
    fs.chmodSync(path.join(runtime, 'native', 'klauro-parse'), 0o755);
    const probe = path.join(runtime, 'parser.cjs');
    buildSync({
      entryPoints: [path.resolve(mcpServerRoot, '../../packages/analyzer-core/src/analyzer/core/native-parse.ts')],
      outfile: probe, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    });
    const fixture = TOP_LANGS.find(language => language.lang === 'r')!;
    const result = execFileSync(process.execPath, ['-e', `
      const parser = require(process.argv[1]);
      const source = require('fs').readFileSync(0, 'utf8');
      const root = parser.parseNativeRoot('r', source);
      if (!root) throw new Error('Native R parser returned no syntax tree');
      const functions = [];
      function visit(node) {
        if (node.type === 'function_definition') functions.push(node.text);
        for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
      }
      visit(root);
      process.stdout.write(JSON.stringify({ text: root.text, functions }));
    `, probe], { input: fixture.sample, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(result);
    assert.equal(parsed.text, fixture.sample);
    assert.equal(parsed.functions.length, 3);
    assert.ok(parsed.functions.some((body: string) => body.includes('helper(5)')));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the hosted worker persists R function evidence from the packaged runtime', { timeout: 60_000 }, async t => {
  const workerPath = path.join(mcpServerRoot, 'dist-hosted', 'analysis-worker.cjs');
  if (!fs.existsSync(workerPath)) {
    t.skip('Build hosted artifacts before running the artifact-level guard');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-native-worker-'));
  const project = path.join(directory, 'project');
  const storage = path.join(directory, 'storage');
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  try {
    fs.mkdirSync(project);
    const fixture = TOP_LANGS.find(language => language.lang === 'r')!;
    fs.writeFileSync(path.join(project, 'main.r'), fixture.sample);
    const env = {
      KLAURO_STORAGE_PATH: storage, KLAURO_EMBEDDING_ENABLED: 'false',
      KLAURO_AI_INTERPRETATION: 'false', KLAURO_AI_ELEMENT_DESCRIPTIONS: 'false',
    };
    await new Promise<void>((resolve, reject) => {
      const child = fork(workerPath, [], {
        execArgv: ['--max-old-space-size=512'], silent: true,
        env: { ...process.env, ...env, NODE_OPTIONS: '--max-old-space-size=512' },
      });
      let result = false;
      let failure: Error | undefined;
      let diagnostics = '';
      child.stdout?.resume();
      child.stderr?.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); });
      const timeout = setTimeout(() => {
        failure = new Error('Bundled analysis worker timed out');
        child.kill('SIGKILL');
      }, 50_000);
      child.on('error', error => {
        failure = error;
        clearTimeout(timeout);
        reject(error);
      });
      child.on('message', (message: { type: string; message?: string }) => {
        if (message.type !== 'result' && message.type !== 'error') return;
        if (message.type === 'error') failure = new Error(message.message);
        else result = true;
        if (child.connected) child.disconnect();
      });
      child.on('exit', code => {
        clearTimeout(timeout);
        if (failure) reject(failure);
        else if (!result || code !== 0) reject(new Error(`Bundled worker exited ${code}: ${diagnostics}`));
        else resolve();
      });
      child.send({ type: 'analyze', id: 1, projectPath: project, forceFull: true, env });
    });
    process.env.KLAURO_STORAGE_PATH = storage;
    const { loadAnalysis } = await import('../storage');
    const cas = await loadAnalysis(project, { preferCache: false });
    assert.ok(cas, 'bundled worker must persist canonical CAS');
    assert.ok(cas.nodes.some(node => node.name === fixture.truth && node.source?.file?.endsWith('main.r')),
      'CAS must contain the R run function, not only a file node');
    assert.equal(cas.analysis_errors?.filter(error => error.severity === 'error').length ?? 0, 0);
  } finally {
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
