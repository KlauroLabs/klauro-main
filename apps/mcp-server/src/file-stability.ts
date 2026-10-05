import type { CASNode, CASOutput, CASTemporalStability, ChangeRiskFactor } from '../../../packages/analyzer-core/src/types/cas.types';

const TOP_DECILE = 90;
const TOP_QUARTILE = 75;
const FIXES_FOR_HIGH = 3;
const FIXES_FOR_MEDIUM = 2;

export function stabilityFor(cas: CASOutput, node: Pick<CASNode, 'id' | 'source'>): CASTemporalStability | undefined {
  const held = cas.temporal_stability ?? [];
  return held.find(entry => entry.node_id === node.id)
    ?? (node.source?.file === undefined ? undefined : held.find(entry => entry.node_id === node.source?.file));
}

export function recentBugsFactor(stability: CASTemporalStability | undefined): ChangeRiskFactor | undefined {
  const signals = stability?.quality_signals;
  if (signals === undefined) return undefined;
  const fixes = signals.bug_fix_commits;
  const percentile = signals.bug_fix_percentile;
  if (fixes !== undefined && percentile !== undefined) {
    const severity = percentile >= TOP_DECILE && fixes >= FIXES_FOR_HIGH ? 'high'
      : percentile >= TOP_QUARTILE && fixes >= FIXES_FOR_MEDIUM ? 'medium'
      : undefined;
    return severity === undefined ? undefined : {
      factor: 'recent-bugs',
      severity,
      details: `${fixes} bug-fix commits touched this file, more than ${percentile}% of files in this repository's recent history`,
    };
  }
  return signals.bug_fix_rate > 0.3
    ? { factor: 'recent-bugs', severity: 'high', details: `Bug fix density: ${Math.round(signals.bug_fix_rate * 100)}% of commits are bug fixes` }
    : undefined;
}

export function hotSpotsFromHistory(cas: CASOutput, metric: 'change-count' | 'churn-lines' | 'bug-fix-rate') {
  if (metric === 'churn-lines') return [];
  return (cas.temporal_stability ?? [])
    .map(entry => ({
      id: entry.node_id,
      value: 0,
      raw: metric === 'bug-fix-rate' ? entry.quality_signals.bug_fix_rate : entry.churn_metrics.commits_90d,
      label: entry.node_id.split('/').pop() || entry.node_id,
    }))
    .filter(row => row.raw > 0);
}
