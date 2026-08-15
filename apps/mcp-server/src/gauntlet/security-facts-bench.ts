



























import * as fs from 'fs-extra';
import * as path from 'path';
import { validateWin } from './win-validator';
import { analyzeForBench, benchProductMode } from './product-analysis';
import type { ArmResult, WinVerdict } from './report-schema';

export { benchProductMode };

interface SecurityFactsTruth {
  task: 'security-facts';
  true_facts: string[];

  pending?: boolean;
  note?: string;
}

export interface SecurityFactsBenchResult {
  fixture: string;
  arms: ArmResult[];
  verdict: WinVerdict;
  detail: Array<{ arm: string; facts: string[]; precision: number; recall: number; f1: number }>;
}

function score(produced: string[], truth: string[]): { precision: number; recall: number; f1: number } {
  const prod = [...new Set(produced)];
  const tp = prod.filter(f => truth.includes(f)).length;
  const precision = prod.length ? tp / prod.length : (truth.length ? 0 : 1);
  const recall = truth.length ? tp / truth.length : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}


function toTokens(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}



async function klauroArm(dir: string, truth: SecurityFactsTruth): Promise<{ result: ArmResult; facts: string[]; bytes: number }> {
  const t0 = Date.now();
  const cas: any = await analyzeForBench(dir);
  const time_ms = Date.now() - t0;
  const nodes: any[] = cas.nodes || [];

  const factNodes = nodes.filter(n => n.type === 'security-fact');
  const facts = factNodes.map(n => String(n.name));
  const answer = facts.join('\n');
  const bytes = Buffer.byteLength(answer, 'utf8');

  const s = score(facts, truth.true_facts);
  return {
    facts,
    bytes,
    result: {
      arm_id: 'klauro',
      mode: benchProductMode() ? 'product' : 'engine',
      attempted: true,
      metrics: { quality: Math.round(s.f1 * 100), tokens: toTokens(bytes), time_ms },
      source: benchProductMode() ? 'security-facts-bench:product' : 'security-facts-bench',
    },
  };
}







function noAbstractionArm(): ArmResult {
  return {
    arm_id: 'structural-grep',
    mode: 'engine',
    attempted: false,
    metrics: {},
    source: 'security-facts-bench:structural-grep',
    note: 'No security-fact abstraction: cannot answer access-control/ERC-conformance/reentrancy-guard/CEI-violation queries without a bespoke, per-repo audit script.',
  };
}


export async function runSecurityFactsBench(fixtureDir: string): Promise<SecurityFactsBenchResult> {
  const truth: SecurityFactsTruth = await fs.readJson(path.join(fixtureDir, 'truth.json'));

  const klauro = await klauroArm(fixtureDir, truth);
  const competitor = noAbstractionArm();

  const arms = [klauro.result, competitor];
  const detail = [
    { arm: 'klauro', facts: klauro.facts, ...score(klauro.facts, truth.true_facts) },
    { arm: 'structural-grep', facts: [], precision: 0, recall: 0, f1: 0 },
  ];

  const verdict = validateWin(
    arms,
    'SoliditySecurityAnalyzer emits access-control/ERC-conformance/reentrancy-guard/CEI-violation as first-class security-fact CAS nodes; a structural-only tool has no such abstraction to query.'
  );

  return { fixture: path.basename(fixtureDir), arms, verdict, detail };
}
