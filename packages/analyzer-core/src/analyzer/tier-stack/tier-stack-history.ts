import type { CASStabilitySummary, CASTemporalStability } from '../../types/cas.types';
import type { TierStackFileHistory, TierStackIndex } from './read-tier-stack';

const SECONDS_PER_DAY = 86_400;
const LEGACY_DAYS = 180;
const FRAGILE_FIX_RATE = 0.3;
const MINIMUM_COMMITS_FOR_A_RATE = 3;
const VOLATILE_RECENT_COMMITS = 5;

function classOf(file: TierStackFileHistory, quiet_days: number): CASTemporalStability['stability_class'] {
  const rate = file.commits > 0 ? file.fixes / file.commits : 0;
  if (file.commits >= MINIMUM_COMMITS_FOR_A_RATE && rate > FRAGILE_FIX_RATE) return 'fragile';
  if (file.recent > VOLATILE_RECENT_COMMITS) return 'volatile';
  if (file.recent <= 2 && rate < 0.1 && quiet_days > LEGACY_DAYS) return 'stable';
  return 'evolving';
}

function scoreOf(stability_class: CASTemporalStability['stability_class']): number {
  return { stable: 0.9, evolving: 0.6, volatile: 0.35, fragile: 0.15 }[stability_class];
}

export function temporalStabilityOf(
  index: TierStackIndex,
  held: Set<string>,
): { stability: CASTemporalStability[]; summary?: CASStabilitySummary } {
  const files = (index.history?.files ?? []).filter(file => held.has(file.path));
  if (files.length === 0) return { stability: [] };
  const head = Math.max(...files.map(file => file.last));
  const stability: CASTemporalStability[] = files.map(file => {
    const quiet_days = Math.max(0, (head - file.last) / SECONDS_PER_DAY);
    const stability_class = classOf(file, quiet_days);
    return {
      node_id: file.path,
      stability_score: scoreOf(stability_class),
      stability_class,
      churn_metrics: {
        commits_30d: file.recent,
        commits_90d: file.quarter,
        unique_authors_30d: file.recent_authors,
        lines_changed_30d: 0,
      },
      quality_signals: {
        bug_fix_rate: file.commits > 0 ? file.fixes / file.commits : 0,
        refactor_frequency: 'rare',
        has_recent_regression: false,
        bug_fix_commits: file.fixes,
        bug_fix_percentile: file.fix_percentile,
        churn_percentile: file.churn_percentile,
      },
      age_context: {
        file_age_days: 0,
        last_major_change: new Date(file.last * 1000).toISOString(),
        is_legacy: quiet_days > LEGACY_DAYS,
      },
    };
  });
  const by_stability_class: Record<string, number> = {};
  for (const held of stability) by_stability_class[held.stability_class] = (by_stability_class[held.stability_class] ?? 0) + 1;
  return {
    stability,
    summary: {
      by_stability_class,
      hotspots: stability
        .filter(held => held.stability_class === 'fragile' || held.stability_class === 'volatile')
        .slice(0, 20)
        .map(held => ({
          node_id: held.node_id,
          reason: held.stability_class === 'fragile'
            ? `${held.quality_signals.bug_fix_commits} bug-fix commits, more than ${held.quality_signals.bug_fix_percentile}% of files in this repository's recent history`
            : `${held.churn_metrics.commits_30d} commits in the last 30 days of history`,
        })),
      legacy_areas: stability.filter(held => held.age_context.is_legacy).slice(0, 20).map(held => held.node_id),
    },
  };
}
