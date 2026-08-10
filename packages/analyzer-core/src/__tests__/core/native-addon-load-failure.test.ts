/**
 * Regression coverage for the 2026-08-09 "silent zero" incident: the native
 * `tree-sitter` N-API addon had no prebuilt binary for the Node version this
 * repo defaulted to on the owner's Mac. `require('tree-sitter')` threw, and
 * every call site along the parse path caught that throw and swallowed it
 * into either `null` or a per-file warning — producing a structurally valid,
 * empty analysis (`errors: 0`) that is indistinguishable from a genuinely
 * tiny/empty project.
 *
 * These tests simulate that exact failure (mock `require('tree-sitter')` to
 * throw, as it did under the broken Node ABI) and assert every swallow point
 * now rethrows a `NativeAddonUnavailableError` instead of returning an empty
 * result. See errors.ts, tree-sitter-parser.ts, tree-sitter-ts-extractor.ts.
 */
jest.mock('tree-sitter', () => {
  throw new Error(
    'Cannot find module \'../build/Release/tree_sitter_runtime_binding.node\' ' +
    '(simulated: no prebuilt binary for this Node ABI)'
  );
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TreeSitterTSExtractor } from '../../analyzer/core/tree-sitter-ts-extractor';
import { TreeSitterParser } from '../../analyzer/core/tree-sitter-parser';
import { NativeAddonUnavailableError, isNativeAddonUnavailableError } from '../../analyzer/core/errors';

// `fs.readFileSync` runs BEFORE the tree-sitter load attempt in every method
// under test here, and setup.ts's global `jest.mock('fs', ...)` only
// replaces `promises`/`existsSync` — `readFileSync` is the real
// implementation. A nonexistent path would throw a plain ENOENT first and
// mask what this suite is actually testing, so every fixture below is a real
// temp file.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-native-addon-test-'));
const tsFile = path.join(tmpDir, 'file.ts');
const goFile = path.join(tmpDir, 'file.go');
const csFile = path.join(tmpDir, 'file.cs');
const phpFile = path.join(tmpDir, 'file.php');
const rsFile = path.join(tmpDir, 'file.rs');
for (const f of [tsFile, goFile, csFile, phpFile, rsFile]) {
  fs.writeFileSync(f, 'irrelevant content\n');
}
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('native tree-sitter addon load failure', () => {
  it('TreeSitterTSExtractor.extractFromSource throws NativeAddonUnavailableError instead of silently returning empty extraction', () => {
    const extractor = new TreeSitterTSExtractor();
    expect(() => extractor.extractFromSource('export const x = 1;', 'file.ts'))
      .toThrow(NativeAddonUnavailableError);
  });

  it('TreeSitterTSExtractor.extractFromFile rethrows rather than returning null', () => {
    const extractor = new TreeSitterTSExtractor();
    expect(() => extractor.extractFromFile(tsFile))
      .toThrow(NativeAddonUnavailableError);
  });

  it('the cached failure is rethrown identically on every subsequent call (no repeated require() attempts, no resurrection)', () => {
    const extractor = new TreeSitterTSExtractor();
    let first: unknown;
    let second: unknown;
    try { extractor.extractFromSource('1', 'a.ts'); } catch (e) { first = e; }
    try { extractor.extractFromSource('2', 'b.ts'); } catch (e) { second = e; }
    expect(first).toBeInstanceOf(NativeAddonUnavailableError);
    expect(first).toBe(second);
  });

  it('TreeSitterParser.parseGoAST rethrows NativeAddonUnavailableError instead of returning null', async () => {
    const parser = new TreeSitterParser();
    await expect(parser.parseGoAST(goFile)).rejects.toBeInstanceOf(NativeAddonUnavailableError);
  });

  it('TreeSitterParser.parseCSharpAST / parsePHPAST / parseRustAST all rethrow the same failure', async () => {
    const parser = new TreeSitterParser();
    await expect(parser.parseCSharpAST(csFile)).rejects.toBeInstanceOf(NativeAddonUnavailableError);
    await expect(parser.parsePHPAST(phpFile)).rejects.toBeInstanceOf(NativeAddonUnavailableError);
    await expect(parser.parseRustAST(rsFile)).rejects.toBeInstanceOf(NativeAddonUnavailableError);
  });

  it('isNativeAddonUnavailableError recognizes a rehydrated (worker-thread round-tripped) plain Error carrying the marker', () => {
    const extractor = new TreeSitterTSExtractor();
    let original: unknown;
    try { extractor.extractFromSource('1', 'a.ts'); } catch (e) { original = e; }
    // Simulate a worker_thread postMessage round-trip: class identity is lost,
    // only the message string survives.
    const rehydrated = new Error((original as Error).message);
    expect(isNativeAddonUnavailableError(rehydrated)).toBe(true);
    expect(isNativeAddonUnavailableError(new Error('some unrelated ENOENT failure'))).toBe(false);
  });

  it('the diagnostic message names the runtime and points at the fix, instead of a bare stack trace', () => {
    const extractor = new TreeSitterTSExtractor();
    try {
      extractor.extractFromSource('1', 'a.ts');
      fail('expected a throw');
    } catch (e) {
      const err = e as NativeAddonUnavailableError;
      expect(err.message).toContain(process.version);
      expect(err.recoverable).toBe(false);
      expect(err.code).toBe('NATIVE_ADDON_UNAVAILABLE');
    }
  });
});
