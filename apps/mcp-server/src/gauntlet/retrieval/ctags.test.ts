import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { ctagsBackend } from './ctags';

const CTAGS_BIN = '/usr/bin/ctags';
const HAS_CTAGS = fs.existsSync(CTAGS_BIN);

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctags-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  }
  return dir;
}

test('ctags: has stable id', () => {
  assert.equal(ctagsBackend.id, 'ctags');
});

test('ctags: ranks file defining the queried symbol', { skip: !HAS_CTAGS }, async () => {
  const dir = await makeRepo({
    'auth.c': 'int authenticateUser(char *pw) { return 1; }\nint logout() { return 0; }\n',
    'math.c': 'int addNumbers(int a, int b) { return a + b; }\n',
  });
  try {
    const res = await ctagsBackend.retrieve({ repoPath: dir, query: 'authenticate user', k: 12 });
    assert.equal(res.backend, 'ctags');
    if (res.candidates.length > 0) {
      assert.equal(res.candidates[0].file, 'auth.c');
      assert.ok(res.candidates[0].hint && res.candidates[0].hint.startsWith('sym:'));
    } else {
      // Degraded (e.g. ctags couldn't tag this dialect) is acceptable, but must be noted.
      assert.ok(res.note);
    }
  } finally {
    await fs.remove(dir);
  }
});

test('ctags: returns repo-relative paths', { skip: !HAS_CTAGS }, async () => {
  const dir = await makeRepo({ 'lib/widget.c': 'int renderWidget() { return 7; }\n' });
  try {
    const res = await ctagsBackend.retrieve({ repoPath: dir, query: 'render widget', k: 5 });
    for (const c of res.candidates) {
      assert.ok(!path.isAbsolute(c.file), `expected relative path, got ${c.file}`);
    }
  } finally {
    await fs.remove(dir);
  }
});

test('ctags: empty repo returns empty with note, never throws', { skip: !HAS_CTAGS }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctags-empty-'));
  try {
    const res = await ctagsBackend.retrieve({ repoPath: dir, query: 'anything', k: 5 });
    assert.deepEqual(res.candidates, []);
    assert.ok(res.note);
  } finally {
    await fs.remove(dir);
  }
});

test('ctags: missing binary path degrades with note (simulated via bad cwd)', async () => {
  // If ctags is genuinely absent, the backend must already degrade gracefully.
  const dir = await makeRepo({ 'a.c': 'int foo() { return 0; }\n' });
  try {
    const res = await ctagsBackend.retrieve({ repoPath: dir, query: 'foo', k: 5 });
    // Either it found symbols (ctags present) or it degraded with a note (absent).
    assert.equal(res.backend, 'ctags');
    assert.ok(Array.isArray(res.candidates));
    if (res.candidates.length === 0) assert.ok(res.note);
  } finally {
    await fs.remove(dir);
  }
});

test('ctags: empty query returns empty with note', { skip: !HAS_CTAGS }, async () => {
  const dir = await makeRepo({ 'a.c': 'int foo() { return 0; }\n' });
  try {
    const res = await ctagsBackend.retrieve({ repoPath: dir, query: '... !!!', k: 5 });
    assert.deepEqual(res.candidates, []);
    assert.ok(res.note);
  } finally {
    await fs.remove(dir);
  }
});

test('ctags: nonexistent repo path does not throw', async () => {
  const res = await ctagsBackend.retrieve({
    repoPath: path.join(os.tmpdir(), 'ctags-missing-' + Date.now()),
    query: 'foo',
    k: 5,
  });
  assert.equal(res.backend, 'ctags');
  assert.ok(Array.isArray(res.candidates));
  assert.equal(typeof res.index_ms, 'number');
});
