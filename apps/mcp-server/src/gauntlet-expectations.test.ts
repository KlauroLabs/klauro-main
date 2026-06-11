import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nestedGitRepoIgnorePatterns, repoAppearsToContainLanguage } from './gauntlet.js';

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
