import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import stageFingerprintModule from './stage-fingerprints.cjs';
import buildSourceIdentity from './build-source-identity.cjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const analyzerCoreRoot = path.join(repoRoot, 'packages', 'analyzer-core');
const sourceRoot = path.join(packageRoot, 'src');
const hostedBuild = process.argv.includes('--hosted');

const packageVersion = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version || '1.0.0';
const stageFingerprints = stageFingerprintModule.computeBuildStageFingerprints(analyzerCoreRoot);
const definitions = {
  __KLAURO_GIT_SHA__: JSON.stringify(buildSourceIdentity.resolveBuildGitSha(packageRoot)),
  __KLAURO_BUILD_TIME__: JSON.stringify(buildSourceIdentity.resolveBuildTime()),
  __KLAURO_VERSION__: JSON.stringify(packageVersion),
  __KLAURO_PARSER_FINGERPRINT__: JSON.stringify(stageFingerprints.parser_fingerprint),
  __KLAURO_DERIVED_FINGERPRINT__: JSON.stringify(stageFingerprints.derived_fingerprint),
};

const nativePackages = [
  'tree-sitter', 'tree-sitter-javascript', 'tree-sitter-typescript', 'tree-sitter-c-sharp',
  'tree-sitter-go', 'tree-sitter-php', 'tree-sitter-rust', 'web-tree-sitter', 'tree-sitter-wasms',
  '@huggingface/transformers', '@xenova/transformers', 'onnxruntime-node', 'zstd-napi', 'fsevents',
];

const nativeExternals = {
  name: 'native-externals',
  setup(buildApi) {
    buildApi.onResolve({ filter: /.*/ }, args => {
      const pkg = nativePackages.find(name => args.path === name || args.path.startsWith(`${name}/`));
      if (!pkg) return null;
      if (!args.resolveDir) return { path: args.path, external: true };
      try {
        return { path: createRequire(path.join(args.resolveDir, 'resolve-anchor.js')).resolve(args.path), external: true };
      } catch { return { path: args.path, external: true }; }
    });
  },
};

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  logLevel: 'warning',
  absWorkingDir: packageRoot,
  define: definitions,
};

function copyGrammars(outputDir) {
  const grammarOut = path.join(outputDir, 'grammars');
  mkdirSync(grammarOut, { recursive: true });
  const sources = [path.join(analyzerCoreRoot, 'vendored-grammars')];
  try {
    const req = createRequire(path.join(packageRoot, 'resolve-anchor.js'));
    sources.push(path.join(path.dirname(req.resolve('tree-sitter-wasms/package.json')), 'out'));
  } catch {}
  for (const source of sources) {
    if (!existsSync(source)) continue;
    for (const file of readdirSync(source)) {
      if (!file.endsWith('.wasm')) continue;
      const target = path.join(grammarOut, file);
      if (!existsSync(target)) cpSync(path.join(source, file), target);
    }
  }
}

