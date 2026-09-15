import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverFiles, classifyFile } from './source-discovery';

// Pass 1.1: one walk, one ignore policy, one file list, with configuration and
// manifests included. The previous inventory missed two kinds of file that
// matter and both were found on real repositories: extension manifests named
// something the registry does not know (openclaw.plugin.json, twenty of them,
// each declaring what an extension is) and extensionless executable scripts
// (scripts/pr, scripts/committer), which can be entry points.
//
// A shebang is the portable way to recognise the second: it is what the
// operating system itself uses, it works for every language, and reading two
// bytes from the extensionless files of a 5,566-file repository costs 6 ms.
//
// YAML is already a registered source language, because compose files, CI
// pipelines and Kubernetes manifests are parsed rather than merely listed.
// JSON is not, which is why 56 JSON files went missing on one repository.

function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-'));
  const write = (rel: string, content = 'x'): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write('package.json', '{}');
  write('src/index.ts', 'export const a = 1;');
  write('src/util.py', 'x = 1');
  write('tsconfig.json', '{}');
  write('config/settings.yaml', 'a: 1');
  write('extensions/voice/openclaw.plugin.json', '{}');
  write('scripts/deploy', '#!/usr/bin/env bash\necho hi\n');
  write('scripts/notes', 'just text, not a script\n');
  write('LICENSE', 'MIT');
  write('package-lock.json', '{}');
  write('assets/logo.png', 'PNG');
  write('node_modules/dep/index.js', 'module.exports = 1');
  write('dist/bundle.js', 'bundled');
  return root;
}

function kinds(root: string): Map<string, string> {
  return new Map(discoverFiles(root).files.map(f => [f.path, f.kind]));
}

test('one walk returns source, manifests, configuration and scripts', () => {
  const root = tree();
  try {
    const found = kinds(root);
    assert.equal(found.get('package.json'), 'manifest');
    assert.equal(found.get('src/index.ts'), 'source');
    assert.equal(found.get('src/util.py'), 'source');
    assert.equal(found.get('tsconfig.json'), 'config');
    assert.equal(found.get('config/settings.yaml'), 'source',
      'YAML is already a source language here: compose files, CI pipelines and manifests are parsed');
    assert.equal(found.get('extensions/voice/openclaw.plugin.json'), 'config',
      'an unrecognised manifest name still reaches the index as configuration');
    assert.equal(found.get('scripts/deploy'), 'script');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an extensionless file without a shebang is not a script', () => {
  const root = tree();
  try {
    const found = kinds(root);
    assert.equal(found.has('scripts/notes'), false);
    assert.equal(found.has('LICENSE'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lock files, media and build output are left out', () => {
  const root = tree();
  try {
    const found = kinds(root);
    assert.equal(found.has('package-lock.json'), false, 'a lock file is not configuration');
    assert.equal(found.has('assets/logo.png'), false);
    assert.equal(found.has('node_modules/dep/index.js'), false);
    assert.equal(found.has('dist/bundle.js'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the skipped directories are reported rather than silently dropped', () => {
  const root = tree();
  try {
    const skipped = discoverFiles(root).skippedDirectories;
    assert.ok(skipped.includes('node_modules'));
    assert.ok(skipped.includes('dist'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the file list is sorted, so two walks of one tree agree exactly', () => {
  const root = tree();
  try {
    const first = discoverFiles(root).files;
    const second = discoverFiles(root).files;
    assert.deepEqual(second, first);
    assert.deepEqual(first.map(f => f.path), [...first.map(f => f.path)].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a caller can exclude nested directories and individual files', () => {
  const root = tree();
  try {
    const result = discoverFiles(root, {
      ignoredDirectories: new Set(['config']),
      isIgnoredFile: rel => rel.endsWith('.py')
    });
    const paths = result.files.map(f => f.path);
    assert.ok(!paths.some(p => p.startsWith('config/')));
    assert.ok(!paths.includes('src/util.py'));
    assert.ok(paths.includes('src/index.ts'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the shebang is only read for files that need it', () => {
  const root = tree();
  const probed: string[] = [];
  try {
    discoverFiles(root, { readShebang: file => { probed.push(path.basename(file)); return true; } });
    assert.deepEqual(probed.sort(), ['LICENSE', 'deploy', 'notes'],
      'only extensionless files are opened, never source or configuration');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('classification does not depend on the walk', () => {
  const never = (): boolean => false;
  assert.equal(classifyFile('go.mod', '/x/go.mod', never), 'manifest');
  assert.equal(classifyFile('main.go', '/x/main.go', never), 'source');
  assert.equal(classifyFile('k8s/deploy.yml', '/x/k8s/deploy.yml', never), 'source');
  assert.equal(classifyFile('tsconfig.json', '/x/tsconfig.json', never), 'config',
    'JSON is neither a registered source extension nor a manifest, which is why it was being missed');
  assert.equal(classifyFile('go.sum', '/x/go.sum', never), undefined);
  assert.equal(classifyFile('icon.ico', '/x/icon.ico', never), undefined);
  assert.equal(classifyFile('Makefile', '/x/Makefile', never), 'manifest', 'a Makefile is a build manifest');
  assert.equal(classifyFile('scripts/pr', '/x/scripts/pr', never), undefined);
  assert.equal(classifyFile('scripts/pr', '/x/scripts/pr', () => true), 'script');
});

test('an unreadable file is not treated as a script', () => {
  assert.equal(classifyFile('ghost', '/definitely/not/here/ghost', (f) => {
    try { fs.openSync(f, 'r'); return true; } catch { return false; }
  }), undefined);
});

// Nested repositories used to be found by a second full traversal, a glob for
// '**/.git' run before this walk in order to supply its ignore list. One walk
// means one walk: the same pass now notices .git directories as it passes them
// and drops anything beneath a nested repository afterwards.

function nestedTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-nested-'));
  const write = (rel: string, content = 'x'): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write('.git/HEAD', 'ref: refs/heads/main');
  write('src/app.ts', 'export const a = 1;');
  write('packages/other/.git/HEAD', 'ref: refs/heads/main');
  write('packages/other/src/lib.ts', 'export const b = 2;');
  write('packages/other/package.json', '{}');
  return root;
}

test('a nested repository is found on the same walk and its files are excluded', () => {
  const root = nestedTree();
  try {
    const result = discoverFiles(root);
    assert.deepEqual(result.nestedRepositories, ['packages/other']);
    const paths = result.files.map(f => f.path);
    assert.ok(paths.includes('src/app.ts'));
    assert.ok(!paths.some(p => p.startsWith('packages/other/')), 'a nested repository is not this repository');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the repository root itself is never reported as nested', () => {
  const root = nestedTree();
  try {
    assert.ok(!discoverFiles(root).nestedRepositories.includes(''));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('with no nested repository the file list is returned untouched', () => {
  const root = tree();
  try {
    const result = discoverFiles(root);
    assert.deepEqual(result.nestedRepositories, []);
    assert.ok(result.files.length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
