/**
 * Jest global setup — runs exactly ONCE before any test file, in its own
 * process, before any per-file `setupFilesAfterEnv` mocking kicks in.
 *
 * Verifies the native `tree-sitter` N-API addon (and the typescript/javascript
 * grammars layered on top of it) can actually load in THIS Node runtime,
 * before letting the suite run.
 *
 * Why this exists: on 2026-08-09 the `tree-sitter` native addon had no
 * prebuilt binary for Node 26 (this repo's default on the machine it was
 * developed on). Every TypeScript/JavaScript file failed to parse — silently,
 * per file, caught and swallowed deep in the extraction pipeline — producing
 * zero nodes with no thrown error anywhere. Multiple engineering sessions ran
 * the suite locally under that broken Node version, saw a wall of failing
 * tests, and dismissed them as "pre-existing and unrelated" without
 * recognizing they shared ONE root cause. A suite that fails for the wrong,
 * misdiagnosed reason is worse than one that fails loudly for the right one.
 *
 * This check turns that wall of confusing red into a single, unmissable,
 * actionable line BEFORE a single test runs — "fail fast" in the literal
 * sense: abort the whole run here, not 40 minutes and 600 mysterious
 * failures later.
 *
 * If you hit this: rebuild native dependencies under a Node version that has
 * a prebuilt `tree-sitter` binary (Node 22.x is confirmed to work — see
 * docs/analyzer-worktree-test-env notes), or run tests under that Node
 * version via nvm/fnm. In a fresh git worktree this is the SAME trap as
 * `npm ci --ignore-scripts` skipping native builds — copy the tree-sitter
 * natives from the main tree's node_modules, or reinstall with scripts
 * enabled under a supported Node version.
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.KLAURO_SKIP_NATIVE_ADDON_PRECHECK === '1') return;

  const failures: string[] = [];

  const tryRequire = (moduleId: string): void => {
    try {
      require(moduleId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`  - require('${moduleId}') failed: ${message.split('\n')[0]}`);
    }
  };

  tryRequire('tree-sitter');
  tryRequire('tree-sitter-typescript');
  tryRequire('tree-sitter-javascript');

  if (failures.length === 0) return;

  const banner = [
    '',
    '################################################################################',
    '# NATIVE TREE-SITTER ADDON UNAVAILABLE — TEST SUITE ABORTED BEFORE RUNNING     #',
    '################################################################################',
    '',
    `Node ${process.version} (${process.platform}/${process.arch}) cannot load the native`,
    'tree-sitter parsing addon used by the TypeScript/JavaScript (and C#/Go/PHP/Rust)',
    'analyzers. Every test that touches those analyzers would silently see ZERO',
    'parsed nodes and either fail with confusing assertion mismatches, or — worse —',
    'report a structurally valid empty result that looks like a real pass.',
    '',
    'Underlying failures:',
    ...failures,
    '',
    'THIS IS NOT "pre-existing and unrelated." Do not dismiss red tests you see',
    'after this banner as unrelated flakiness — fix this first, then re-run.',
    '',
    'Fix: rebuild native dependencies under a Node version with a prebuilt',
    '`tree-sitter` binary (Node 22.x is confirmed good), e.g.:',
    '  nvm use 22.22.0 && npm rebuild tree-sitter tree-sitter-typescript tree-sitter-javascript \\',
    '    tree-sitter-c-sharp tree-sitter-go tree-sitter-php tree-sitter-rust',
    '',
    'In a fresh git worktree, `npm ci --ignore-scripts` skips this build entirely —',
    'copy the built native modules from the main tree\'s node_modules instead, or',
    'run `npm ci` (without --ignore-scripts) under a supported Node version.',
    '',
    'Set KLAURO_SKIP_NATIVE_ADDON_PRECHECK=1 to bypass this check (e.g. when',
    'deliberately testing the swallow-vs-hard-error guards in errors.ts against a',
    'broken addon) — every other test run must not.',
    '################################################################################',
    '',
  ].join('\n');

  // eslint-disable-next-line no-console
  console.error(banner);
  throw new Error(
    `Native tree-sitter addon unavailable under Node ${process.version} — see banner above. ` +
    'Test suite aborted before running any test file.'
  );
}
