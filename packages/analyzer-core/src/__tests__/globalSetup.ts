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
 *
 * ------------------------------------------------------------------------------
 * THE CHECK MUST RUN IN A CHILD PROCESS. THIS IS NOT AN OPTIMIZATION.
 *
 * Measured 2026-08-11 on a clean Node 22 / linux-x64 CI container: this file
 * used to `require('tree-sitter')` directly, here, in jest's PARENT process.
 * Doing so binds the native addon's node-marshalling state to the parent realm.
 * Every test file then loads the addon inside jest's own sandbox realm, where
 * `parser.parse(src)` returns a real `Tree` object whose `rootNode` is
 * `undefined` — no throw, no warning. Result: 22 suites and 89 tests red, every
 * one of them a `TypeError: Cannot read properties of undefined (reading
 * 'type')` from deep inside an extractor, all sharing ONE root cause.
 *
 * Proven by bisecting the jest config against a fixed diagnostic: with this
 * file as `globalSetup`, `parse().rootNode` is `undefined`; with it removed
 * (setup.ts, clearMocks, restoreMocks, detectOpenHandles all still on), the
 * same probe returns `program`. Nothing else in the config matters.
 *
 * So the guard written to stop engineers from misdiagnosing a wall of red WAS
 * the cause of a wall of red, and its own banner instructed them not to dismiss
 * it. The probe now runs in a `spawnSync`'d child so the addon is never loaded
 * in the parent realm, and it asserts the predicate that actually matters —
 * that a parse yields a usable `rootNode` — instead of only that `require`
 * returned something.
 * ------------------------------------------------------------------------------
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.KLAURO_SKIP_NATIVE_ADDON_PRECHECK === '1') return;

  const failures = probeNativeAddonInChildProcess();

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

/**
 * Loads each grammar and PARSES a trivial source in a throwaway child process,
 * reporting one line per module that could not be loaded or that produced an
 * unusable tree. Nothing is required into this process — see the realm-binding
 * note above for why that is the whole point.
 *
 * A load failure and an unusable-tree failure are reported distinctly because
 * they have different fixes: the first is a missing/incompatible native build,
 * the second is a core-vs-grammar ABI mismatch (or a realm problem, which is
 * what this file itself used to cause).
 */
function probeNativeAddonInChildProcess(): string[] {
  const { spawnSync } = require('child_process') as typeof import('child_process');

  // Runs in the child. Kept as a single-quoted-free source string so it can be
  // passed via `node -e` without shell quoting hazards (spawnSync with an argv
  // array does not involve a shell, but the string still must not contain a
  // literal newline-sensitive construct).
  const probeSource = `
    const results = [];
    for (const grammar of ['typescript', 'javascript']) {
      const moduleId = 'tree-sitter-' + grammar;
      try {
        const Parser = require('tree-sitter');
        const language = require(moduleId);
        const parser = new Parser();
        parser.setLanguage(grammar === 'typescript' ? language.typescript : language);
        const tree = parser.parse('const a = 1;');
        const rootType = tree && tree.rootNode ? tree.rootNode.type : null;
        if (!rootType) {
          results.push({ moduleId, kind: 'unusable-tree' });
        }
      } catch (error) {
        results.push({ moduleId, kind: 'load-failed', message: String(error && error.message || error).split('\\n')[0] });
      }
    }
    process.stdout.write(JSON.stringify(results));
  `;

  const probe = spawnSync(process.execPath, ['-e', probeSource], {
    cwd: __dirname,
    encoding: 'utf8',
    timeout: 60_000,
  });

  if (probe.error) {
    return [`  - could not spawn the native-addon probe: ${probe.error.message}`];
  }
  if (probe.status !== 0) {
    const detail = (probe.stderr || '').trim().split('\n')[0] || `exit code ${probe.status}`;
    return [`  - the native-addon probe process failed: ${detail}`];
  }

  let results: Array<{ moduleId: string; kind: string; message?: string }>;
  try {
    results = JSON.parse(probe.stdout || '[]');
  } catch {
    return [`  - the native-addon probe produced unreadable output: ${(probe.stdout || '').slice(0, 200)}`];
  }

  return results.map(result => result.kind === 'load-failed'
    ? `  - require('${result.moduleId}') failed: ${result.message}`
    : `  - ${result.moduleId} loaded but parse() produced a tree with no rootNode (core/grammar ABI mismatch)`);
}
