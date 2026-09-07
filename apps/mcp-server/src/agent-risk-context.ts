import type { CASOutput, CASNode, CASChangeRisk } from '../../../packages/analyzer-core/src/types/cas.types';
import { changeRiskRank, type RankedChangeRisk } from './change-risk-rank';
import { normalizeSourceFile, projectPathsMatch } from './agent-source-paths';

export interface AgentRiskIndex {
  total: number;
  highOrCritical: number;
  records: readonly RankedChangeRisk[];
}

export interface AgentRiskSource {
  getIndex(): Promise<AgentRiskIndex>;
  read(ordinals: readonly number[]): Promise<ReadonlyMap<number, CASChangeRisk>>;
}

const agentRiskSources = new WeakMap<CASOutput, AgentRiskSource>();

export function attachAgentRiskSource(cas: CASOutput, source: AgentRiskSource): void {
  agentRiskSources.set(cas, source);
}

function validateRiskIndex(index: AgentRiskIndex): void {
  if (!Number.isSafeInteger(index.total) || index.total < 0 || index.records.length !== index.total ||
      !Number.isSafeInteger(index.highOrCritical) || index.highOrCritical < 0 || index.highOrCritical > index.total) {
    throw new Error('Agent risk index is incomplete or has invalid totals');
  }
  const ordinals = new Set<number>();
  for (const row of index.records) {
    if (!Number.isSafeInteger(row.ordinal) || row.ordinal < 0 || row.ordinal >= index.total ||
        ordinals.has(row.ordinal) || typeof row.node_id !== 'string' || !Number.isFinite(row.rank)) {
      throw new Error('Agent risk index has an invalid record ordinal, identity or rank');
    }
    ordinals.add(row.ordinal);
  }
}

export async function buildRiskContextForAgent(
  cas: CASOutput,
  options: { targetNode?: CASNode; target?: string; files?: string[]; limit?: number } = {},
) {
  const risks = Array.isArray(cas.change_risks) ? cas.change_risks : [];
  const source = agentRiskSources.get(cas);
  const index: AgentRiskIndex = source ? await source.getIndex() : {
    total: risks.length,
    highOrCritical: risks.filter(risk => risk.risk_level === 'critical' || risk.risk_level === 'high').length,
    records: risks.map((risk, ordinal) => ({ ordinal, node_id: risk.node_id, rank: changeRiskRank(risk) })),
  };
  if (source) validateRiskIndex(index);
  const ordered = [...index.records].sort((left, right) => left.ordinal - right.ordinal);
  const summary = cas.change_risk_summary as any;
  const nodeById = new Map((cas.nodes || []).map(node => [node.id, node]));
  const riskByNode = new Map(ordered.map(risk => [risk.node_id, risk]));
  const targetText = String(options.target || '').toLowerCase();
  const targetRisk = options.targetNode
    ? riskByNode.get(options.targetNode.id) || null
    : ordered.find(risk => {
      const node = nodeById.get(risk.node_id);
      const haystack = [risk.node_id, node?.name, node?.qualified_name, node?.source?.file].filter(Boolean).join(' ').toLowerCase();
      return Boolean(targetText && haystack.includes(targetText));
    }) || null;
  const files = [...new Set((options.files || []).map(file => normalizeSourceFile(file, cas.system?.root_path)).filter(Boolean))];
  const fileRisks = ordered.filter(risk => {
    const node = nodeById.get(risk.node_id);
    const file = normalizeSourceFile(node?.source?.file || '', cas.system?.root_path);
    return Boolean(file && files.some(targetFile => projectPathsMatch(file, targetFile)));
  });
  const summaryHighRiskIds = Array.isArray(summary?.high_risk_nodes) ? summary.high_risk_nodes : [];
  const summaryUntestedIds = Array.isArray(summary?.untested_critical_paths) ? summary.untested_critical_paths : [];
  const summaryRiskIds = [...summaryHighRiskIds, ...summaryUntestedIds]
    .map((item: any) => typeof item === 'string' ? item : item?.node_id || item?.id).filter(Boolean);
  const scope = uniqueRisks([...(targetRisk ? [targetRisk] : []), ...fileRisks]);
  const scopedNodeIds = new Set(scope.map(risk => risk.node_id));
  const scopedSelection = scope.sort((left, right) => right.rank - left.rank).slice(0, options.limit || 6);
  const repoSelection = uniqueRisks([
    ...summaryRiskIds.map((id: string) => riskByNode.get(id)).filter(Boolean), ...ordered,
  ]).filter(risk => !scopedNodeIds.has(risk.node_id))
    .sort((left, right) => right.rank - left.rank).slice(0, options.limit || 6);
  const selected = [...(targetRisk ? [targetRisk] : []), ...scopedSelection, ...repoSelection];
  const ordinals = [...new Set(selected.map(risk => risk.ordinal))];
  const records = source ? await source.read(ordinals) : new Map(ordinals.map(ordinal => [ordinal, risks[ordinal]]));
  function record(selected: RankedChangeRisk): CASChangeRisk {
    const value = records.get(selected.ordinal);
    if (!value || value.node_id !== selected.node_id || changeRiskRank(value) !== selected.rank) {
      throw new Error('Agent risk source did not return the exact indexed record at ordinal ' + selected.ordinal);
    }
    return value;
  }
  const scopedRisks = scopedSelection.map(risk => compactChangeRiskForAgent(record(risk), nodeById.get(risk.node_id)));
  const repoTopRisks = repoSelection.map(risk => compactChangeRiskForAgent(record(risk), nodeById.get(risk.node_id)));
  const topFactors = riskFactorSummary(scopedRisks.length ? scopedRisks : repoTopRisks);
  return {
    status: index.total > 0 ? 'ready' : 'unavailable',
    target_risk: targetRisk ? compactChangeRiskForAgent(record(targetRisk), nodeById.get(targetRisk.node_id)) : null,
    scope: targetRisk ? 'target' : fileRisks.length > 0 ? 'files' : 'repo',
    summary: {
      total_high_risk_nodes: summaryHighRiskIds.length || index.highOrCritical,
      total_untested_critical_paths: summaryUntestedIds.length,
      top_risk_factors: topFactors,
    },
    top_risks: scopedRisks,
    repo_top_risks: repoTopRisks,
    agent_rules: [
      scopedRisks.length
        ? 'Before editing any scoped risk surface, inspect its callers, callees, tests, and behavioral invariants.'
        : 'No direct risk matched the selected target or first-read files; use repo_top_risks only as background, not as the edit target.',
      'Use assess_change_risk for the selected node before changes that touch high-risk files or entry points.',
      'When risk_context names no direct tests, inspect adjacent tests or add focused coverage before finalizing behavior changes.',
    ],
  };
}

