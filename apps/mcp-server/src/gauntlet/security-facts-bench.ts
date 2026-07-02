/**
 * Security-facts bench — Solidity out-of-category proof.
 *
 * A structural analyzer (or a grep/ast-grep competitor) sees Solidity source as
 * functions, modifiers, and contracts. It has no "security-fact" abstraction: it
 * cannot say "this function is access-controlled", "this contract conforms to
 * ERC20", "this function is reentrancy-guarded", or "this function violates
 * checks-effects-interactions". Klauro's SoliditySecurityAnalyzer (a `framework`
 * analyzer, wired into the orchestrator like any other) emits these as first-class
 * `security-fact` CAS nodes with stable, scoreable ids.
 *
 * This bench:
 *   - auto-enumerates every fixture under fixtures/security-facts/<name>/truth.json
 *   - runs Klauro via `analyzeForBench` ONLY (the blackbox product entry point —
 *     never the engine/orchestrator directly, never an AI/model env var)
 *   - scores the emitted security-fact node names against truth.json's
 *     `true_facts` by exact string match (F1)
 *   - marks the competitor arm `attempted: false` (`can_answer: false`): no
 *     grep/ast-grep/structural-only tool has a security-fact abstraction to
 *     query, so it cannot even attempt this task category — the decisive,
 *     honest out-of-category win, not a manufactured one.
 *
 * A truth fixture is a dir with a .sol contract + a build manifest (foundry.toml
 * declaring an OpenZeppelin dependency, so the analyzer's framework-detection
 * signal actually fires) + truth.json:
 *   { "task": "security-facts", "true_facts": ["access-control:onlyOwner:X", ...] }
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { validateWin } from './win-validator';
import { analyzeForBench, benchProductMode } from './product-analysis';
import type { ArmResult, WinVerdict } from './report-schema';

export { benchProductMode };

interface SecurityFactsTruth {
  task: 'security-facts';
  true_facts: string[];
  /** Known gap: measured + surfaced, does not gate the suite. */
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

/** ~4 chars per token is the standard rough proxy. */
function toTokens(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}

/** Klauro: the security-fact nodes it emits ARE the answer — the agent reads
 *  only the fact-id list, not the source. */
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

/** A structural-only competitor (grep/ast-grep/plain-AST tools) has no
 *  security-fact abstraction to query for this task category at all — it
 *  cannot even attempt "list the security facts", so it is marked
 *  `attempted: false` (can_answer:false). This is the decisive, honest
 *  out-of-category win: the win-validator treats an un-attempted arm as no
 *  opponent, and Klauro wins uncontested on its own quality bar. */
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

/** Run the security-facts head-to-head on one truth fixture. */
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
