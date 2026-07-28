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

export const INTENTIONAL_DIVERGENCES: AllowedDivergence[] = [];

export function isAllowed(
  file: string,
  pathShape: string,
  allowlist: AllowedDivergence[] = INTENTIONAL_DIVERGENCES,
): boolean {
  return allowlist.some(
    entry => (entry.file === '*' || entry.file === file) && entry.pathShape === pathShape,
  );
}
