/**
 * Single source of Klauro analysis for the gauntlet.
 *
 * By default this runs the in-process engine (fast, offline — for CI). When
 * KLAURO_BENCH_ANALYZER_URL is set, it instead drives the INSTALLED CLI against
 * that hosted service — the literal customer product (light work local, heavy work
 * + AI on the VPS). The returned CAS has the same shape either way, so every
 * downstream metric is identical; only the analysis SOURCE changes. This is how the
 * gauntlet tests the real product instead of a local library call.
 * See docs/KLAURO-PRODUCT-MODEL.md.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { createOrchestrator } from '../analyzer';
import { analyzeWithInstalledKlauro } from '../installed-klauro';

/** True when the gauntlet's Klauro arm is exercising the hosted product. */
export function benchProductMode(): boolean {
  return Boolean(process.env.KLAURO_BENCH_ANALYZER_URL);
}

/** Produce a Klauro CAS for a directory — in-process by default, hosted product
 *  when KLAURO_BENCH_ANALYZER_URL is set. */
export async function analyzeForBench(dir: string): Promise<any> {
  const url = process.env.KLAURO_BENCH_ANALYZER_URL;
  if (!url) return createOrchestrator().orchestrateAnalysis(dir);
  // Copy to a throwaway git repo so the remote source-snapshot builder is satisfied
  // and the checked-in fixture is never mutated.
  const tmp = path.join(os.tmpdir(), `klauro-bench-product-${process.pid}-${Math.random().toString(36).slice(2)}`);
  await fs.copy(dir, tmp, { filter: src => !/(^|\/)\.git(\/|$)/.test(src) });
  try {
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    execFileSync('git', ['add', '-A'], { cwd: tmp });
    execFileSync('git', ['-c', 'user.email=bench@klauro', '-c', 'user.name=bench', 'commit', '-qm', 'bench fixture'], { cwd: tmp });
    const res = await analyzeWithInstalledKlauro(tmp, { serverUrl: url, timeoutMs: 8 * 60 * 1000 });
    return res.output;
  } finally {
    await fs.remove(tmp).catch(() => undefined);
  }
}
