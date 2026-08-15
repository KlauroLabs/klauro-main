#!/usr/bin/env node


























if (process.env.KLAURO_SKIP_NATIVE_ADDON_PRECHECK === '1') {
  process.exit(0);
}

const failures = [];

function tryRequire(moduleId) {
  try {
    require(moduleId);
  } catch (error) {
    failures.push(`  - require('${moduleId}') failed: ${(error && error.message || String(error)).split('\n')[0]}`);
  }
}

tryRequire('tree-sitter');
tryRequire('tree-sitter-c-sharp');
tryRequire('tree-sitter-go');
tryRequire('tree-sitter-php');

if (failures.length === 0) {
  process.exit(0);
}

const banner = [
  '',
  '################################################################################',
  '# NATIVE TREE-SITTER ADDON UNAVAILABLE — INSTALL DID NOT PRODUCE A WORKING     #',
  '# PARSER                                                                       #',
  '################################################################################',
  '',
  `Node ${process.version} (${process.platform}/${process.arch}) cannot load the native`,
  'tree-sitter parsing addon this package bundles workers around (C#/Go/PHP',
  'analysis, plus TypeScript/JavaScript via @klauro/analyzer-core):',
  '',
  ...failures,
  '',
  'This almost always means the install skipped native builds rather than that',
  'Node itself is unsupported. The most common cause: a plain `npm install` or',
  '`npm ci` silently skips packages\' install scripts (including tree-sitter\'s',
  '`node-gyp rebuild`) unless you pass --foreground-scripts, and still exits 0',
  'as if nothing were missing.',
  '',
  'Fix:',
  '  1. Re-run the install with scripts enabled, from the repo root:',
  '       npm ci --foreground-scripts',
  '     (or, from this package directory: npm install --foreground-scripts)',
  '  2. Confirm you are on Node 22.x — Node 24/26 fail to COMPILE tree-sitter',
  '     from source against current V8 headers (a genuine upstream break, not',
  '     a missing-prebuild gap). Node 22 is the only currently-verified version.',
  '  3. If this is a fresh git worktree, the natives may simply need copying',
  '     from the main tree\'s node_modules instead of a full rebuild.',
  '',
  'Refusing to leave the install in a state where a parsing run would silently',
  'measure nothing while reporting success.',
  '################################################################################',
  '',
].join('\n');

process.stderr.write(banner + '\n');
process.exit(1);
