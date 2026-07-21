// Honest freshness: "Updated X ago" alone describes when the ANALYSIS ran,
// not how current the analyzed SOURCE is. A real incident: analysis
// timestamp Jul 18 ("Updated 3 days ago") while the uploaded snapshot it
// analyzed was actually last committed Jul 7 — the repo had since diverged
// by ~200 files with no hint anywhere in the UI. `repo_facts.last_commit_at`
// (client-derived git fact, stamped server-side — see api.ts's RepoFacts) is
// the honest "source as of" marker: the last real commit the analyzed
// snapshot actually reflects, independent of when the analysis job ran.
import { formatRelativeTime } from '../pages/dashboard/formatRelativeTime';

/** Source older than this, relative to now, is flagged as possibly stale —
 *  the analysis may no longer reflect the current code. */
export const STALE_SOURCE_DAYS = 7;

export interface FreshnessDescription {
  /** "Updated 3 days ago" or "Updated 3 days ago · source as of 11 days ago" —
   *  the second clause only when a source timestamp is available and
   *  actually differs from the analysis timestamp (nothing to add otherwise). */
  label: string;
  /** True when the source is older than STALE_SOURCE_DAYS — render the
   *  freshness dot in a warning color and surface `staleNotice`. */
  stale: boolean;
  /** Plain-language callout for the stale case, naming the fix. Undefined
   *  when not stale. */
  staleNotice?: string;
}

function daysSince(iso: string | undefined | null, now: number): number | undefined {
  if (!iso) return undefined;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return undefined;
  return (now - then) / (24 * 60 * 60 * 1000);
}

/**
 * Combine "when the analysis ran" (analysisTimestamp) with "how current the
 * analyzed source actually is" (sourceAt — repo_facts.last_commit_at) into
 * one honest label. Returns undefined when there's nothing to show at all
 * (no analysis timestamp — the existing "don't render the dot" behavior is
 * unchanged).
 */
export function describeFreshness(
  analysisTimestamp: string | undefined | null,
  sourceAt: string | undefined | null,
  now: number = Date.now(),
): FreshnessDescription | undefined {
  const analyzedRelative = formatRelativeTime(analysisTimestamp, now);
  if (!analyzedRelative) return undefined;

  const sourceRelative = formatRelativeTime(sourceAt, now);
  const sameInstant = analysisTimestamp && sourceAt && new Date(analysisTimestamp).getTime() === new Date(sourceAt).getTime();
  const label = sourceRelative && !sameInstant ? `Updated ${analyzedRelative} · source as of ${sourceRelative}` : `Updated ${analyzedRelative}`;

  const sourceAgeDays = daysSince(sourceAt, now);
  const stale = sourceAgeDays !== undefined && sourceAgeDays > STALE_SOURCE_DAYS;

  return {
    label,
    stale,
    staleNotice: stale
      ? `The analyzed source is over a week old (last commit ${sourceRelative}) and may not reflect the current code — Re-Analyze to refresh it.`
      : undefined,
  };
}
