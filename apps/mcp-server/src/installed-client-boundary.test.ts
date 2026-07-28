import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { isRegisteredSourceExtension } from '../../../packages/analyzer-core/src/analyzer/core/language-registry';
import { collectExplicitWorkingChanges } from './installed-client-server';

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

test('hosted bundle derives stage fingerprints from analyzer sources', () => {
  const buildScript = readFileSync(path.join(root, 'scripts', 'build-bundle.mjs'), 'utf8');
  assert.match(buildScript, /computeBuildStageFingerprints\(analyzerCoreRoot\)/);
  assert.match(buildScript, /__KLAURO_PARSER_FINGERPRINT__:\s*JSON\.stringify\(stageFingerprints\.parser_fingerprint\)/);
  assert.match(buildScript, /__KLAURO_DERIVED_FINGERPRINT__:\s*JSON\.stringify\(stageFingerprints\.derived_fingerprint\)/);
  assert.doesNotMatch(buildScript, /__KLAURO_(?:PARSER|DERIVED)_FINGERPRINT__:\s*JSON\.stringify\(['"]hosted['"]\)/);
});

function metafileInputs(): string[] {
  const meta = JSON.parse(readFileSync(path.join(dist, 'bundle-metafile.json'), 'utf8'));
  return [...Object.keys(meta.server.inputs), ...Object.keys(meta.cli.inputs)].map(value => value.replace(/\\/g, '/'));
}

test('installed package contains only the lightweight client artifacts', () => {
  assert.equal(existsSync(path.join(dist, 'analysis-worker.cjs')), false);
  assert.equal(existsSync(path.join(dist, 'tree-sitter-ts-worker.cjs')), false);
  assert.equal(existsSync(path.join(dist, 'grammars')), false);
  assert.equal(existsSync(path.join(dist, 'server.cjs')), true);
  assert.equal(existsSync(path.join(dist, 'cli.cjs')), true);
});

test('installed bundle graph excludes hosted analyzer implementation', () => {
  const forbidden = [
    /apps\/mcp-server\/src\/analyzer\.ts$/,
    /apps\/mcp-server\/src\/analysis-worker\.ts$/,
    /apps\/mcp-server\/src\/remote-analyzer-service\.ts$/,
    /packages\/analyzer-core\/src\/analyzer\/(languages|frameworks|libraries|embedding|ast|packs)\//,
    /packages\/analyzer-core\/src\/analyzer\/core\/(orchestrator|tree-sitter|native-parse|generic-tree-sitter|graph-builder|enhanced-call-graph)/,
  ];
  const violations = metafileInputs().filter(input => forbidden.some(pattern => pattern.test(input)));
  assert.deepEqual(violations, []);
  const analyzerCoreInputs = metafileInputs().filter(input => input.includes('packages/analyzer-core/src/analyzer/'));
  assert.deepEqual([...new Set(analyzerCoreInputs)], ['../../packages/analyzer-core/src/analyzer/core/language-registry.ts']);
  for (const forbidden of ['cross-codebase-analysis', 'workspace-analysis', 'proposal-preview', 'greenfield', 'semantic-search']) {
    assert.equal(metafileInputs().some(input => input.includes(forbidden)), false, forbidden);
  }
});

test('installed client remains below the distribution size budget', () => {
  const bytes = readdirSync(dist)
    .filter(file => statSync(path.join(dist, file)).isFile())
    .reduce((sum, file) => sum + statSync(path.join(dist, file)).size, 0);
  assert.ok(bytes <= 32 * 1024 * 1024, `installed client is ${(bytes / 1048576).toFixed(2)} MiB`);
});

test('installed CLI exposes hosted analysis but no analyzer server', () => {
  const help = execFileSync(process.execPath, [path.join(dist, 'cli.cjs'), '--help'], { encoding: 'utf8' });
  assert.match(help, /analyze \[path\]/);
  assert.match(help, /remote-sync \[path\]/);
  assert.match(help, /install\s+Register the lightweight MCP/);
  assert.match(help, /--register/);
  assert.doesNotMatch(help, /analyzer-server/);
});

test('installed MCP advertises uploads, hosted intelligence, revision, and watch tools', () => {
  const handshake = JSON.parse(readFileSync(path.join(dist, 'handshake.json'), 'utf8'));
  const names = handshake.full.methods['tools/list'].result.tools.map((tool: { name: string }) => tool.name).sort();
  assert.deepEqual(names, [
    'analyze_codebase', 'get_agent_revision_tracks', 'get_conceptual_analysis',
    'get_data_entities', 'get_product_map', 'get_semantic_coverage', 'get_agent_start_context',
    'get_agent_tool_plan', 'get_agent_context', 'search_nodes', 'get_coding_context',
    'assess_change_risk', 'find_tests', 'get_user_journeys', 'run_answer_pack',
    'get_codebase_idioms', 'get_behavioral_invariants', 'validate_codebase_idioms',
    'validate_behavioral_invariants',
    'get_summary', 'get_upload_manifest', 'get_watch_status', 'list_watches',
    'poll_watch_changes', 'resolve_agent_analysis', 'start_watch', 'stop_watch',
    'sync_codebase_remote',
  ].sort());
  for (const forbidden of ['run_workspace_analysis', 'run_cross_codebase_analysis', 'preview_codebase_iteration', 'preview_greenfield_codebase', 'semantic_search', 'query_graph']) {
    assert.equal(names.includes(forbidden), false, forbidden);
  }
});

test('installed source selection recognizes filenames using the hosted registry contract', () => {
  assert.equal(isRegisteredSourceExtension('server.ts'), true);
  assert.equal(isRegisteredSourceExtension('src/App.tsx'), true);
  assert.equal(isRegisteredSourceExtension('.ts'), true);
  assert.equal(isRegisteredSourceExtension('README'), false);
});

test('installed validation collector handles a greenfield repository with no HEAD', () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'klauro-validation-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(path.join(repo, 'service.ts'), 'export const value = 1;\n');
  const changes = collectExplicitWorkingChanges(repo);
  assert.deepEqual(changes.files, ['service.ts']);
  assert.match(changes.diff_text, /new file mode/);
  assert.match(changes.diff_text, /export const value = 1/);
});

test('installed validation collector never transmits secret files', () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'klauro-validation-secrets-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(path.join(repo, '.env.staging'), 'SECRET=never-send\n');
  writeFileSync(path.join(repo, 'service.ts'), 'export const safe = true;\n');
  const changes = collectExplicitWorkingChanges(repo);
  assert.deepEqual(changes.files, ['service.ts']);
  assert.doesNotMatch(changes.diff_text, /never-send|\.env\.staging/);
});

test('generated customer package installs without analyzer dependencies or native modules', () => {
  const customerRoot = path.join(root, '.customer-package');
  const manifest = JSON.parse(readFileSync(path.join(customerRoot, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, {});
  const packDir = mkdtempSync(path.join(os.tmpdir(), 'klauro-pack-'));
  const packed = execFileSync('npm', ['pack', customerRoot, '--pack-destination', packDir, '--json'], { encoding: 'utf8' });
  const tarball = path.join(packDir, JSON.parse(packed)[0].filename);
  const prefix = path.join(packDir, 'installed');
  execFileSync('npm', ['install', '--ignore-scripts', '--prefix', prefix, tarball], { encoding: 'utf8' });
  const installed = path.join(prefix, 'node_modules', '@klauro', 'mcp-server');
  assert.equal(existsSync(path.join(installed, 'dist', 'grammars')), false);
  assert.equal(existsSync(path.join(installed, 'dist', 'analysis-worker.cjs')), false);
  assert.equal(existsSync(path.join(installed, 'node_modules')), false);
  const installedBytes = directoryBytes(installed);
  assert.ok(installedBytes <= 3 * 1024 * 1024, `installed footprint is ${(installedBytes / 1048576).toFixed(2)} MiB`);
});

function directoryBytes(directory: string): number {
  return readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const target = path.join(directory, entry.name);
    return total + (entry.isDirectory() ? directoryBytes(target) : statSync(target).size);
  }, 0);
}
