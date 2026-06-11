import { spawn, spawnSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { build } from 'esbuild';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const NATIVE_PACKAGES = [
  'tree-sitter',
  'tree-sitter-javascript',
  'tree-sitter-typescript',
  'tree-sitter-c-sharp',
  'tree-sitter-go',
  'tree-sitter-php',
  'tree-sitter-rust',
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
  entryPoints: ['src/bootstrap.ts'],
  outfile: 'dist/index.cjs',
  external: ['./server.cjs'],
});

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
console.log(`Built dist/index.cjs (bootstrap), dist/server.cjs, dist/handshake.json (core: ${toolCount('core')} tools, full: ${toolCount('full')} tools, build ${packageVersion}+${buildGitSha} at ${buildTime})`);