if (hostedBuild) {
  const nativeParser = path.join(analyzerCoreRoot, 'native', 'klauro-parse', 'target', 'release', 'klauro-parse');
  if (!existsSync(nativeParser) || !statSync(nativeParser).isFile()) {
    throw new Error('Hosted build requires the exact-platform native parser; build packages/analyzer-core/native/klauro-parse first.');
  }
  const nativeProbe = JSON.parse(execFileSync(nativeParser, ['r'], {
    input: '', encoding: 'utf8', timeout: 10_000, maxBuffer: 4096,
  }));
  if (nativeProbe.error || !nativeProbe.t) {
    throw new Error('Hosted build native parser did not return a valid syntax tree.');
  }
  const output = path.join(packageRoot, 'dist-hosted');
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  await build({ ...shared, entryPoints: ['src/analysis-worker.ts'], outfile: 'dist-hosted/analysis-worker.cjs', plugins: [nativeExternals] });
  await build({ ...shared, entryPoints: ['src/analysis-worker-proxy.ts'], outfile: 'dist-hosted/analysis-worker-proxy.cjs', plugins: [nativeExternals] });
  await build({ ...shared, entryPoints: ['src/analysis-worker-service.ts'], outfile: 'dist-hosted/analysis-worker-service.cjs', plugins: [nativeExternals] });
  await build({ ...shared, entryPoints: ['src/analysis-export-worker.ts'], outfile: 'dist-hosted/analysis-export-worker.cjs', plugins: [nativeExternals] });
  await build({ ...shared, entryPoints: ['src/account-workspace-analysis-worker.ts'], outfile: 'dist-hosted/account-workspace-analysis-worker.cjs', plugins: [nativeExternals] });
  await build({ ...shared, entryPoints: ['src/self-telemetry-worker.ts'], outfile: 'dist-hosted/self-telemetry-worker.cjs', plugins: [nativeExternals] });
  await build({ ...shared, entryPoints: ['src/hosted-project-query.ts'], outfile: 'dist-hosted/hosted-project-query-runtime.cjs', plugins: [nativeExternals] });
  await build({ ...shared, entryPoints: ['src/hosted-project-search-worker.ts'], outfile: 'dist-hosted/hosted-project-search-worker.cjs', plugins: [nativeExternals] });
  await build({ ...shared, entryPoints: ['src/hosted-project-query-worker.ts'], outfile: 'dist-hosted/hosted-project-query-worker.cjs', plugins: [nativeExternals] });
  await build({ ...shared, entryPoints: ['../../packages/analyzer-core/src/analyzer/core/tree-sitter-ts-worker.ts'], outfile: 'dist-hosted/tree-sitter-ts-worker.cjs', plugins: [nativeExternals] });
  await build({ ...shared, entryPoints: ['src/remote-analyzer-service.ts'], outfile: 'dist-hosted/analyzer-service.cjs', plugins: [nativeExternals] });
  writeFileSync(path.join(output, 'stage-fingerprints.json'), JSON.stringify(stageFingerprints, null, 2));
  copyGrammars(output);
  mkdirSync(path.join(output, 'native'), { recursive: true });
  cpSync(nativeParser, path.join(output, 'native', 'klauro-parse'));
  chmodSync(path.join(output, 'native', 'klauro-parse'), 0o755);
  console.log(`Built hosted analyzer artifacts in ${output}; these are never included in the customer package.`);
  process.exit(0);
}

const clientRuntime = path.join(sourceRoot, 'installed-client-runtime.ts');
const analyzerSource = path.join(sourceRoot, 'analyzer.ts');
const semanticSearchSource = path.join(sourceRoot, 'semantic-search.ts');
const deployableAnalysisSource = path.join(sourceRoot, 'deployable-analysis.ts');
const s3Source = path.join(sourceRoot, 's3-artifacts.ts');
const orchestratorSource = path.join(analyzerCoreRoot, 'src', 'analyzer', 'core', 'orchestrator.ts');
const buildIdentitySource = path.join(analyzerCoreRoot, 'src', 'analyzer', 'core', 'build-identity.ts');
const deployableUtilSource = path.join(analyzerCoreRoot, 'src', 'analyzer', 'core', 'deployable-evidence', 'util.ts');

function resolvedImport(args) {
  if (!args.resolveDir || !args.path.startsWith('.')) return null;
  const candidate = path.resolve(args.resolveDir, args.path);
  for (const suffix of ['', '.ts', '.js']) {
    const full = candidate.endsWith(suffix) ? candidate : `${candidate}${suffix}`;
    if (existsSync(full)) return full.replace(/\.js$/, '.ts');
  }
  return candidate.replace(/\.js$/, '.ts');
}

const installedBoundary = {
  name: 'installed-client-boundary',
  setup(buildApi) {
    buildApi.onResolve({ filter: /.*/ }, args => {
      const resolved = resolvedImport(args);
      if (resolved === analyzerSource || resolved === semanticSearchSource) {
        throw new Error(`Installed client attempted to import hosted-only module: ${resolved}`);
      }
      if ([s3Source, deployableAnalysisSource, orchestratorSource, buildIdentitySource, deployableUtilSource].includes(resolved)) return { path: clientRuntime };
      return null;
    });
  },
};

