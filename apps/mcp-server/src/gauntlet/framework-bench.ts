



















import * as fs from 'fs-extra';
import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import { routeIdentities } from './route-identity';
import { getRouteTable } from '../query';
import { validateWin } from './win-validator';
import type { ArmResult, WinVerdict } from './report-schema';

interface RouteTruth {
  task: 'route-facts';

  true_routes: string[];
}

export interface FrameworkBenchResult {
  fixture: string;
  arms: ArmResult[];
  verdict: WinVerdict;
  detail: Array<{ arm: string; routes: string[]; f1: number; bytes: number; can_answer: boolean }>;
}

function f1(produced: string[], truth: string[]): number {
  const prod = [...new Set(routeIdentities(produced))];
  const expected = routeIdentities(truth);
  const tp = prod.filter(r => expected.includes(r)).length;
  const precision = prod.length ? tp / prod.length : expected.length ? 0 : 1;
  const recall = expected.length ? tp / expected.length : 1;
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

    }
  }
  return total;
}


async function klauroRoutes(dir: string): Promise<{ routes: string[]; bytes: number; time_ms: number }> {
  const t0 = Date.now();
  const cas: any = await analyzeForBench(dir);
  const time_ms = Date.now() - t0;
  const rt: any = getRouteTable(cas, { limit: 500 });
  const routes: string[] = (rt?.routes || []).map((r: any) => `${r.method} ${r.path}`);
  const answer = routes.join('\n');
  return { routes, bytes: Buffer.byteLength(answer, 'utf8'), time_ms };
}






export async function runRouteFactsBench(fixtureDir: string): Promise<FrameworkBenchResult> {
  const truth: RouteTruth = await fs.readJson(path.join(fixtureDir, 'truth.json'));
  const kl = await klauroRoutes(fixtureDir);
  const srcBytes = await sourceBytes(fixtureDir);

  const klQuality = Math.round(f1(kl.routes, truth.true_routes) * 100);
  const arms: ArmResult[] = [
    {
      arm_id: 'klauro',
      mode: 'engine',
      attempted: true,
      metrics: { quality: klQuality, time_ms: kl.time_ms, tokens: toTokens(kl.bytes) },
      source: 'framework-bench:route-facts',
    },
  ];
  const detail: FrameworkBenchResult['detail'] = [
    { arm: 'klauro', routes: kl.routes, f1: klQuality / 100, bytes: kl.bytes, can_answer: true },
  ];




  for (const armId of ['scip-typescript', 'stack-graphs', 'embeddings-nomic', 'ripgrep']) {
    arms.push({
      arm_id: armId,
      mode: 'engine',





      attempted: false,
      metrics: { quality: 0, time_ms: 1, tokens: toTokens(srcBytes) },
      source: `framework-bench:route-facts:${armId}`,
    });
    detail.push({ arm: armId, routes: [], f1: 0, bytes: srcBytes, can_answer: false });
  }

  const verdict = validateWin(
    arms,
    'get_route_table emits method/path/controller/auth as a structured framework fact; embeddings and structural indexers have no route abstraction and can only return code to read.',
  );

  return { fixture: path.basename(fixtureDir), arms, verdict, detail };
}
