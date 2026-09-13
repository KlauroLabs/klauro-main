import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTreeSitterWorkerPath } from './tree-sitter-worker-runtime';

// Parse workers run a compiled copy of the extractor. When that copy is older
// than the source it was built from, every change to extraction silently does
// nothing: the pool keeps parsing with the old rules while in-process parsing
// uses the new ones, and the two disagree. That happened for real, with a
// compiled worker a month older than the source, and it cost a full cycle of
// debugging. Resolution now prefers a built worker only when it is at least as
// new as the sources it was built from.

const BUNDLED = '/pkg/tree-sitter-ts-worker.cjs';
const COMPILED = '/pkg/dist/tree-sitter-ts-worker.js';
const SOURCE = '/pkg/src/tree-sitter-ts-worker.ts';
const EXTRACTOR = '/pkg/src/tree-sitter-ts-extractor.ts';

function resolve(present: string[], stamps: Record<string, number>, siblings: string[] = [EXTRACTOR]): string {
  return resolveTreeSitterWorkerPath(
    BUNDLED, COMPILED, SOURCE, siblings,
    filePath => present.includes(filePath),
    filePath => (filePath in stamps ? stamps[filePath] : null)
  );
}

test('a bundled worker newer than its sources is used', () => {
  assert.equal(
    resolve([BUNDLED, SOURCE, EXTRACTOR], { [BUNDLED]: 200, [SOURCE]: 100, [EXTRACTOR]: 100 }),
    BUNDLED
  );
});

test('a compiled worker is used when there is no bundle', () => {
  assert.equal(
    resolve([COMPILED, SOURCE, EXTRACTOR], { [COMPILED]: 200, [SOURCE]: 100, [EXTRACTOR]: 100 }),
    COMPILED
  );
});

test('a stale build loses to source, even when only a sibling source changed', () => {
  // The worker file itself rarely changes. The extractor it embeds is what
  // changes, so the worker's own timestamp is not enough to detect staleness.
  assert.equal(
    resolve([COMPILED, SOURCE, EXTRACTOR], { [COMPILED]: 150, [SOURCE]: 100, [EXTRACTOR]: 200 }),
    SOURCE
  );
});

test('a build exactly as new as its sources is still used', () => {
  assert.equal(
    resolve([COMPILED, SOURCE, EXTRACTOR], { [COMPILED]: 100, [SOURCE]: 100, [EXTRACTOR]: 100 }),
    COMPILED
  );
});

test('with no sources on disk the build is trusted, which is the shipped package', () => {
  assert.equal(resolve([COMPILED], { [COMPILED]: 100 }), COMPILED);
  assert.equal(resolve([BUNDLED], { [BUNDLED]: 100 }), BUNDLED);
});

test('unreadable timestamps fall back to using the build rather than failing', () => {
  assert.equal(resolve([COMPILED, SOURCE, EXTRACTOR], { [SOURCE]: 100, [EXTRACTOR]: 200 }), COMPILED);
  assert.equal(resolve([COMPILED, SOURCE, EXTRACTOR], { [COMPILED]: 100 }), COMPILED);
});

test('with no build at all the source worker is used', () => {
  assert.equal(resolve([SOURCE, EXTRACTOR], { [SOURCE]: 100, [EXTRACTOR]: 100 }), SOURCE);
});

test('a stale bundle does not shadow a fresh compiled worker check', () => {
  // Both builds are stale; source wins rather than either build.
  assert.equal(
    resolve([BUNDLED, COMPILED, SOURCE, EXTRACTOR], { [BUNDLED]: 50, [COMPILED]: 60, [SOURCE]: 100, [EXTRACTOR]: 200 }),
    SOURCE
  );
});
