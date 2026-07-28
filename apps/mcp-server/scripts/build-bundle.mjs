import { spawn, spawnSync } from 'child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { chmodSync } from 'fs';
import { build } from 'esbuild';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const analyzerCoreRoot = path.resolve(packageRoot, '..', '..', 'packages', 'analyzer-core');

function resolveGitSha() {
  const revParse = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' });
  if (revParse.status !== 0) return 'unknown';
  const sha = String(revParse.stdout || '').trim();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return 'unknown';
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: packageRoot, encoding: 'utf8' });
  const dirty = status.status === 0 && String(status.stdout || '').trim().length > 0;
  return dirty ? `${sha}-dirty` : sha;
}

const buildGitSha = resolveGitSha();
const buildTime = new Date().toISOString();
const packageVersion = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version || '1.0.0';

// --- Stage fingerprints (see packages/analyzer-core/src/analyzer/core/stage-fingerprint.ts) ---
// Baked into the bundle as compile-time constants because the shipped bundle
// has no source tree to walk at runtime (server.cjs is a single flattened
// file). Must mirror the dev-channel file lists in stage-fingerprint.ts
// exactly, or a dev-checkout analysis and a bundled analysis of the same
// commit would disagree on whether the parse/graph pipeline changed.
function walkSourceFiles(dir, exts) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSourceFiles(full, exts));
    } else if (exts.some(ext => entry.name.endsWith(ext)) && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out.sort();
}

function hashSourceFiles(paths) {
  const hash = createHash('sha256');
  for (const filePath of paths) {
    hash.update(filePath);
    try {
      hash.update(readFileSync(filePath));
    } catch {
      hash.update('MISSING');
    }
  }
  return hash.digest('hex').slice(0, 16);
}

function hashBinaryIdentities(dir) {
  let entries;
  try {
    entries = readdirSync(dir).filter(f => f.endsWith('.wasm')).sort();
  } catch {
    return 'no-grammars';
  }
  const hash = createHash('sha256');
  for (const name of entries) {
    let size = -1;
    try {
      size = statSync(path.join(dir, name)).size;
    } catch {
      // leave size at -1
    }
    hash.update(`${name}:${size}`);
  }
  return hash.digest('hex').slice(0, 16);
}

const analyzerSrcDir = path.join(analyzerCoreRoot, 'src', 'analyzer');
const analyzerCoreDir = path.join(analyzerSrcDir, 'core');

const PARSER_LAYER_DIRS = [
  path.join(analyzerSrcDir, 'languages'),
  path.join(analyzerSrcDir, 'ast'),
];
const PARSER_LAYER_FILES = [
  path.join(analyzerCoreDir, 'tree-sitter-parser.ts'),
  path.join(analyzerCoreDir, 'native-parse.ts'),
  path.join(analyzerCoreDir, 'generic-tree-sitter-analyzer.ts'),
  path.join(analyzerCoreDir, 'estree-parse-cache.ts'),
  path.join(analyzerCoreDir, 'analyzer-file-read-cache.ts'),
  path.join(analyzerSrcDir, 'enhanced-call-graph-extractor.ts'),
  path.join(analyzerSrcDir, 'enhanced-rust-call-graph-extractor.ts'),
];

const parserSourceHash = hashSourceFiles(
  [...PARSER_LAYER_DIRS.flatMap(dir => walkSourceFiles(dir, ['.ts', '.tsx'])), ...PARSER_LAYER_FILES].sort()
);
const grammarHash = hashBinaryIdentities(path.join(analyzerCoreRoot, 'vendored-grammars'));
const parserFingerprint = `${parserSourceHash}-${grammarHash}`.slice(0, 16);

const parserFileSet = new Set(PARSER_LAYER_FILES);
const derivedFiles = walkSourceFiles(analyzerSrcDir, ['.ts', '.tsx']).filter(filePath => {
  if (parserFileSet.has(filePath)) return false;
  if (filePath === path.join(analyzerCoreDir, 'stage-fingerprint.ts')) return false;
  if (filePath === path.join(analyzerCoreDir, 'build-identity.ts')) return false;
  return !PARSER_LAYER_DIRS.some(dir => filePath.startsWith(dir + path.sep));
});
const derivedFingerprint = hashSourceFiles(derivedFiles);

const NATIVE_PACKAGES = [
  'tree-sitter',
  'tree-sitter-javascript',
  'tree-sitter-typescript',
  'tree-sitter-c-sharp',
  'tree-sitter-go',
  'tree-sitter-php',
  'tree-sitter-rust',
  // web-tree-sitter loads its OWN tree-sitter.wasm relative to its package dir at
  // runtime — bundling it breaks that load. tree-sitter-wasms is a grammar-data
  // package resolved via require.resolve. Keep both external (runtime deps in
  // node_modules) so the WASM breadth path works when installed/deployed, not
  // only in the dev tree.
  'web-tree-sitter',
  'tree-sitter-wasms',
  '@huggingface/transformers',
  '@xenova/transformers',
  'onnxruntime-node',
  'zstd-napi',
  'fsevents',
];

