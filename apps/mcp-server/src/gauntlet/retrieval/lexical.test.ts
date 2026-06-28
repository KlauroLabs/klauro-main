import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { lexicalBackend } from './lexical';

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  }
  return dir;
}

test('lexical: ranks the obviously-relevant file first', async () => {
  const dir = await makeRepo({
    'src/auth/login.ts': 'export function authenticateUser(password: string) { return checkPassword(password); }',
    'src/util/math.ts': 'export function addNumbers(a: number, b: number) { return a + b; }',
    'src/util/strings.ts': 'export function capitalize(s: string) { return s.toUpperCase(); }',
  });
  try {
    const res = await lexicalBackend.retrieve({ repoPath: dir, query: 'authenticate user password login', k: 12 });
    assert.equal(res.backend, 'cursor-proxy');
    assert.ok(res.candidates.length > 0, 'should return candidates');
    assert.equal(res.candidates[0].file, 'src/auth/login.ts');
  } finally {
    await fs.remove(dir);
  }
});

test('lexical: returns repo-relative paths', async () => {
  const dir = await makeRepo({ 'a/b/widget.ts': 'export const renderWidget = () => "widget";' });
  try {
    const res = await lexicalBackend.retrieve({ repoPath: dir, query: 'render widget', k: 5 });
    assert.ok(res.candidates.length > 0);
    for (const c of res.candidates) {
      assert.ok(!path.isAbsolute(c.file), `expected relative path, got ${c.file}`);
    }
  } finally {
    await fs.remove(dir);
  }
});

test('lexical: empty repo returns empty candidates with a note, never throws', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-empty-'));
  try {
    const res = await lexicalBackend.retrieve({ repoPath: dir, query: 'anything', k: 5 });
    assert.deepEqual(res.candidates, []);
    assert.ok(res.note);
    assert.equal(typeof res.index_ms, 'number');
  } finally {
    await fs.remove(dir);
  }
});

test('lexical: nonexistent repo path degrades, does not throw', async () => {
  const res = await lexicalBackend.retrieve({
    repoPath: path.join(os.tmpdir(), 'does-not-exist-' + Date.now()),
    query: 'x',
    k: 5,
  });
  assert.deepEqual(res.candidates, []);
  assert.ok(res.note);
});

test('lexical: respects k budget', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 10; i++) files[`f${i}.ts`] = `export const handleRequest${i} = () => "request";`;
  const dir = await makeRepo(files);
  try {
    const res = await lexicalBackend.retrieve({ repoPath: dir, query: 'handle request', k: 3 });
    assert.ok(res.candidates.length <= 3);
  } finally {
    await fs.remove(dir);
  }
});

test('lexical: skips node_modules', async () => {
  const dir = await makeRepo({
    'src/payment.ts': 'export function processPayment() { return chargeCard(); }',
    'node_modules/dep/index.ts': 'export function processPayment() { return "vendor payment payment payment"; }',
  });
  try {
    const res = await lexicalBackend.retrieve({ repoPath: dir, query: 'process payment charge', k: 12 });
    assert.ok(res.candidates.length > 0);
    assert.ok(!res.candidates.some(c => c.file.includes('node_modules')), 'node_modules must be skipped');
  } finally {
    await fs.remove(dir);
  }
});

test('lexical: empty query returns empty with note', async () => {
  const dir = await makeRepo({ 'a.ts': 'export const x = 1;' });
  try {
    const res = await lexicalBackend.retrieve({ repoPath: dir, query: '!!! ??? ...', k: 5 });
    assert.deepEqual(res.candidates, []);
    assert.ok(res.note);
  } finally {
    await fs.remove(dir);
  }
});
