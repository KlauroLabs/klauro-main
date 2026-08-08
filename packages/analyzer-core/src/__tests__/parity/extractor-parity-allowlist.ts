/**
 * Reviewed intentional differences between the pre-rewrite extractor baseline
 * and the current extractor.
 *
 * EMPTY BY DEFAULT, AND THAT IS THE POINT. A rewrite that preserves behaviour
 * needs no entries. Every entry is an admission that the new extractor
 * produces different facts than the old one for real source, so the list is a
 * review signal: if it grows, the "optimization" changed the product's output,
 * and each line has to be justified in code review by a human who read the
 * reason.
 *
 * Matching is by `{ file, pathShape }`:
 *  - `file`: repo-relative corpus path, or `'*'` for all files
 *  - `pathShape`: JSON path with array indices collapsed
 *    (`functions[].calls[].name`), so one entry covers every occurrence of the
 *    same structural difference within the named file
 *  - `reason`: why this difference is correct. Not optional, not "TODO".
 */

export interface AllowedDivergence {
  /** Repo-relative corpus path, or `'*'` to allow the shape everywhere. */
  file: string;
  /** Index-collapsed JSON path, e.g. `functions[].complexity`. */
  pathShape: string;
  /** Human justification. Reviewed. Never a placeholder. */
  reason: string;
}

const CALL_RECEIVER_NAMING_REASON =
  'Chained-call receiver fix. The baseline built a method call target as ' +
  '`${receiverNode.text}.${property}`, i.e. the receiver\'s raw SOURCE TEXT. For a call ' +
  'on another call\'s result that text is the whole preceding chain, newlines included, ' +
  'and consumers read its dot-separated tail as a receiver NAME: a plain ' +
  '`.map().filter().sort().find()` shipped as a `database` exit point on a repository ' +
  'called `Length)` (exit_db_attachFallbackEntityAnchor_find_11954, measured on a real ' +
  'analysis of this repo). The same branch pasted an IIFE\'s ENTIRE body as its target. ' +
  'The current extractor names the callee/receiver or records UNRESOLVED_RECEIVER, never ' +
  'source text. Divergence audited in full (empty allowlist, no per-file cap): 33,350 ' +
  'target divergences over 1,427 files — 32,398 replace a source-text blob with the ' +
  'marker; 952 strip type-level/grouping syntax from a name that is now RESOLVABLE where ' +
  'it was not (`user?.name.split` -> `user.name.split`, `(cas as any).change_risks.push` ' +
  '-> `cas.change_risks.push`); ZERO replace an already-well-formed name with the marker, ' +
  'so no resolvable call was lost. (An earlier revision did lose 73 dynamic `import(...)` ' +
  'targets; `import` is now named explicitly and the audit is clean.) ' +
  'Entry is file:\'*\' because the shape occurs in 1,427 ' +
  'corpus files; it is broad, and it does blind this gate to future call-target changes — ' +
  'the dedicated regression coverage is ' +
  '__tests__/core/tree-sitter-ts-extractor-call-receiver.test.ts and ' +
  '__tests__/analyzers/typescript-repository-call-gating.test.ts.';

export const INTENTIONAL_DIVERGENCES: AllowedDivergence[] = [
  {
    file: '*',
    pathShape: 'functions[].calls[].target',
    reason: CALL_RECEIVER_NAMING_REASON,
  },
  {
    file: '*',
    pathShape: 'classes[].methods[].calls[].target',
    reason: CALL_RECEIVER_NAMING_REASON,
  },
  {
    // `parentPort!.postMessage(...)`: the baseline looked the import table up by
    // the source text `parentPort!`, which matches no import, so a genuine
    // library call was typed 'method'. Naming the receiver `parentPort` makes
    // the lookup hit, which is the correct classification, not a regression.
    file: 'packages/analyzer-core/src/analyzer/core/tree-sitter-ts-worker.ts',
    pathShape: 'functions[].calls[].targetType',
    reason:
      'Same fix: an external-import lookup keyed by receiver source text could never ' +
      'match, so `parentPort!.postMessage` was classified `method`. With the receiver ' +
      'named `parentPort` it resolves to the `node:worker_threads` import and is ' +
      'correctly classified `library`. Only occurrence in the corpus.',
  },
];

export function isAllowed(
  file: string,
  pathShape: string,
  allowlist: AllowedDivergence[] = INTENTIONAL_DIVERGENCES,
): boolean {
  return allowlist.some(
    entry => (entry.file === '*' || entry.file === file) && entry.pathShape === pathShape,
  );
}
