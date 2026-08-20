









































import * as fs from 'fs-extra';
import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import { getRouteTable } from '../query';
import { codebaseMemoryPath, runCodebaseMemoryJson, startCodebaseMemoryDaemon } from './real-camp-arms';

interface RouteTruth {
  task: 'route-facts';
  true_routes: string[];
}

export type RouteVerdict = 'tie-ceiling' | 'win' | 'loss';

export interface CampCRouteFrameworkResult {
  fixture: string;
  framework: string;
  truthRoutes: string[];
  klauroRoutes: string[];
  klauroF1: number;
  klauroTokens: number;
  cbmRoutes: string[];
  cbmF1: number;
  cbmTokens: number;

  cbmSource: string;
  verdict: RouteVerdict;
  tokenSaving: number;
}

export interface CampCRoutesVsCbmReport {
  available: boolean;
  results: CampCRouteFrameworkResult[];
  aggregate: {
    frameworks: number;
    klauroWins: number;
    ties: number;
    losses: number;
    winRate: number;
    meanKlauroF1: number;
    meanCbmF1: number;
    meanTokenSaving: number;
    lossFrameworks: string[];
  };
}

const FW_DIRS = [
  'express-routes', 'gin-routes', 'gin-groups', 'gorilla-routes', 'gorilla-subrouter',
  'fiber-routes', 'echo-routes', 'echo-groups', 'axum-routes', 'actix-routes',
  'rocket-routes', 'rails-routes', 'laravel-routes', 'symfony-routes', 'django-routes',
  'flask-routes', 'fastapi-routes', 'nestjs-routes', 'hono-routes', 'phoenix-routes',
  'spring-routes', 'quarkus-routes', 'micronaut-routes', 'ktor-routes', 'aspnet-routes',
  'vapor-routes', 'gorouter-routes', 'http4s-routes', 'kemal-routes', 'genie-routes',
  'compojure-routes', 'dream-routes', 'apexrest-routes', 'mojolicious-routes',
];

function f1(produced: string[], truth: string[]): number {
  const prod = [...new Set(produced)];
  const tp = prod.filter(r => truth.includes(r)).length;
  const precision = prod.length ? tp / prod.length : truth.length ? 0 : 1;
  const recall = truth.length ? tp / truth.length : 1;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

function toTokens(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}



function canonicalizePath(p: string): string {
  let s = p;
  s = s.replace(/\{[^}]*\}/g, ':id');
  s = s.replace(/<[^>]*:([A-Za-z_]\w*)>/g, ':$1');
  s = s.replace(/<([A-Za-z_]\w*)>/g, ':$1');

  s = s.replace(/:[A-Za-z_]\w*/g, ':id');
  if (!s.startsWith('/')) s = '/' + s;
  return s;
}


async function klauroRoutes(dir: string): Promise<{ routes: string[]; bytes: number }> {
  const cas: any = await analyzeForBench(dir);
  const rt: any = getRouteTable(cas, { limit: 500 });
  const routes: string[] = (rt?.routes || []).map((r: any) => `${r.method} ${canonicalizePath(String(r.path))}`);
  return { routes: [...new Set(routes)], bytes: Buffer.byteLength(routes.join('\n'), 'utf8') };
}






function cbmRoutes(bin: string, dir: string): { routes: string[]; bytes: number; source: string } {
  const project = dir.replace(/^\/+/, '').replace(/[^A-Za-z0-9_]+/g, '-');
  runCodebaseMemoryJson(bin, 'index_repository', ['--repo-path', dir, '--name', project]);


  let best: { routes: string[]; bytes: number; source: string } = { routes: [], bytes: 0, source: 'none' };

  const trySearch = (label: string, src: string) => {
    const parsed: any = runCodebaseMemoryJson(bin, 'search_graph', [
      '--project', project,
      '--label', label,
      '--format', 'json',
      '--limit', '100000',
    ]);
    const bytes = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
    const routes: string[] = [];
    const columns: string[] = parsed.cols || [];
    const nameIndex = Math.max(0, columns.indexOf('name'));
    for (const group of parsed.groups || []) {
      for (const row of group.rows || []) {
        const name = String(row[nameIndex] || '');
        const match = name.match(/__route__([A-Z]+)__(.*)$/);
        if (match) routes.push(`${match[1]} ${canonicalizePath(match[2])}`);
      }
    }
    const uniq = [...new Set(routes)];
    if (uniq.length > best.routes.length) best = { routes: uniq, bytes, source: src };
  };


  trySearch('Route', 'search_graph{label:Route}');
  trySearch('Endpoint', 'search_graph{label:Endpoint}');
  trySearch('HttpRoute', 'search_graph{label:HttpRoute}');



  const parsed: any = runCodebaseMemoryJson(bin, 'get_architecture', [JSON.stringify({ project })]);
  const architectureBytes = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
  const section: any[] = parsed.routes || parsed.endpoints || parsed.http || parsed.http_routes || [];
  const routes: string[] = [];
  for (const r of section) {
    const method = String(r.method || r.verb || '').toUpperCase();
    const p = String(r.path || r.name || '');
    if (method && p) routes.push(`${method} ${canonicalizePath(p)}`);
  }
  const uniq = [...new Set(routes)];
  if (uniq.length > best.routes.length) {
    best = { routes: uniq, bytes: architectureBytes, source: 'get_architecture' };
  }

  return best;
}

