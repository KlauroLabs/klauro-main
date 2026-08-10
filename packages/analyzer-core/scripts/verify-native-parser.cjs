#!/usr/bin/env node
/**
 * postinstall guard: confirms the native `tree-sitter` N-API addon (and the
 * typescript/javascript grammars layered on top of it) actually loaded in
 * THIS Node runtime, and fails the install loudly if not.
 *
 * Why this runs at install time, not just in jest's globalSetup: a plain
 * `npm install`/`npm ci` (no `--foreground-scripts`, no approved scripts
 * allowlist) silently skips third-party install scripts — including
 * tree-sitter's own `node-gyp rebuild` — and still exits 0. The install
 * reports success; `require('tree-sitter')` then throws "No native build
 * was found" the first time any file is parsed, deep inside the analysis
 * pipeline, and a parsing suite run against that install measures nothing
 * while reporting green. That class already invalidated a full day of test
 * results once (see docs/analyzer-worktree-test-env notes and
 * src/__tests__/globalSetup.ts, which catches the same failure for jest but
 * only once a test run has already started).
 *
 * This script is declared in THIS package's own `postinstall`, so it is not
 * subject to the third-party install-scripts allowlist that skips
 * dependency scripts — npm always runs a project's own lifecycle scripts.
 * That asymmetry is exactly what makes an install-time check load-bearing
 * here instead of just another script that gets silently skipped alongside
 * tree-sitter's.
 *
 * Set KLAURO_SKIP_NATIVE_ADDON_PRECHECK=1 to bypass (e.g. an install that
 * deliberately never parses).
 */
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
tryRequire('tree-sitter-typescript');
tryRequire('tree-sitter-javascript');

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
  'tree-sitter parsing addon this package uses for TypeScript/JavaScript (and',
  'C#/Go/PHP/Rust) analysis:',
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
