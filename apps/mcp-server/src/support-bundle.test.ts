import { strict as assert } from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { test } from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { AnalysisRunLog } from '../../../packages/analyzer-core/src/analyzer/core/run-log';
import { saveAnalysis } from './storage';
import { buildSupportBundle, formatSupportBundleResult } from './support-bundle';

const execFileAsync = promisify(execFile);

const SECRET_SOURCE_TEXT = 'const klauroBundleSecretSourceMarker = "do-not-ship";';
const SECRET_API_KEY_VALUE = 'sk-klauro-bundle-secret-value';

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

function sampleAnalysis(projectPath: string): CASOutput {
  return {
    cas_version: '1.11.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis_bundle_test',
    system: {
      id: 'system_bundle-fixture',
      name: 'bundle-fixture',
      type: 'application',
      root_path: projectPath,
      technologies: { frameworks: [{ name: 'Express', version: '4.0.0' }] },
      quality: {},
    },
    nodes: [
      {
        id: 'node_1',
        type: 'function',
        name: 'handleOrder',
        source: { file: 'src/orders.ts', line: 10, raw: SECRET_SOURCE_TEXT },
      },
    ],
    edges: [{ id: 'edge_1', type: 'calls', source: 'node_1', target: 'node_1' }],
    entry_points: [],
    exit_points: [],
    analyzer_contributions: [
      {
        analyzer_id: 'typescript-javascript',
        analyzer_name: 'TypeScript/JavaScript Analyzer',
        analyzer_type: 'language',
        execution_time_ms: 42,
        nodes_created: 1,
        edges_created: 1,
      },
    ],
    analysis_errors: [
      {
        severity: 'warning',
        code: 'PARTIAL_ANALYSIS',
        message: 'Skipped 1 unreadable file',
        analyzer: 'typescript-javascript',
        recoverable: true,
      },
    ],
  } as unknown as CASOutput;
}