const output = path.join(packageRoot, 'dist');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const minimumClientNodeMajor = 20;
const runtimeGuard = `if (Number(process.versions.node.split('.')[0]) < ${minimumClientNodeMajor}) { console.error('Klauro requires Node.js ${minimumClientNodeMajor} or newer.'); process.exit(1); }`;
const serverResult = await build({ ...shared, entryPoints: ['src/index.ts'], outfile: 'dist/server.cjs', banner: { js: runtimeGuard }, plugins: [installedBoundary], metafile: true });
const cliResult = await build({ ...shared, entryPoints: ['src/installed-cli.ts'], outfile: 'dist/cli.cjs', banner: { js: `#!/usr/bin/env node\n${runtimeGuard}` }, plugins: [installedBoundary], metafile: true });
chmodSync(path.join(output, 'cli.cjs'), 0o755);
await build({ ...shared, entryPoints: ['src/bootstrap.ts'], outfile: 'dist/index.cjs', banner: { js: runtimeGuard }, external: ['./server.cjs'] });









const seaEntryResult = await build({ ...shared, entryPoints: ['src/installed-sea-entry.ts'], outfile: 'dist-sea/klauro-sea-entry.cjs', banner: { js: runtimeGuard }, plugins: [installedBoundary], metafile: true });













{
  const serviceSource = readFileSync(path.join(packageRoot, 'src', 'remote-analyzer-service.ts'), 'utf8');
  const authRoutes = [...new Set([...serviceSource.matchAll(/route === '(\/api\/auth\/[a-zA-Z0-9/_-]+)'/g)].map(match => match[1]))];
  if (authRoutes.length === 0) throw new Error('build-bundle: found zero /api/auth/* routes in remote-analyzer-service.ts — the extraction regex broke, fix it rather than silently skipping this gate.');
  const builtCli = readFileSync(path.join(output, 'cli.cjs'), 'utf8');
  const missingRoutes = authRoutes.filter(route => !builtCli.includes(route));



  const requiredCommandLiterals = ['admin-mint-reset-token'];
  const missingCommands = requiredCommandLiterals.filter(command => !builtCli.includes(command));
  if (missingRoutes.length || missingCommands.length) {
    throw new Error([
      'build-bundle: the shipped CLI (dist/cli.cjs) is missing client code for a real auth capability:',
      ...missingRoutes.map(route => `  route ${route} — add a client path to it in src/installed-cli.ts`),
      ...missingCommands.map(command => `  command \`${command}\` — register it in src/installed-cli.ts`),
      'This is the exact class of defect that shipped `reset-password`/`change-password`/`admin-mint-reset-token` unreachable to every customer — refusing to produce a customer package until it is fixed.',
    ].join('\n'));
  }
}




















{





  const RETIRED_VOCAB = ['CAS/WAS', 'WAS/DAS', 'DAS/WAS'];
  const builtFiles = [
    ['dist/cli.cjs', path.join(output, 'cli.cjs')],
    ['dist/server.cjs', path.join(output, 'server.cjs')],
    ['dist/index.cjs', path.join(output, 'index.cjs')],
    ['dist-sea/klauro-sea-entry.cjs', path.join(packageRoot, 'dist-sea', 'klauro-sea-entry.cjs')],
  ].filter(([, filePath]) => existsSync(filePath));
  const vocabViolations = [];
  for (const [label, filePath] of builtFiles) {
    const content = readFileSync(filePath, 'utf8');
    for (const banned of RETIRED_VOCAB) {
      if (content.includes(banned)) vocabViolations.push(`${label}: contains retired vocabulary "${banned}"`);
    }
  }
  if (vocabViolations.length) {
    throw new Error([
      'build-bundle: the compiled artifact about to ship contains retired WAS/DAS vocabulary — this is the exact "customer still sees CAS/WAS construction in klauro --help on a build cut after the purge landed" defect (task #129):',
      ...vocabViolations.map(v => `  ${v}`),
      'This means the tree this build ran against was stale relative to the purge commits (6606732a/4bb416d2/c5eef85e/c0f4694b) — rebase onto current master and rebuild, or (if this string is intentionally new) add it to docs/ vocabulary review rather than silently shipping it.',
    ].join('\n'));
  }
}

