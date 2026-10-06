import { summarizeAnalysisFreshness, type AnalysisFreshnessSummary } from './freshness';

function isFreshnessSummary(value: unknown): value is AnalysisFreshnessSummary {
  const candidate = value as Partial<AnalysisFreshnessSummary> | null;
  return Boolean(candidate)
    && typeof candidate === 'object'
    && typeof candidate!.analyzed_at === 'string'
    && typeof candidate!.scan === 'object'
    && candidate!.scan !== null;
}

export function overlayLocalFreshness<T>(result: T, localPath: string): T {
  if (!result || typeof result !== 'object') return result;
  if (Array.isArray(result)) return result.map(item => overlayLocalFreshness(item, localPath)) as unknown as T;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (key === 'analysis_freshness' && isFreshnessSummary(value)) {
      next[key] = summarizeAnalysisFreshness(localPath, value.analyzed_at) ?? value;
    } else {
      next[key] = overlayLocalFreshness(value, localPath);
    }
  }
  return next as T;
}