test('support bundle includes diagnostics and excludes source text and secret values', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-support-bundle-test-'));
  const projectPath = path.join(root, 'repo');
  const previous = {
    storage: process.env.KLAURO_STORAGE_PATH,
    logDir: process.env.KLAURO_LOG_DIR,
    toolLog: process.env.KLAURO_TOOL_CALL_LOG,
    compression: process.env.KLAURO_ANALYSIS_COMPRESSION,
    embeddingKey: process.env.KLAURO_EMBEDDING_API_KEY,
  };

  process.env.KLAURO_STORAGE_PATH = path.join(root, 'storage');
  process.env.KLAURO_LOG_DIR = path.join(root, 'logs');
  process.env.KLAURO_ANALYSIS_COMPRESSION = 'none';
  process.env.KLAURO_EMBEDDING_API_KEY = SECRET_API_KEY_VALUE;
  const toolCallLogPath = path.join(root, 'tool-calls.jsonl');
  process.env.KLAURO_TOOL_CALL_LOG = toolCallLogPath;

  try {
    await fs.ensureDir(projectPath);
    await saveAnalysis(projectPath, sampleAnalysis(projectPath));

    const runLog = new AnalysisRunLog(projectPath, 'analysis_bundle_run', '1.11.0');
    runLog.recordPhase('languageAnalyzers', Date.now() - 10, 10);
    runLog.complete({ nodes: 1, edges: 1, entry_points: 0, exit_points: 0, files: 1, errors: 0, warnings: 1 });

    await fs.writeFile(toolCallLogPath, `${JSON.stringify({ tool: 'get_summary', at: new Date().toISOString() })}\n`);

    const bundlePath = path.join(root, 'out', 'bundle.tar.gz');
    const result = await buildSupportBundle({ projectPath, outputPath: bundlePath });

    assert.equal(result.bundle_path, bundlePath);
    assert.ok(await fs.pathExists(bundlePath));

    const listing = (await execFileAsync('tar', ['-tzf', bundlePath])).stdout;
    for (const expected of [
      'klauro-support-bundle/environment.json',
      'klauro-support-bundle/analysis-runs.jsonl',
      'klauro-support-bundle/analysis-index-entry.json',
      'klauro-support-bundle/analysis-metadata.json',
      'klauro-support-bundle/mcp-tool-calls.jsonl',
      'klauro-support-bundle/manifest.json',
    ]) {
      assert.ok(listing.includes(expected), `bundle listing should include ${expected}`);
    }

    const extractDir = path.join(root, 'extracted');
    await fs.ensureDir(extractDir);
    await execFileAsync('tar', ['-xzf', bundlePath, '-C', extractDir]);
    const bundleRoot = path.join(extractDir, 'klauro-support-bundle');

    const allText = (await Promise.all(
      (await fs.readdir(bundleRoot)).map(file => fs.readFile(path.join(bundleRoot, file), 'utf8'))
    )).join('\n');
    assert.ok(!allText.includes(SECRET_SOURCE_TEXT), 'bundle must not contain node source text');
    assert.ok(!allText.includes(SECRET_API_KEY_VALUE), 'bundle must not contain secret env values');

    const metadata = await fs.readJson(path.join(bundleRoot, 'analysis-metadata.json'));
    assert.equal(metadata.counts.nodes, 1);
    assert.equal(metadata.counts.edges, 1);
    assert.equal(metadata.counts.analysis_errors, 0);
    assert.equal(metadata.counts.analysis_warnings, 1);
    assert.equal(metadata.analysis_errors[0].code, 'PARTIAL_ANALYSIS');
    assert.equal(metadata.nodes, undefined);
    assert.equal(metadata.edges, undefined);

    const environment = await fs.readJson(path.join(bundleRoot, 'environment.json'));
    assert.equal(environment.env.KLAURO_EMBEDDING_API_KEY, '[set]');
    assert.ok(environment.node_version.startsWith('v'));

    const runLogText = await fs.readFile(path.join(bundleRoot, 'analysis-runs.jsonl'), 'utf8');
    assert.ok(runLogText.includes('analysis_bundle_run'));
    assert.ok(runLogText.includes('languageAnalyzers'));

    const manifest = await fs.readJson(path.join(bundleRoot, 'manifest.json'));
    assert.ok(manifest.deliberately_excluded.some((item: string) => item.toLowerCase().includes('source code')));

    const formatted = formatSupportBundleResult(result);
    assert.ok(formatted.includes('Deliberately excluded (privacy):'));
    assert.ok(formatted.includes('analysis-metadata.json'));
  } finally {
    restoreEnv('KLAURO_STORAGE_PATH', previous.storage);
    restoreEnv('KLAURO_LOG_DIR', previous.logDir);
    restoreEnv('KLAURO_TOOL_CALL_LOG', previous.toolLog);
    restoreEnv('KLAURO_ANALYSIS_COMPRESSION', previous.compression);
    restoreEnv('KLAURO_EMBEDDING_API_KEY', previous.embeddingKey);
    await fs.remove(root);
  }
});

test('support bundle without a project path still includes environment and warns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-support-bundle-noproj-'));
  const previous = {
    logDir: process.env.KLAURO_LOG_DIR,
    toolLog: process.env.KLAURO_TOOL_CALL_LOG,
  };
  process.env.KLAURO_LOG_DIR = path.join(root, 'logs');
  delete process.env.KLAURO_TOOL_CALL_LOG;

  try {
    const bundlePath = path.join(root, 'bundle.tar.gz');
    const result = await buildSupportBundle({ outputPath: bundlePath });

    assert.ok(await fs.pathExists(bundlePath));
    const listing = (await execFileAsync('tar', ['-tzf', bundlePath])).stdout;
    assert.ok(listing.includes('klauro-support-bundle/environment.json'));
    assert.ok(!listing.includes('analysis-metadata.json'));
    assert.ok(result.warnings.some(warning => warning.includes('No project path')));
    assert.ok(result.warnings.some(warning => warning.includes('No analysis run log')));
  } finally {
    restoreEnv('KLAURO_LOG_DIR', previous.logDir);
    restoreEnv('KLAURO_TOOL_CALL_LOG', previous.toolLog);
    await fs.remove(root);
  }
});
