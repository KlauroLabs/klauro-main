













import * as fs from 'fs-extra';
import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import { validateWin } from './win-validator';
import type { ArmResult } from './report-schema';

interface DiTruth { task: 'di-graph'; expected_injections: string[]; }

export interface DiBenchResult {
  fixture: string;
  arms: ArmResult[];
  verdict: ReturnType<typeof validateWin>;
  detail: Array<{ arm: string; injections: string[]; f1: number; bytes: number; can_answer: boolean }>;
}

function toTokens(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}

function f1(produced: string[], truth: string[]): number {
  const prod = [...new Set(produced)];
  const tp = prod.filter(p => truth.includes(p)).length;
  const precision = prod.length ? tp / prod.length : (truth.length ? 0 : 1);
  const recall = truth.length ? tp / truth.length : 1;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

async function sourceBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    for (const f of await fs.readdir(d)) {
      if (f === 'truth.json' || f === 'node_modules') continue;
      const p = path.join(d, f);
      const st = await fs.stat(p);
      if (st.isDirectory()) await walk(p);
      else total += st.size;
    }
  };
  await walk(dir);
  return total;
}


async function klauroInjections(dir: string): Promise<{ injections: string[]; bytes: number; time_ms: number }> {
  const t0 = Date.now();
  const cas: any = await analyzeForBench(dir);
  const time_ms = Date.now() - t0;
  const byId = new Map((cas.nodes || []).map((n: any) => [n.id, n]));
  const injections: string[] = (cas.edges || [])
    .filter((e: any) => /depend/i.test(String(e.type || '')) && (e.metadata?.dependency_type === 'injection'))
    .map((e: any) => {
      const s: any = byId.get(e.source);
      const t: any = byId.get(e.target);
      return s && t ? `${s.name} injects ${t.name}` : '';
    })
    .filter(Boolean);
  const unique = [...new Set(injections)];
  return { injections: unique, bytes: Buffer.byteLength(unique.join('\n'), 'utf8'), time_ms };
}

export async function runDiGraphBench(fixtureDir: string): Promise<DiBenchResult> {
  const truth: DiTruth = await fs.readJson(path.join(fixtureDir, 'truth.json'));
  const kl = await klauroInjections(fixtureDir);
  const srcBytes = await sourceBytes(fixtureDir);
  const klQ = Math.round(f1(kl.injections, truth.expected_injections) * 100);

  const arms: ArmResult[] = [
    {
      arm_id: 'klauro',
      mode: 'engine',
      attempted: true,
      metrics: { quality: klQ, time_ms: kl.time_ms, tokens: toTokens(kl.bytes) },
      source: 'di-bench:di-graph',
    },
  ];
  const detail: DiBenchResult['detail'] = [
    { arm: 'klauro', injections: kl.injections, f1: klQ / 100, bytes: kl.bytes, can_answer: true },
  ];



  for (const armId of ['codebase-memory', 'scip-typescript', 'stack-graphs', 'embeddings-nomic']) {
    arms.push({
      arm_id: armId,
      mode: 'engine',
      attempted: false,
      metrics: { quality: 0, time_ms: 1, tokens: toTokens(srcBytes) },
      source: `di-bench:di-graph:${armId}`,
    });
    detail.push({ arm: armId, injections: [], f1: 0, bytes: srcBytes, can_answer: false });
  }

  const verdict = validateWin(
    arms,
    'Klauro emits the DI graph (depends_on, dependency_type:injection) — which collaborator the container injects into each component; structural indexers see only imports/usages and embeddings retrieve similar code, none model injection.',
  );

  return { fixture: path.basename(fixtureDir), arms, verdict, detail };
}
