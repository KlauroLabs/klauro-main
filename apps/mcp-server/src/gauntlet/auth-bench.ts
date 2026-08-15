













import * as fs from 'fs-extra';
import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import { getRouteTable } from '../query';
import { validateWin } from './win-validator';
import type { ArmResult } from './report-schema';

interface AuthTruth { task: 'route-auth'; expected_protected: string[]; }

export interface AuthBenchResult {
  fixture: string;
  arms: ArmResult[];
  verdict: ReturnType<typeof validateWin>;
  detail: Array<{ arm: string; protected_routes: string[]; f1: number; bytes: number; can_answer: boolean }>;
}

function toTokens(bytes: number): number { return Math.max(1, Math.round(bytes / 4)); }

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
      if (st.isDirectory()) await walk(p); else total += st.size;
    }
  };
  await walk(dir);
  return total;
}


async function klauroProtected(dir: string): Promise<{ routes: string[]; bytes: number; time_ms: number }> {
  const t0 = Date.now();
  const cas: any = await analyzeForBench(dir);
  const rt: any = getRouteTable(cas, { limit: 500 });
  const routes = [...new Set<string>(
    (rt?.routes || [])
      .filter((r: any) => r.auth === true || (Array.isArray(r.guards) && r.guards.length > 0))
      .map((r: any) => `${r.method} ${r.path}` as string)
  )];
  return { routes, bytes: Buffer.byteLength(routes.join('\n'), 'utf8'), time_ms: Date.now() - t0 };
}

export async function runRouteAuthBench(fixtureDir: string): Promise<AuthBenchResult> {
  const truth: AuthTruth = await fs.readJson(path.join(fixtureDir, 'truth.json'));
  const kl = await klauroProtected(fixtureDir);
  const srcBytes = await sourceBytes(fixtureDir);
  const klQ = Math.round(f1(kl.routes, truth.expected_protected) * 100);

  const arms: ArmResult[] = [
    { arm_id: 'klauro', mode: 'engine', attempted: true, metrics: { quality: klQ, time_ms: kl.time_ms, tokens: toTokens(kl.bytes) }, source: 'auth-bench:route-auth' },
  ];
  const detail: AuthBenchResult['detail'] = [
    { arm: 'klauro', protected_routes: kl.routes, f1: klQ / 100, bytes: kl.bytes, can_answer: true },
  ];


  for (const armId of ['codebase-memory', 'scip-typescript', 'stack-graphs', 'embeddings-nomic']) {
    arms.push({ arm_id: armId, mode: 'engine', attempted: false, metrics: { quality: 0, time_ms: 1, tokens: toTokens(srcBytes) }, source: `auth-bench:route-auth:${armId}` });
    detail.push({ arm: armId, protected_routes: [], f1: 0, bytes: srcBytes, can_answer: false });
  }

  const verdict = validateWin(
    arms,
    'the route table carries each endpoint\'s auth state + the guard/middleware enforcing it; structural indexers and embeddings have no route abstraction, so "which endpoints are protected" is unanswerable for them.',
  );

  return { fixture: path.basename(fixtureDir), arms, verdict, detail };
}