const nativeExternals = {
  name: 'native-externals',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /.*/ }, args => {
      const pkg = NATIVE_PACKAGES.find(
        name => args.path === name || args.path.startsWith(`${name}/`)
      );
      if (!pkg) return null;
      if (!args.resolveDir) return { path: args.path, external: true };
      const requireFrom = createRequire(path.join(args.resolveDir, 'resolve-anchor.js'));
      try {
        return { path: requireFrom.resolve(args.path), external: true };
      } catch {
        return { path: args.path, external: true };
      }
    });
  },
};

const sharedOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  logLevel: 'warning',
  absWorkingDir: packageRoot,
  define: {
    __KLAURO_GIT_SHA__: JSON.stringify(buildGitSha),
    __KLAURO_BUILD_TIME__: JSON.stringify(buildTime),
    __KLAURO_VERSION__: JSON.stringify(packageVersion),
    __KLAURO_PARSER_FINGERPRINT__: JSON.stringify(parserFingerprint),
    __KLAURO_DERIVED_FINGERPRINT__: JSON.stringify(derivedFingerprint),
  },
};

await build({
  ...sharedOptions,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/server.cjs',
  plugins: [nativeExternals],
});

await build({
  ...sharedOptions,
  entryPoints: ['src/analysis-worker.ts'],
  outfile: 'dist/analysis-worker.cjs',
  plugins: [nativeExternals],
});

await build({
  ...sharedOptions,
  entryPoints: ['../../packages/analyzer-core/src/analyzer/core/tree-sitter-ts-worker.ts'],
  outfile: 'dist/tree-sitter-ts-worker.cjs',
  plugins: [nativeExternals],
});

await build({
  ...sharedOptions,
  entryPoints: ['src/bootstrap.ts'],
  outfile: 'dist/index.cjs',
  external: ['./server.cjs'],
});

await build({
  ...sharedOptions,
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.cjs',
  banner: { js: '#!/usr/bin/env node' },
  plugins: [nativeExternals],
});
chmodSync(path.join(packageRoot, 'dist', 'cli.cjs'), 0o755);

// --- Ship the tree-sitter grammars next to the bundle ---------------------
// The bundle resolves grammars from `<dist>/grammars` first (see wasm-tree-sitter
// grammarDirs()). Without this copy, an installed/deployed bundle loses the 130
// vendored breadth grammars (and the mainstream ones), silently crippling
// structural analysis. Copy every tree-sitter-*.wasm we ship into dist/grammars.
{
  const fs = await import('fs');
  const grammarsOut = path.join(packageRoot, 'dist', 'grammars');
  fs.mkdirSync(grammarsOut, { recursive: true });
  const sources = [];
  const vendored = path.resolve(packageRoot, '..', '..', 'packages', 'analyzer-core', 'vendored-grammars');
  if (fs.existsSync(vendored)) sources.push(vendored);
  try {
    const reqAt = createRequire(path.join(packageRoot, 'resolve-anchor.js'));
    sources.push(path.join(path.dirname(reqAt.resolve('tree-sitter-wasms/package.json')), 'out'));
  } catch { /* tree-sitter-wasms not resolvable here — vendored dir still covers breadth */ }
  let copied = 0;
  for (const dir of sources) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.wasm')) continue;
      const dest = path.join(grammarsOut, f);
      if (!fs.existsSync(dest)) { fs.copyFileSync(path.join(dir, f), dest); copied++; } // vendored wins (copied first)
    }
  }
  console.log(`Copied ${copied} tree-sitter grammar(s) into dist/grammars from ${sources.length} source dir(s).`);
}

const CAPTURED_LIST_METHODS = ['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list'];

function captureHandshake(profile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(packageRoot, 'dist', 'server.cjs')], {
      env: { ...process.env, KLAURO_TOOL_PROFILE: profile, KLAURO_DEFER_START: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const capture = { methods: {} };
    let buffer = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Handshake capture for profile ${profile} timed out; stderr: ${stderr}`));
    }, 30000);
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === 1) capture.initialize = message.result;
        const methodIndex = message.id - 2;
        if (methodIndex >= 0 && methodIndex < CAPTURED_LIST_METHODS.length) {
          if (message.error) {
            capture.methods[CAPTURED_LIST_METHODS[methodIndex]] = { error: message.error };
          } else {
            capture.methods[CAPTURED_LIST_METHODS[methodIndex]] = { result: message.result };
          }
          if (Object.keys(capture.methods).length === CAPTURED_LIST_METHODS.length) {
            clearTimeout(timeout);
            child.kill();
            resolve(capture);
            return;
          }
        }
      }
    });
    child.stdin.write([
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'klauro-build-capture', version: '1.0.0' },
        },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      ...CAPTURED_LIST_METHODS.map((method, index) =>
        JSON.stringify({ jsonrpc: '2.0', id: index + 2, method })),
      '',
    ].join('\n'));
  });
}

const handshake = {
  core: await captureHandshake('core'),
  full: await captureHandshake('full'),
};
writeFileSync(path.join(packageRoot, 'dist', 'handshake.json'), JSON.stringify(handshake));
const toolCount = profile => handshake[profile].methods['tools/list'].result.tools.length;
console.log(`Built dist/index.cjs (bootstrap), dist/server.cjs, dist/cli.cjs, dist/handshake.json (core: ${toolCount('core')} tools, full: ${toolCount('full')} tools, build ${packageVersion}+${buildGitSha} at ${buildTime}, parser-fp ${parserFingerprint}, derived-fp ${derivedFingerprint})`);
