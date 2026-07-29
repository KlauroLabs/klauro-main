import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkBundleStaleness, newestSourceMtime } from './bundle-staleness';

// The defect these cover: MCP clients are registered against dist/, so a
// bundle older than the sources beside it keeps starting, keeps answering
// initialize, and keeps listing tools while serving an outdated contract —
// with no outward sign that anything is out of date.

function scaffold(options: { buildTime?: string | null; sourceMtime?: Date; stamp?: unknown }): { root: string; dist: string; src: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-staleness-'));
  const dist = path.join(root, 'dist');
  const src = path.join(root, 'src');
  fs.mkdirSync(dist);
  fs.mkdirSync(src);
  if (options.stamp !== undefined) {
    fs.writeFileSync(path.join(dist, 'build-stamp.json'), JSON.stringify(options.stamp));
  } else if (options.buildTime !== null) {
    fs.writeFileSync(path.join(dist, 'build-stamp.json'), JSON.stringify({
      version: '1.0.0', git_sha: 'abc123', build_time: options.buildTime,
    }));
  }
  const sourceFile = path.join(src, 'installed-client-server.ts');
  fs.writeFileSync(sourceFile, 'export const x = 1;\n');
  if (options.sourceMtime) fs.utimesSync(sourceFile, options.sourceMtime, options.sourceMtime);
  return { root, dist, src };
}

test('a bundle newer than its sources is not stale', () => {
  const { root, dist, src } = scaffold({
    buildTime: new Date(Date.now()).toISOString(),
    sourceMtime: new Date(Date.now() - 3_600_000),
  });
  try {
    const result = checkBundleStaleness({ distDir: dist, sourceRoot: src });
    assert.equal(result.stale, false);
    assert.equal(result.note, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a bundle older than its sources reports the drift and how to fix it', () => {
  const buildTime = new Date(Date.now() - 8 * 3_600_000);
  const { root, dist, src } = scaffold({ buildTime: buildTime.toISOString(), sourceMtime: new Date() });
  try {
    const result = checkBundleStaleness({ distDir: dist, sourceRoot: src });
    assert.equal(result.stale, true);
    assert.ok(result.note?.includes('installed-client-server.ts'), result.note ?? '');
    assert.ok(result.note?.includes('run build'), result.note ?? '');
    assert.ok(result.note?.includes('restart'), result.note ?? '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a missing or unusable stamp is itself the condition worth reporting', () => {
  const missing = scaffold({ buildTime: null });
  try {
    assert.equal(checkBundleStaleness({ distDir: missing.dist, sourceRoot: missing.src }).stale, true);
  } finally { fs.rmSync(missing.root, { recursive: true, force: true }); }

  const unusable = scaffold({ stamp: { version: '1.0.0' } });
  try {
    const result = checkBundleStaleness({ distDir: unusable.dist, sourceRoot: unusable.src });
    assert.equal(result.stale, true);
    assert.ok(result.note?.includes('run build'), result.note ?? '');
  } finally { fs.rmSync(unusable.root, { recursive: true, force: true }); }
});

test('a customer install, which ships no sources, never reports staleness', () => {
  const { root, dist } = scaffold({ buildTime: new Date(0).toISOString() });
  try {
    const result = checkBundleStaleness({ distDir: dist, sourceRoot: path.join(root, 'does-not-exist') });
    assert.equal(result.stale, false);
    assert.equal(result.note, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('test edits and build output do not count as contract drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-staleness-scan-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, 'dist'), { recursive: true });
  const old = new Date(Date.now() - 3_600_000);
  fs.writeFileSync(path.join(src, 'real.ts'), 'export const a = 1;\n');
  fs.utimesSync(path.join(src, 'real.ts'), old, old);
  for (const noise of ['thing.test.ts', 'notes.md', path.join('dist', 'bundled.ts')]) {
    fs.writeFileSync(path.join(src, noise), 'x');
  }
  try {
    const newest = newestSourceMtime(src);
    assert.ok(newest, 'the scan found no source files at all');
    assert.equal(path.basename(newest!.file), 'real.ts');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the shipped build script emits the stamp the guard reads', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-bundle.mjs'), 'utf8');
  assert.ok(script.includes("'build-stamp.json'"), 'build-bundle.mjs no longer writes build-stamp.json, so the staleness guard is blind');
  assert.ok(/build_time:/.test(script), 'the stamp must carry build_time — the guard has nothing to compare without it');
});