const mergedMetafile = { server: serverResult.metafile, cli: cliResult.metafile };
writeFileSync(path.join(output, 'bundle-metafile.json'), JSON.stringify(mergedMetafile));

const forbidden = [
  /apps\/mcp-server\/src\/analyzer\.ts$/,
  /apps\/mcp-server\/src\/analysis-worker\.ts$/,
  /apps\/mcp-server\/src\/remote-analyzer-service\.ts$/,
  /packages\/analyzer-core\/src\/analyzer\/(languages|frameworks|libraries|embedding|ast|packs)\//,
  /packages\/analyzer-core\/src\/analyzer\/core\/(orchestrator|tree-sitter|native-parse|generic-tree-sitter|graph-builder|enhanced-call-graph)/,
];
const inputs = [...Object.keys(serverResult.metafile.inputs), ...Object.keys(cliResult.metafile.inputs), ...Object.keys(seaEntryResult.metafile.inputs)].map(value => value.replace(/\\/g, '/'));
const violations = [...new Set(inputs.filter(input => forbidden.some(pattern => pattern.test(input))))];
if (violations.length) throw new Error(`Installed client contains hosted analyzer modules:\n${violations.join('\n')}`);

const CAPTURED = ['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list'];
function captureHandshake(profile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(output, 'server.cjs')], { env: { ...process.env, KLAURO_TOOL_PROFILE: profile, KLAURO_DEFER_START: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const capture = { methods: {} };
    let buffer = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Handshake ${profile} timed out: ${stderr}`)); }, 30000);
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === 1) capture.initialize = message.result;
        const method = CAPTURED[message.id - 2];
        if (method) capture.methods[method] = message.error ? { error: message.error } : { result: message.result };
        if (Object.keys(capture.methods).length === CAPTURED.length) {
          clearTimeout(timeout); child.kill(); resolve(capture); return;
        }
      }
    });
    child.stdin.write([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'klauro-build', version: '1' } } }), JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), ...CAPTURED.map((method, index) => JSON.stringify({ jsonrpc: '2.0', id: index + 2, method })), ''].join('\n'));
  });
}

const handshake = { core: await captureHandshake('core'), full: await captureHandshake('full') };
writeFileSync(path.join(output, 'handshake.json'), JSON.stringify(handshake));





writeFileSync(path.join(output, 'build-stamp.json'), `${JSON.stringify({
  version: packageVersion,
  git_sha: JSON.parse(definitions.__KLAURO_GIT_SHA__),
  build_time: JSON.parse(definitions.__KLAURO_BUILD_TIME__),
  parser_fingerprint: stageFingerprints.parser_fingerprint,
  derived_fingerprint: stageFingerprints.derived_fingerprint,
}, null, 2)}\n`);

const customerFiles = readdirSync(output).filter(file => statSync(path.join(output, file)).isFile());
const totalBytes = customerFiles.reduce((sum, file) => sum + statSync(path.join(output, file)).size, 0);
const maxBytes = Number(process.env.KLAURO_CLIENT_MAX_BYTES || 32 * 1024 * 1024);
if (totalBytes > maxBytes) throw new Error(`Installed client is ${(totalBytes / 1048576).toFixed(2)} MiB; limit is ${(maxBytes / 1048576).toFixed(2)} MiB.`);
const customerRoot = path.join(packageRoot, '.customer-package');
rmSync(customerRoot, { recursive: true, force: true });
mkdirSync(customerRoot, { recursive: true });
cpSync(output, path.join(customerRoot, 'dist'), { recursive: true });
writeFileSync(path.join(customerRoot, 'package.json'), JSON.stringify({
  name: '@klauro/mcp-server', version: packageVersion, private: false,
  description: 'Lightweight Klauro MCP and CLI client', main: 'dist/index.cjs',
  bin: { klauro: 'dist/cli.cjs' }, files: ['dist/'], dependencies: {},
  engines: { node: `>=${minimumClientNodeMajor}` }, license: 'UNLICENSED',
}, null, 2));
console.log(`Built installed client: ${(totalBytes / 1048576).toFixed(2)} MiB, ${inputs.length} bundled inputs, 0 forbidden analyzer modules.`);
