import { formatRelativeTime } from '@/app/Dashboard/formatRelativeTime';

export const STALE_SOURCE_DAYS = 7;

export interface FreshnessDescription {

  label: string;

  stale: boolean;

  staleNotice?: string;
}

function daysSince(iso: string | undefined | null, now: number): number | undefined {
  if (!iso) return undefined;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return undefined;
  return (now - then) / (24 * 60 * 60 * 1000);
}

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
