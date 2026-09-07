export interface RankedChangeRisk {
  ordinal: number;
  node_id: string;
  rank: number;
}

const LEVEL_SCORES: Record<string, number> = { critical: 400, high: 300, medium: 200, low: 100 };
const SEVERITY_SCORES: Record<string, number> = { high: 10, medium: 5, low: 2 };
const UNTESTED_SCORE = 15;

export function changeRiskRank(risk: unknown): number {
  const record = (risk ?? {}) as Record<string, any>;
  const levelScore = LEVEL_SCORES[String(record.risk_level || '').toLowerCase()] ?? 0;
  const factors: unknown[] = Array.isArray(record.risk_factors) ? record.risk_factors : [];
  const factorScore = factors.reduce<number>((score, factor) => {
    const severity = String((factor as Record<string, unknown> | null)?.severity || '').toLowerCase();
    return score + (SEVERITY_SCORES[severity] ?? 0);
  }, 0);
  const untested = record.test_protection?.has_direct_tests === false ? UNTESTED_SCORE : 0;
  return levelScore + factorScore + untested;
}

export function rankChangeRisks(risks: readonly unknown[]): RankedChangeRisk[] {
  return risks
    .map((risk, ordinal) => ({ ordinal, node_id: String((risk as Record<string, unknown> | null)?.node_id ?? ''), rank: changeRiskRank(risk) }))
    .sort((left, right) => right.rank - left.rank || left.ordinal - right.ordinal);
}
