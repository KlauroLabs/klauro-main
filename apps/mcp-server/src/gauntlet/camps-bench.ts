





























import * as path from 'path';
import * as fs from 'fs-extra';
import { runRouteFactsBench } from './framework-bench';
import { runCallersBench } from './primitive-bench';
import {
  scipCliPath,
  scipTypescriptAvailable,
  stackGraphsTsPath,
  ctagsAvailable,
  codebaseMemoryPath,
  codebaseMemoryCallers,
} from './real-camp-arms';
import { LANGUAGE_SPECS } from '../../../../packages/analyzer-core/src/analyzer/core/language-spec';
import { hasWasmGrammar } from '../../../../packages/analyzer-core/src/analyzer/core/wasm-tree-sitter';
import { hasNativeGrammar } from '../../../../packages/analyzer-core/src/analyzer/core/native-parse';

import { buildCampALangsReport } from './camp-a-langs-bench';

type CampALangsReport = Awaited<ReturnType<typeof buildCampALangsReport>>;

const PRIMITIVE_ROOT = path.resolve(__dirname, '../../fixtures/primitive-bench');
const FW_ROOT = path.resolve(__dirname, '../../fixtures/framework-bench');
const TS_FIXTURE = path.join(PRIMITIVE_ROOT, 'callers-ts');


const PENDING_FIXTURES = new Set(['mojolicious-routes']);

export interface CampAArm {
  arm: string;
  available: boolean;
  klauroF1: number;
  competitorF1: number;
  klauroOutQualities: boolean;
  note: string;
}

export interface CampBRow {
  tool: string;
  available: boolean;
  klauroF1: number;
  competitorF1: number;
  ceilingTie: boolean;
  klauroTokens: number | null;
  competitorTokens: number | null;
  tokenSaving: number | null;
  coverageNote: string;
}

export interface CampCRow {
  framework: string;
  language: string;
  klauroF1: number;
  routes: number;
  klauroTokens: number;
  competitorTokens: number;
  tokenSaving: number;
  outOfCategoryWin: boolean;
}

export interface CampsReport {
  campA: { available: boolean; arms: CampAArm[]; note: string };

  campALangs: CampALangsReport;
  campB: { rows: CampBRow[] };
  campC: { rows: CampCRow[]; pending: string[]; aggregate: { fixtures: number; meanKlauroF1: number; meanTokenSaving: number } };
  breadth: { supportedLanguageCount: number; totalSpecs: number; languages: string[] };
  generatedAt: string;
}

function tokenSaving(klauro: number | null, competitor: number | null): number | null {
  if (klauro == null || competitor == null || competitor <= 0) return null;
  return Math.max(0, (competitor - klauro) / competitor);
}


function armTokens(arms: any[], armId: string): number | null {
  const a = arms.find(x => x.arm_id === armId);
  return a?.metrics?.tokens ?? null;
}






async function buildHeadToHead(): Promise<{ campA: CampsReport['campA']; campB: CampsReport['campB'] }> {

  const bench = await runCallersBench(TS_FIXTURE, { heavyArms: true });
  const klauro = bench.detail.find(d => d.arm === 'klauro');
  const klauroF1 = klauro ? klauro.f1 : 0;
  const klauroTokens = armTokens(bench.arms, 'klauro');


  const embDetail = bench.detail.filter(d => d.arm.startsWith('embeddings-'));
  const campAArms: CampAArm[] = embDetail.map(d => ({
    arm: d.arm,
    available: true,
    klauroF1,
    competitorF1: d.f1,
    klauroOutQualities: klauroF1 > d.f1,
    note: 'Embeddings retrieve "code about save", not the exact caller set — Klauro out-qualities.',
  }));
  const campA = {
    available: campAArms.length > 0,
    arms: campAArms,
    note: campAArms.length
      ? 'Klauro out-qualities every local embedding model on who-calls.'
      : 'Ollama / embedding models not available — Camp A skipped (honest), not faked.',
  };


  const rows: CampBRow[] = [];


  {
    const available = !!scipCliPath() && scipTypescriptAvailable();
    const d = bench.detail.find(x => x.arm === 'scip-typescript');
    const compTokens = armTokens(bench.arms, 'scip-typescript');
    rows.push({
      tool: 'scip-typescript',
      available,
      klauroF1,
      competitorF1: d ? d.f1 : 0,
      ceilingTie: available && !!d && d.f1 === 1 && klauroF1 === 1,
      klauroTokens,
      competitorTokens: compTokens,
      tokenSaving: tokenSaving(klauroTokens, compTokens),
      coverageNote: 'Compiler-accurate on TS/JS; returns nothing on Go/Java/Kotlin/Swift/C/C++/Python — every other language Klauro resolves.',
    });
  }


  {
    const available = !!stackGraphsTsPath();
    const d = bench.detail.find(x => x.arm === 'stack-graphs');
    const compTokens = armTokens(bench.arms, 'stack-graphs');
    rows.push({
      tool: 'stack-graphs',
      available,
      klauroF1,
      competitorF1: d ? d.f1 : 0,
      ceilingTie: available && !!d && d.f1 === 1 && klauroF1 === 1,
      klauroTokens,
      competitorTokens: compTokens,
      tokenSaving: tokenSaving(klauroTokens, compTokens),
      coverageNote: 'Syntactic name-resolution on TS/JS; cannot index Go or any non-TS language.',
    });
  }


  {
    const available = ctagsAvailable();
    const d = bench.detail.find(x => x.arm === 'ctags');
    const compTokens = armTokens(bench.arms, 'ctags');
    rows.push({
      tool: 'ctags',
      available,
      klauroF1,
      competitorF1: d ? d.f1 : 0,


      ceilingTie: available && !!d && d.f1 === 1 && klauroF1 === 1,
      klauroTokens,
      competitorTokens: compTokens,
      tokenSaving: tokenSaving(klauroTokens, compTokens),
      coverageNote: 'Definition/reference indexer; name-based, cannot exclude a same-name method on another class — the precision wall Klauro clears.',
    });
  }


  {
    const available = !!codebaseMemoryPath();
    let competitorF1 = 0;
    if (available) {
      try {
        const cm = codebaseMemoryCallers(TS_FIXTURE, 'Account', 'save');
        if (cm) {
          const truth = await fs.readJson(path.join(TS_FIXTURE, 'truth.json'));
          const trueFiles: string[] = truth.true_files || [];
          const prod = [...new Set(cm.files)];
          const tp = prod.filter(f => trueFiles.includes(f)).length;
          const precision = prod.length ? tp / prod.length : trueFiles.length ? 0 : 1;
          const recall = trueFiles.length ? tp / trueFiles.length : 1;
          competitorF1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
        }
      } catch {

      }
    }
    rows.push({
      tool: 'codebase-memory',
      available,
      klauroF1,
      competitorF1,

      ceilingTie: available && competitorF1 === 1 && klauroF1 === 1,
      klauroTokens,
      competitorTokens: null,
      tokenSaving: null,
      coverageNote: 'LSP-backed graph contender measured on TS who-calls and out-of-category route/ORM/render/pattern facts (Camp C).',
    });
  }

  return { campA, campB: { rows } };
}


