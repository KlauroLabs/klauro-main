/**
 * BULK ARRAY OPERATIONS — appending or replacing a whole collection without
 * spreading it into an argument list.
 *
 * WHY THIS EXISTS (measured, not hypothesized). `target.push(...source)` passes
 * one ARGUMENT PER ELEMENT. Every JS engine caps how many arguments a call may
 * receive (the limit is in the tens to low hundreds of thousands and depends on
 * the engine, the build, and the remaining stack), and exceeding it throws
 * `RangeError: Maximum call stack size exceeded` — the same message unbounded
 * recursion produces, from a completely different cause. The tell is the stack:
 * a recursion overflow repeats one frame hundreds of times, while this throws
 * with a single frame at the call site.
 *
 * The measured failure: an ordinary 3,856-file TypeScript repository produced
 * enough edges that the whole-graph edge-dedupe's `edges.push(...deduped)`
 * exceeded the limit, and the analysis of the ENTIRE repository died. Not a
 * degraded result for one file — nothing at all, for a repository of thoroughly
 * ordinary size. Nothing caught it because every gate analyzed a small project,
 * where no collection is anywhere near the limit.
 *
 * This is a scaling cliff, not a bug that shows up gradually: the same code
 * works perfectly on a 500-file repository and cannot work at all past some
 * size. So the fix is to remove the construct from the graph-assembly path
 * rather than to catch its exception — an element count must never decide
 * whether an analysis is possible.
 */

/**
 * Append every element of `source` to `target`, in place, in order.
 *
 * Deliberately a loop rather than a chunked `push(...chunk)`: chunking picks a
 * batch size that has to stay under an engine limit nobody publishes, and gets
 * that judgment wrong quietly. A loop has no limit to be wrong about.
 */
export function appendAll<T>(target: T[], source: readonly T[]): void {
  for (let i = 0; i < source.length; i++) target.push(source[i]);
}

/**
 * Replace `target`'s contents with `source`'s, in place — the safe form of the
 * `target.length = 0; target.push(...source)` idiom used to rewrite a
 * collection that callers hold by reference.
 *
 * Handles `source === target` and slices of `target` correctly by reading the
 * source before truncating.
 */
export function replaceArrayContents<T>(target: T[], source: readonly T[]): void {
  if (source === target) return;
  const snapshot = Array.isArray(source) && sharesBacking(target, source) ? source.slice() : source;
  target.length = 0;
  appendAll(target, snapshot);
}

/** True when `source` may alias `target`'s storage such that truncating
 *  `target` first would lose elements. Conservative: only exact identity is
 *  detectable in JS, so this exists to document the hazard and to make the
 *  identity check explicit at the one place it matters. */
function sharesBacking<T>(target: readonly T[], source: readonly T[]): boolean {
  return (target as unknown) === (source as unknown);
}
