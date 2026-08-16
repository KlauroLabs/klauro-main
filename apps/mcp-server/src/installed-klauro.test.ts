import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  analyzeCasWithInstalledKlauro,
  initializeInstalledKlauroProject,
  prepareInstalledKlauroIncrementalBaseline,
} from './installed-klauro';

test('initializeInstalledKlauroProject binds the handed project through the configured product CLI', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-installed-init-'));
  const executable = path.join(root, 'fake-cli.cjs');
  const invocation = path.join(root, 'invocation.json');
  const project = path.join(root, 'repo');
  await fs.ensureDir(project);
  await fs.writeFile(executable, [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.KLAURO_FAKE_INVOCATION, JSON.stringify(process.argv.slice(2)));",
    "process.stdout.write(JSON.stringify({ status: 'success', project_id: 'project-proof' }));",
  ].join('\n'));
  const previousCommand = process.env.KLAURO_INSTALLED_CLI;
  try {
    process.env.KLAURO_INSTALLED_CLI = `${process.execPath} ${executable}`;
    const result = await initializeInstalledKlauroProject(project, {
      serverUrl: 'http://127.0.0.1:18787',
      env: { KLAURO_FAKE_INVOCATION: invocation },
    });
    assert.equal(result.project_id, 'project-proof');
    assert.deepEqual(await fs.readJson(invocation), [
      'init',
      project,
      '--json',
      '--server-url',
      'http://127.0.0.1:18787',
    ]);
  } finally {
    if (previousCommand === undefined) delete process.env.KLAURO_INSTALLED_CLI;
    else process.env.KLAURO_INSTALLED_CLI = previousCommand;
    await fs.remove(root);
  }
});

test('analyzeCasWithInstalledKlauro accepts a completed hosted CAS without incremental evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-installed-analyze-'));
  const executable = path.join(root, 'fake-cli.cjs');
  const invocation = path.join(root, 'invocation.json');
  const project = path.join(root, 'repo');
  await fs.ensureDir(project);
  await fs.writeFile(executable, [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.KLAURO_FAKE_INVOCATION, JSON.stringify(process.argv.slice(2)));",
    "process.stdout.write(JSON.stringify({ cas: { nodes: [{ id: 'node' }], edges: [] }, analysis_type: 'full' }));",
  ].join('\n'));
  const previousCommand = process.env.KLAURO_INSTALLED_CLI;
  try {
    process.env.KLAURO_INSTALLED_CLI = `${process.execPath} ${executable}`;
    const result = await analyzeCasWithInstalledKlauro(project, {
      serverUrl: 'http://127.0.0.1:18787',
      analysisFocus: 'full',
      forceFull: true,
      env: { KLAURO_FAKE_INVOCATION: invocation },
    });
    assert.equal(result.output.nodes.length, 1);
    assert.equal(result.changeReport, undefined);
    assert.deepEqual(await fs.readJson(invocation), [
      'analyze',
      project,
      '--json',
      '--wait',
      '--server-url',
      'http://127.0.0.1:18787',
      '--force',
      '--analysis-focus',
      'full',
    ]);
  } finally {
    if (previousCommand === undefined) delete process.env.KLAURO_INSTALLED_CLI;
    else process.env.KLAURO_INSTALLED_CLI = previousCommand;
    await fs.remove(root);
  }
});

test('prepareInstalledKlauroIncrementalBaseline combines full CAS output with real sync evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-installed-baseline-'));
  const executable = path.join(root, 'fake-cli.cjs');
  const invocation = path.join(root, 'invocations.jsonl');
  const project = path.join(root, 'repo');
  await fs.ensureDir(project);
  await fs.writeFile(executable, [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(process.env.KLAURO_FAKE_INVOCATION, `${JSON.stringify(args)}\\n`);",
    "const cas = args[0] === 'analyze' ? { nodes: [{ id: 'full-node' }], edges: [] } : { nodes: [{ id: 'sync-node' }], edges: [] };",
    "const payload = args[0] === 'sync' ? { cas, change_report: { summary: { changed_files: 0 }, impact: { affected_nodes: 0 } }, analysis_type: 'incremental' } : { cas, analysis_type: 'full' };",
    "process.stdout.write(JSON.stringify(payload));",
  ].join('\n'));
  const previousCommand = process.env.KLAURO_INSTALLED_CLI;
  try {
    process.env.KLAURO_INSTALLED_CLI = `${process.execPath} ${executable}`;
    const baseline = await prepareInstalledKlauroIncrementalBaseline(project, {
      serverUrl: 'http://127.0.0.1:18787',
      analysisFocus: 'agent-fast',
      env: { KLAURO_FAKE_INVOCATION: invocation },
    });
    assert.equal(baseline.result.output.nodes[0].id, 'full-node');
    assert.deepEqual(baseline.result.changeReport?.summary, { changed_files: 0 });
    assert.equal(baseline.result.wasFullRebuild, true);
    const invocations = (await fs.readFile(invocation, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(invocations, [
      ['analyze', project, '--json', '--wait', '--server-url', 'http://127.0.0.1:18787', '--force', '--analysis-focus', 'agent-fast'],
      ['sync', project, '--json', '--wait', '--server-url', 'http://127.0.0.1:18787'],
    ]);
  } finally {
    if (previousCommand === undefined) delete process.env.KLAURO_INSTALLED_CLI;
    else process.env.KLAURO_INSTALLED_CLI = previousCommand;
    await fs.remove(root);
  }
});
