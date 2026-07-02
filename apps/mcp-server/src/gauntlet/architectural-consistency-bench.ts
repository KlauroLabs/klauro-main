/**
 * Architectural-consistency bench — proves get_architectural_conflicts finds
 * a planted layering violation (a handler calling a repository directly
 * where the norm is handler -> service -> repository) and stays silent on
 * the consistent decoy handlers in the same fixture.
 *
 * BLACKBOX via analyzeForBench: no engine import, no model, no AI env — the
 * harness calls the product exactly like an MCP client would.
 *
 * Fixture: apps/mcp-server/fixtures/architectural-consistency-bench/layering-violation
 *   4 controllers follow handler -> service -> repository (the norm).
 *   1 controller (AdminController) calls the repository directly (planted).
 *   truth.json names the violating file and the clean decoy files.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import { getArchitecturalConflicts } from '../query';

interface ConsistencyTruth {
  task: 'architectural-consistency';
  expected_violation_files: string[];
  expected_clean_files: string[];
}

export interface ArchitecturalConsistencyBenchResult {
  fixture: string;
  found_violation_files: string[];
  flagged_clean_files: string[];
  precision: number;
  recall: number;
  f1: number;
  silent_on_decoys: boolean;
  is_cohesive: boolean;
  detail: unknown;
}

/**
 * Strip any absolute prefix so file paths compare against truth.json's
 * fixture-relative paths. analyzeForBench already reports files relative to
 * the fixture directory (no absolute prefix at all in the common case), so
 * the only real job here is defensively handling an absolute path if one
 * ever shows up. The historical version collapsed everything down to the
 * first `src/...`, which happened to work for the single-app fixture but is
 * WRONG for a monorepo fixture: `apps/api/src/x.ts` and
 * `apps/marketing-site/src/x.ts` would both collapse to the same `src/x.ts`
 * and become indistinguishable, silently corrupting per-scope matching. If
 * the fixture root directory name appears in the path, strip up through and
 * including it (handles an absolute path); otherwise the path is already
 * fixture-relative and is returned unchanged.
 */
function normalize(file: string, fixtureRootName: string): string {
  const marker = `/${fixtureRootName}/`;
  const idx = file.indexOf(marker);
  if (idx === -1) return file;
  return file.slice(idx + marker.length);
}

export async function runArchitecturalConsistencyBench(
  fixtureDir: string
): Promise<ArchitecturalConsistencyBenchResult> {
  const truth: ConsistencyTruth = await fs.readJson(path.join(fixtureDir, 'truth.json'));
  const cas: any = await analyzeForBench(fixtureDir);
  const result = getArchitecturalConflicts(cas, { limit: 100 });
  const fixtureRootName = path.basename(fixtureDir);

  // A pattern-conflict entry names BOTH sides: the norm (majority share, the
  // consistent shape) and the competing/deviating shape (minority share).
  // Only the minority side is the actual violation; the majority side is the
  // norm's own evidence and must not count as flagged.
  const flaggedFiles = new Set<string>();
  for (const conflict of (result.conflicts || []) as any[]) {
    const competing = conflict.competing || [];
    const minorityShare = Math.min(...competing.map((c: any) => c.share ?? 1));
    for (const competitor of competing) {
      if ((competitor.share ?? 1) !== minorityShare) continue;
      for (const file of competitor.files || []) flaggedFiles.add(normalize(file, fixtureRootName));
    }
  }
  for (const violation of (result.principle_violations || []) as any[]) {
    if (violation.file) flaggedFiles.add(normalize(violation.file, fixtureRootName));
  }

  const foundViolationFiles = truth.expected_violation_files.filter(f => flaggedFiles.has(f));
  const flaggedCleanFiles = truth.expected_clean_files.filter(f => flaggedFiles.has(f));

  const tp = foundViolationFiles.length;
  const fp = [...flaggedFiles].filter(f => !truth.expected_violation_files.includes(f)).length;
  const fn = truth.expected_violation_files.length - tp;
  const precision = tp + fp > 0 ? tp / (tp + fp) : (truth.expected_violation_files.length ? 0 : 1);
  const recall = truth.expected_violation_files.length > 0 ? tp / truth.expected_violation_files.length : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    fixture: path.basename(fixtureDir),
    found_violation_files: foundViolationFiles,
    flagged_clean_files: flaggedCleanFiles,
    precision,
    recall,
    f1,
    silent_on_decoys: flaggedCleanFiles.length === 0,
    is_cohesive: result.is_cohesive,
    detail: result,
  };
}