let cached: CampCRoutesVsCbmReport | null = null;











export async function buildCampCRoutesVsCbmReport(): Promise<CampCRoutesVsCbmReport> {
  if (cached) return cached;

  const fixturesRoot = path.join(__dirname, '..', '..', 'fixtures', 'framework-bench');
  const bin = codebaseMemoryPath();
  const binAvailable = bin != null;
  const daemon = bin ? startCodebaseMemoryDaemon(bin) : null;

  const results: CampCRouteFrameworkResult[] = [];
  try {
    for (const fxName of FW_DIRS) {
      const dir = path.join(fixturesRoot, fxName);
      let truth: RouteTruth;
      try {
        truth = await fs.readJson(path.join(dir, 'truth.json'));
      } catch {
        continue;
      }
      const truthRoutes = [...new Set(truth.true_routes)];

      const kl = await klauroRoutes(dir);
      const klauroF1 = f1(kl.routes, truthRoutes);

      const cbm = bin ? cbmRoutes(bin, dir) : { routes: [], bytes: 0, source: 'none' };
      const cbmF1 = f1(cbm.routes, truthRoutes);

    let verdict: RouteVerdict;
    if (cbmF1 > klauroF1 + 1e-9) verdict = 'loss';
    else if (cbmF1 >= klauroF1 - 1e-9 && cbm.routes.length > 0) verdict = 'tie-ceiling';
    else verdict = 'win';

    const klauroTokens = toTokens(kl.bytes);


    let cbmTokens: number;
    if (cbm.routes.length > 0) {
      cbmTokens = toTokens(cbm.bytes);
    } else {
      let srcBytes = 0;
      try {
        for (const f of await fs.readdir(dir)) {
          if (f === 'truth.json') continue;
          const st = await fs.stat(path.join(dir, f));
          if (st.isFile()) srcBytes += st.size;
        }
      } catch {   }
      cbmTokens = toTokens(srcBytes);
    }
    const tokenSaving = cbmTokens > 0 ? (cbmTokens - klauroTokens) / cbmTokens : 0;

      results.push({
        fixture: fxName,
        framework: fxName.replace(/-routes$|-groups$|-subrouter$/, '') || fxName,
        truthRoutes,
        klauroRoutes: kl.routes,
        klauroF1,
        klauroTokens,
        cbmRoutes: cbm.routes,
        cbmF1,
        cbmTokens,
        cbmSource: cbm.routes.length > 0 ? cbm.source : 'none',
        verdict,
        tokenSaving,
      });
    }
  } finally {
    daemon?.close();
  }

  const frameworks = results.length;
  const klauroWins = results.filter(r => r.verdict === 'win').length;
  const ties = results.filter(r => r.verdict === 'tie-ceiling').length;
  const losses = results.filter(r => r.verdict === 'loss').length;
  const lossFrameworks = results.filter(r => r.verdict === 'loss').map(r => r.framework);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  cached = {
    available: binAvailable,
    results,
    aggregate: {
      frameworks,
      klauroWins,
      ties,
      losses,

      winRate: frameworks ? (klauroWins + ties) / frameworks : 0,
      meanKlauroF1: mean(results.map(r => r.klauroF1)),
      meanCbmF1: mean(results.map(r => r.cbmF1)),
      meanTokenSaving: mean(results.map(r => r.tokenSaving)),
      lossFrameworks,
    },
  };
  return cached;
}


export function __resetCampCRoutesVsCbmCache(): void {
  cached = null;
}