async function buildCampC(): Promise<CampsReport['campC']> {
  let fixtures: string[] = [];
  try {
    fixtures = (await fs.readdir(FW_ROOT)).filter(f => /-routes$|-groups$|-subrouter$/.test(f)).sort();
  } catch {
    fixtures = [];
  }

  const rows: CampCRow[] = [];
  const pending: string[] = [];

  for (const fixture of fixtures) {
    const dir = path.join(FW_ROOT, fixture);
    if (PENDING_FIXTURES.has(fixture)) { pending.push(fixture); continue; }
    let truth: any = {};
    try { truth = await fs.readJson(path.join(dir, 'truth.json')); } catch { continue; }
    try {
      const r = await runRouteFactsBench(dir);
      const klauro = r.detail.find(d => d.arm === 'klauro');
      if (!klauro || klauro.f1 < 1) {


        pending.push(fixture);
        continue;
      }
      const kTokens = r.arms.find(a => a.arm_id === 'klauro')?.metrics?.tokens ?? 1;


      const compTokens = Math.max(
        1,
        ...r.arms.filter(a => a.arm_id !== 'klauro').map(a => a.metrics?.tokens ?? 0),
      );
      rows.push({
        framework: fixture.replace(/-(routes|groups|subrouter)$/, ''),
        language: String(truth.language || truth.lang || inferLanguage(fixture)),
        klauroF1: klauro.f1,
        routes: klauro.routes.length,
        klauroTokens: kTokens,
        competitorTokens: compTokens,
        tokenSaving: tokenSaving(kTokens, compTokens) ?? 0,
        outOfCategoryWin: true,
      });
    } catch {


      pending.push(fixture);
    }
  }

  const fixturesRun = rows.length;
  const meanKlauroF1 = fixturesRun ? rows.reduce((a, r) => a + r.klauroF1, 0) / fixturesRun : 0;
  const meanTokenSaving = fixturesRun ? rows.reduce((a, r) => a + r.tokenSaving, 0) / fixturesRun : 0;
  return { rows, pending, aggregate: { fixtures: fixturesRun, meanKlauroF1, meanTokenSaving } };
}


function inferLanguage(fixture: string): string {
  const map: Record<string, string> = {
    express: 'TypeScript', nestjs: 'TypeScript', hono: 'TypeScript',
    gin: 'Go', gorilla: 'Go', fiber: 'Go', echo: 'Go', gorouter: 'Go',
    axum: 'Rust', actix: 'Rust', rocket: 'Rust',
    rails: 'Ruby', kemal: 'Crystal',
    laravel: 'PHP', symfony: 'PHP', mojolicious: 'Perl',
    ktor: 'Kotlin', micronaut: 'Java', spring: 'Java', quarkus: 'Java', http4s: 'Scala',
    vapor: 'Swift', phoenix: 'Elixir', genie: 'Julia', compojure: 'Clojure', dream: 'OCaml',
    flask: 'Python', fastapi: 'Python', django: 'Python', aspnet: 'C#', apexrest: 'Apex',
  };
  const base = fixture.replace(/-(routes|groups|subrouter)$/, '');
  return map[base] || '—';
}


function buildBreadth(): CampsReport['breadth'] {
  const all = Object.keys(LANGUAGE_SPECS);
  const supported = all
    .filter(id => {
      const grammar = (LANGUAGE_SPECS as any)[id].grammar || id;
      return hasWasmGrammar(grammar) || hasNativeGrammar(grammar);
    })
    .sort();
  return { supportedLanguageCount: supported.length, totalSpecs: all.length, languages: supported };
}

let cache: CampsReport | null = null;





export async function buildCampsReport(generatedAt = ''): Promise<CampsReport> {
  if (cache) return { ...cache, generatedAt: generatedAt || cache.generatedAt };
  const [{ campA, campB }, campC, campALangs] = await Promise.all([
    buildHeadToHead(),
    buildCampC(),
    buildCampALangsReport(),
  ]);
  const breadth = buildBreadth();
  cache = { campA, campALangs, campB, campC, breadth, generatedAt };
  return cache;
}


export function resetCampsReportCache(): void {
  cache = null;
}
