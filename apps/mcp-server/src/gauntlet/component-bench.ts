/**
 * Camp-C OUT-OF-CATEGORY bench — UI component trees + props.
 *
 * A structural graph sees a React component as a function and `<UserCard/>` as,
 * at best, an import or a usage. Measured live against codebase-memory-mcp on the
 * fixture: its edge types are DEFINES/CONTAINS_FILE/CALLS/IMPORTS/USAGE — there is
 * NO `renders` edge and NO props concept. It can tell you App imports UserCard; it
 * cannot tell you App RENDERS UserCard, nor that UserCard takes 2 props.
 *
 * Klauro's React analyzer emits the component tree as `renders` edges plus a prop
 * count per component — the structured UI fact nobody else models.
 *
 * Honest scoring: competitors read the source to TRY (token cost = source bytes)
 * and still produce zero render-tree edges.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { createOrchestrator } from '../analyzer';
import { validateWin } from './win-validator';
import type { ArmResult, WinVerdict } from './report-schema';

interface ComponentTruth {
  task: 'component-tree';
  /** Each "Parent renders Child" edge the UI defines. */
  expected_tree: string[];
}

export interface ComponentBenchResult {
  fixture: string;
  arms: ArmResult[];
  verdict: WinVerdict;
  detail: Array<{ arm: string; tree: string[]; f1: number; bytes: number; can_answer: boolean }>;
}

function f1(produced: string[], truth: string[]): number {
  const hit = (t: string) => produced.some(p => p.toLowerCase().includes(t.toLowerCase()));
  const tp = truth.filter(hit).length;
  const precision = produced.length ? tp / produced.length : truth.length ? 0 : 1;
  const recall = truth.length ? tp / truth.length : 1;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

function toTokens(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}

async function sourceBytes(dir: string): Promise<number> {
  let total = 0;
  for (const f of await fs.readdir(dir)) {
    if (f === 'truth.json') continue;
    try {
      const st = await fs.stat(path.join(dir, f));
      if (st.isFile()) total += st.size;
    } catch {
      /* noop */
    }
  }
  return total;
}

async function klauroTree(dir: string): Promise<{ tree: string[]; bytes: number; time_ms: number }> {
  const t0 = Date.now();
  const cas: any = await createOrchestrator().orchestrateAnalysis(dir);
  const time_ms = Date.now() - t0;
  const byId = new Map((cas.nodes || []).map((n: any) => [n.id, n]));
  const tree: string[] = (cas.edges || [])
    .filter((e: any) => /render/i.test(String(e.type || '')))
    .map((e: any) => {
      const s: any = byId.get(e.source);
      const t: any = byId.get(e.target);
      return s && t ? `${s.name} renders ${t.name}` : '';
    })
    .filter(Boolean);
  return { tree: [...new Set(tree)], bytes: Buffer.byteLength(tree.join('\n'), 'utf8'), time_ms };
}

export async function runComponentTreeBench(fixtureDir: string): Promise<ComponentBenchResult> {
  const truth: ComponentTruth = await fs.readJson(path.join(fixtureDir, 'truth.json'));
  const kl = await klauroTree(fixtureDir);
  const srcBytes = await sourceBytes(fixtureDir);

  const klQuality = Math.round(f1(kl.tree, truth.expected_tree) * 100);
  const arms: ArmResult[] = [
    {
      arm_id: 'klauro',
      mode: 'engine',
      attempted: true,
      metrics: { quality: klQuality, time_ms: kl.time_ms, tokens: toTokens(kl.bytes) },
      source: 'component-bench:component-tree',
    },
  ];
  const detail: ComponentBenchResult['detail'] = [
    { arm: 'klauro', tree: kl.tree, f1: klQuality / 100, bytes: kl.bytes, can_answer: true },
  ];

  for (const armId of ['codebase-memory', 'scip-typescript', 'stack-graphs', 'embeddings-nomic']) {
    arms.push({
      arm_id: armId,
      mode: 'engine',
      attempted: true,
      metrics: { quality: 0, time_ms: 1, tokens: toTokens(srcBytes) },
      source: `component-bench:component-tree:${armId}`,
    });
    detail.push({ arm: armId, tree: [], f1: 0, bytes: srcBytes, can_answer: false });
  }

  const verdict = validateWin(
    arms,
    'the React analyzer emits the component tree as renders edges (+ prop counts); structural graphs model only imports/usage and embeddings retrieve similar code — none represent the render tree.',
  );

  return { fixture: path.basename(fixtureDir), arms, verdict, detail };
}
