import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverTargets, nestedGitRepoIgnorePatterns, repoAppearsToContainLanguage } from './gauntlet.js';

function makeTempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-gauntlet-test-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'tool.py'), 'print("hi")\n');
  const nested = path.join(root, 'nested-bot');
  fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
  fs.mkdirSync(path.join(nested, 'src'), { recursive: true });
  fs.writeFileSync(path.join(nested, 'src', 'main.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(nested, 'Cargo.toml'), '[package]\nname = "bot"\n');
  return root;
}

test('nested git repos are excluded from language expectation resolution', async () => {
  const root = makeTempRepo();
  try {
    const ignores = await nestedGitRepoIgnorePatterns(root);
    assert.deepStrictEqual(ignores, ['nested-bot/**']);

    assert.strictEqual(await repoAppearsToContainLanguage(root, 'Python'), true);
    assert.strictEqual(await repoAppearsToContainLanguage(root, 'TypeScript/JavaScript'), false);
    assert.strictEqual(await repoAppearsToContainLanguage(root, 'Rust'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('top-level language files still resolve as required', async () => {
  const root = makeTempRepo();
  try {
    fs.writeFileSync(path.join(root, 'index.ts'), 'export const y = 2;\n');
    assert.strictEqual(await repoAppearsToContainLanguage(root, 'TypeScript/JavaScript'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gauntlet discovery selects arbitrary eligible repositories without a named allowlist', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-gauntlet-discovery-'));
  const web = path.join(root, 'customer-portal');
  const worker = path.join(root, 'event-worker');
  const empty = path.join(root, 'empty-repo');

  for (const repo of [web, worker, empty]) {
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  }
  fs.writeFileSync(path.join(web, 'package.json'), '{"name":"customer-portal"}\n');
  fs.writeFileSync(path.join(web, 'index.ts'), 'export const portal = true;\n');
  fs.writeFileSync(path.join(worker, 'worker.py'), 'def process():\n    return True\n');
  fs.writeFileSync(path.join(worker, 'main.go'), 'package main\nfunc main() {}\n');

  try {
    const targets = await discoverTargets(root);
    assert.deepStrictEqual(targets.map(target => target.name), ['event-worker', 'customer-portal']);
    assert.deepStrictEqual(targets[0].expectation.requiredLanguages?.sort(), ['Go', 'Python']);
    assert.deepStrictEqual(targets[1].expectation.requiredLanguages, ['TypeScript/JavaScript']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
