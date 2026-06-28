import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { embeddingsBackend } from './embeddings';

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emb-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  }
  return dir;
}

test('embeddings: has stable id and reports mode in note', async () => {
  const dir = await makeRepo({ 'a.ts': 'export const x = 1;' });
  try {
    const res = await embeddingsBackend.retrieve({ repoPath: dir, query: 'x', k: 5 });
    assert.equal(res.backend, 'embeddings-rag');
    assert.ok(res.note && /proxy|tfidf|chunk/i.test(res.note), `note should record mode: ${res.note}`);
  } finally {
    await fs.remove(dir);
  }
});

test('embeddings: ranks the semantically-relevant file first', async () => {
  const dir = await makeRepo({
    'src/billing.ts': [
      'export function createInvoice(customer: string, amount: number) {',
      '  const invoice = { customer, amount, status: "unpaid" };',
      '  return saveInvoice(invoice);',
      '}',
    ].join('\n'),
    'src/geometry.ts': [
      'export function triangleArea(base: number, height: number) {',
      '  return 0.5 * base * height;',
      '}',
    ].join('\n'),
  });
  try {
    const res = await embeddingsBackend.retrieve({ repoPath: dir, query: 'create invoice for customer amount', k: 12 });
    assert.ok(res.candidates.length > 0);
    assert.equal(res.candidates[0].file, 'src/billing.ts');
    assert.ok(res.candidates[0].hint && res.candidates[0].hint.startsWith('chunk@L'));
  } finally {
    await fs.remove(dir);
  }
});

test('embeddings: returns repo-relative paths and dedupes to distinct files', async () => {
  const longChunk = Array.from({ length: 130 }, (_, i) => `const cacheEntry${i} = "cache lookup store value";`).join('\n');
  const dir = await makeRepo({ 'deep/dir/cache.ts': longChunk });
  try {
    const res = await embeddingsBackend.retrieve({ repoPath: dir, query: 'cache lookup store', k: 12 });
    assert.ok(res.candidates.length > 0);
    const files = res.candidates.map(c => c.file);
    assert.equal(new Set(files).size, files.length, 'files must be distinct (deduped)');
    for (const c of res.candidates) assert.ok(!path.isAbsolute(c.file));
  } finally {
    await fs.remove(dir);
  }
});

test('embeddings: empty repo returns empty with note, never throws', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emb-empty-'));
  try {
    const res = await embeddingsBackend.retrieve({ repoPath: dir, query: 'anything', k: 5 });
    assert.deepEqual(res.candidates, []);
    assert.ok(res.note);
  } finally {
    await fs.remove(dir);
  }
});

test('embeddings: nonexistent repo path degrades, does not throw', async () => {
  const res = await embeddingsBackend.retrieve({
    repoPath: path.join(os.tmpdir(), 'emb-missing-' + Date.now()),
    query: 'x',
    k: 5,
  });
  assert.deepEqual(res.candidates, []);
  assert.ok(res.note);
  assert.equal(typeof res.index_ms, 'number');
});

test('embeddings: query terms absent from corpus yields empty with note', async () => {
  const dir = await makeRepo({ 'a.ts': 'export const alpha = 1;' });
  try {
    const res = await embeddingsBackend.retrieve({ repoPath: dir, query: 'zzzznonexistentterm', k: 5 });
    assert.deepEqual(res.candidates, []);
    assert.ok(res.note);
  } finally {
    await fs.remove(dir);
  }
});

test('embeddings: respects k budget', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 10; i++) files[`mod${i}.ts`] = `export const handleEvent${i} = () => "event handler dispatch";`;
  const dir = await makeRepo(files);
  try {
    const res = await embeddingsBackend.retrieve({ repoPath: dir, query: 'event handler dispatch', k: 3 });
    assert.ok(res.candidates.length <= 3);
  } finally {
    await fs.remove(dir);
  }
});