function compactChangeRiskForAgent(risk: any, node?: CASNode) {
  const factors = Array.isArray(risk.risk_factors) ? risk.risk_factors : [];
  return {
    node_id: risk.node_id,
    name: node?.name || risk.node_id,
    type: node?.type || null,
    file: node?.source?.file || null,
    line: node?.source?.line || null,
    risk_level: risk.risk_level,
    factors: factors.slice(0, 4).map((factor: any) => ({
      factor: factor.factor,
      severity: factor.severity,
      details: factor.details,
    })),
    direct_callers: Array.isArray(risk.downstream_impact?.direct_callers) ? risk.downstream_impact.direct_callers.slice(0, 4) : [],
    affected_entry_points: Array.isArray(risk.downstream_impact?.affected_entry_points) ? risk.downstream_impact.affected_entry_points.slice(0, 4) : [],
    test_protection: risk.test_protection ? {
      has_direct_tests: Boolean(risk.test_protection.has_direct_tests),
      has_integration_tests: Boolean(risk.test_protection.has_integration_tests),
      test_ids: Array.isArray(risk.test_protection.test_ids) ? risk.test_protection.test_ids.slice(0, 4) : [],
    } : null,
    recommendations: Array.isArray(risk.recommendations) ? risk.recommendations.slice(0, 3) : [],
  };
}


function uniqueRisks(risks: any[]): any[] {
  const seen = new Set<string>();
  const result = [];
  for (const risk of risks) {
    if (!risk?.node_id || seen.has(risk.node_id)) continue;
    seen.add(risk.node_id);
    result.push(risk);
  }
  return result;
}

function riskFactorSummary(risks: any[]): string[] {
  const counts = new Map<string, number>();
  for (const risk of risks) {
    for (const factor of risk.factors || []) {
      if (!factor?.factor) continue;
      counts.set(factor.factor, (counts.get(factor.factor) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([factor, count]) => `${factor} (${count})`);
}
