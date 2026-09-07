import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveFileAwareTestScript } from './agent-test-command';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

test('file-aware test selection follows declared simple aliases', () => {
  assert.equal(resolveFileAwareTestScript({ test: 'npm run verify', verify: 'jest --runInBand' }), 'test');
  assert.equal(resolveFileAwareTestScript({ test: 'vitest run' }), 'test');
  assert.equal(resolveFileAwareTestScript({ 'test:unit': 'node --test', test: 'jest' }), 'test:unit');
});

test('composite scripts and existing selectors never imply focused forwarding', () => {
  for (const script of [
    'npm run test:jest && npm run test:node',
    'jest src/all.test.ts',
    'node --test "src/**/*.test.ts"',
    'node scripts/test-suite.mjs',
    'jest; echo done',
    'vitest',
    'CUSTOM=1 jest',
  ]) {
    assert.equal(resolveFileAwareTestScript({ test: script }), null, script);
  }
});

test('verified aliases preserve npm lifecycle hooks and forward only the selected file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-test-command-'));
  const scripts = { pretest: 'node prepare.cjs', test: 'npm run verify', verify: 'node --test' };
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts }));
    await fs.writeFile(path.join(root, 'prepare.cjs'), 'require("node:fs").writeFileSync("prepared", "yes");');
    await fs.writeFile(path.join(root, 'selected.test.cjs'), 'require("node:test").test("selected test", () => {});');
    await fs.writeFile(path.join(root, 'unselected.test.cjs'), 'throw new Error("unselected test must not run");');
    assert.equal(resolveFileAwareTestScript(scripts), 'test');
    const { stdout } = await promisify(execFile)('npm', ['test', '--', 'selected.test.cjs'], {
      cwd: root, timeout: 20_000, env: { ...process.env, npm_config_update_notifier: 'false' },
    });
    assert.match(stdout, /selected test/);
    assert.equal(await fs.readFile(path.join(root, 'prepared'), 'utf8'), 'yes');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('alias cycles and missing scripts stay unresolved', () => {
  assert.equal(resolveFileAwareTestScript({ test: 'npm run unit', unit: 'npm test' }), null);
  assert.equal(resolveFileAwareTestScript({ test: 'npm run missing' }), null);
  assert.equal(resolveFileAwareTestScript({}), null);
});
