import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  probeClaudeJson,
  probeCursorMcpJson,
  checkMcpRegistration,
} from './mcp-registration-doctor';

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-mcp-doctor-'));
}

test('probeClaudeJson reports not registered when ~/.claude.json is absent', () => {
  const homeDir = makeTempHome();
  const result = probeClaudeJson({ homeDir });
  assert.strictEqual(result.registered, false);
  assert.strictEqual(result.exists, false);
});

test('probeClaudeJson finds a top-level klauro entry', () => {
  const homeDir = makeTempHome();
  fs.writeFileSync(
    path.join(homeDir, '.claude.json'),
    JSON.stringify({ mcpServers: { klauro: { command: 'node', args: ['/x/dist/index.cjs'] } } }),
  );
  const result = probeClaudeJson({ homeDir });
  assert.strictEqual(result.registered, true);
  assert.strictEqual(result.entry?.command, 'node');
  assert.deepStrictEqual(result.entry?.args, ['/x/dist/index.cjs']);
});

test('probeClaudeJson finds a project-scoped klauro entry', () => {
  const homeDir = makeTempHome();
  fs.writeFileSync(
    path.join(homeDir, '.claude.json'),
    JSON.stringify({
      mcpServers: {},
      projects: { '/repo/foo': { mcpServers: { klauro: { command: 'node', args: ['/repo/foo/dist/index.cjs'] } } } },
    }),
  );
  const result = probeClaudeJson({ homeDir, projectPath: '/repo/foo' });
  assert.strictEqual(result.registered, true);
  assert.match(result.scope, /project/);
});

test('probeClaudeJson tolerates malformed JSON', () => {
  const homeDir = makeTempHome();
  fs.writeFileSync(path.join(homeDir, '.claude.json'), '{ not valid json');
  const result = probeClaudeJson({ homeDir });
  assert.strictEqual(result.registered, false);
});

test('probeCursorMcpJson finds a klauro entry under ~/.cursor/mcp.json', () => {
  const homeDir = makeTempHome();
  fs.mkdirSync(path.join(homeDir, '.cursor'), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { klauro: { command: 'node', args: ['/y/dist/index.cjs'] } } }),
  );
  const result = probeCursorMcpJson({ homeDir });
  assert.strictEqual(result.registered, true);
});

test('checkMcpRegistration warns with remediation when nothing is registered', async () => {
  const homeDir = makeTempHome();
  const result = await checkMcpRegistration({ packageRoot: '/anything', homeDir, probeBoot: false });
  assert.strictEqual(result.status, 'warn');
  assert.match(result.fix || '', /klauro install --claude-scope user/);
});

test('checkMcpRegistration fails when the registered entry point does not exist on disk', async () => {
  const homeDir = makeTempHome();
  fs.writeFileSync(
    path.join(homeDir, '.claude.json'),
    JSON.stringify({ mcpServers: { klauro: { command: 'node', args: ['/definitely/missing/dist/index.cjs'] } } }),
  );
  const result = await checkMcpRegistration({ packageRoot: '/anything', homeDir, probeBoot: false });
  assert.strictEqual(result.status, 'fail');
  assert.match(result.detail, /does not exist on disk/);
});

test('checkMcpRegistration passes when registered and the entry point resolves (boot probe skipped)', async () => {
  const homeDir = makeTempHome();
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-mcp-doctor-pkg-'));
  const distDir = path.join(packageRoot, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const entryPath = path.join(distDir, 'index.cjs');
  fs.writeFileSync(entryPath, '// stub entry point\n');
  fs.writeFileSync(
    path.join(homeDir, '.claude.json'),
    JSON.stringify({ mcpServers: { klauro: { command: 'node', args: [entryPath] } } }),
  );
  const result = await checkMcpRegistration({ packageRoot, homeDir, probeBoot: false });
  assert.strictEqual(result.status, 'pass');
  assert.match(result.detail, /Boot probe skipped/);
});
