











































import * as fs from 'fs-extra';
import * as path from 'path';

import { LANGUAGE_SPECS } from '../../../../packages/analyzer-core/src/analyzer/core/language-spec';
import { hasWasmGrammar } from '../../../../packages/analyzer-core/src/analyzer/core/wasm-tree-sitter';
import { hasNativeGrammar } from '../../../../packages/analyzer-core/src/analyzer/core/native-parse';
import { FRAMEWORK_ANALYZERS } from '../../../../packages/analyzer-core/src/analyzer/frameworks';

import { runCallersBench } from './primitive-bench';
import { runRouteFactsBench } from './framework-bench';
import { runOrmRelationsBench } from './orm-bench';
import { runDiGraphBench } from './di-bench';
import { runGraphqlWiringBench } from './graphql-bench';
import { runMessagingWiringBench } from './messaging-bench';
import { runComponentTreeBench } from './component-bench';
import { runPatternFactsBench } from './pattern-bench';
import { runRouteAuthBench } from './auth-bench';
import { runTelemetryCorrelationBench } from './telemetry-bench';
import { runArchitectureLibraryBench } from './architecture-library-bench';
import { buildCampALangsReport } from './camp-a-langs-bench';
import type { ArmResult, WinVerdict } from './report-schema';

export type GridVerdict = 'win' | 'ceiling-tie' | 'loss' | 'uncovered';
export type RowKind = 'language' | 'framework' | 'library';

export interface GridCell {
  row: string;
  rowKind: RowKind;
  metric: string;
  klauroF1: number | null;
  competitorBestF1: number | null;
  verdict: GridVerdict;

  armsRan: string[];

  tokenSaving: number | null;
  note?: string;
}

export interface FullGridReport {
  cells: GridCell[];
  aggregate: {
    total: number;
    won: number;
    ceilingTied: number;
    uncovered: number;
    losses: number;

    winRate: number;

    coverage: number;
  };
  rows: {
    languages: { total: number; covered: number };
    frameworks: { total: number; covered: number };
    libraries: { total: number; covered: number };
  };
  losses: GridCell[];
  uncoveredList: { row: string; rowKind: RowKind; metric: string }[];
}

const FIXTURES = path.resolve(__dirname, '../../fixtures');





const PRIMITIVE_LANG_TO_BREADTH: Record<string, string> = {
  csharp: 'c_sharp',
};



function breadthLanguages(): string[] {
  return Object.keys(LANGUAGE_SPECS)
    .filter(id => {
      const grammar = (LANGUAGE_SPECS as any)[id].grammar || id;
      return hasWasmGrammar(grammar) || hasNativeGrammar(grammar);
    })
    .sort();
}


async function fixtureBreadthKey(fixtureDir: string): Promise<string | null> {
  try {
    const truth: any = await fs.readJson(path.join(fixtureDir, 'truth.json'));
    const lang = String(truth.lang || 'ts');

    const normalized = lang === 'ts' ? 'typescript' : lang;
    return PRIMITIVE_LANG_TO_BREADTH[normalized] || normalized;
  } catch {
    return null;
  }
}


async function fixtureDirs(group: string): Promise<string[]> {
  const root = path.join(FIXTURES, group);
  try {
    const entries = await fs.readdir(root);
    const dirs: string[] = [];
    for (const e of entries) {
      const p = path.join(root, e);
      try {
        if ((await fs.stat(p)).isDirectory()) dirs.push(p);
      } catch {

      }
    }
    return dirs.sort();
  } catch {
    return [];
  }
}







function distill(arms: ArmResult[], verdict: WinVerdict): {
  klauroF1: number | null;
  competitorBestF1: number | null;
  gridVerdict: 'win' | 'ceiling-tie' | 'loss';
  armsRan: string[];
  tokenSaving: number | null;
} {
  const klauro = arms.find(a => a.arm_id === 'klauro');
  const competitors = arms.filter(a => a.arm_id !== 'klauro' && a.attempted);

  const klauroF1 = typeof klauro?.metrics.quality === 'number' ? klauro.metrics.quality / 100 : null;
  const competitorBestF1 = competitors.length
    ? Math.max(...competitors.map(a => (typeof a.metrics.quality === 'number' ? a.metrics.quality / 100 : 0)))
    : null;



  let gridVerdict: 'win' | 'ceiling-tie' | 'loss';
  if (verdict.klauro_wins) {
    gridVerdict = verdict.quality_tied_at_ceiling ? 'ceiling-tie' : 'win';
  } else {
    gridVerdict = 'loss';
  }



  let tokenSaving: number | null = null;
  const tokenCmp = verdict.comparisons.find(c => c.metric === 'tokens');
  if (tokenCmp?.klauro_wins && typeof tokenCmp.advantage === 'number') {
    tokenSaving = tokenCmp.advantage;
  }

  return { klauroF1, competitorBestF1, gridVerdict, armsRan: competitors.map(a => a.arm_id), tokenSaving };
}


async function cellFromBench(
  row: string,
  rowKind: RowKind,
  metric: string,
  run: () => Promise<{ arms: ArmResult[]; verdict: WinVerdict }>,
): Promise<GridCell> {
  try {
    const { arms, verdict } = await run();
    const d = distill(arms, verdict);
    return {
      row,
      rowKind,
      metric,
      klauroF1: d.klauroF1,
      competitorBestF1: d.competitorBestF1,
      verdict: d.gridVerdict,
      armsRan: d.armsRan,
      tokenSaving: d.tokenSaving,
    };
  } catch (err) {


    return {
      row,
      rowKind,
      metric,
      klauroF1: null,
      competitorBestF1: null,
      verdict: 'uncovered',
      armsRan: [],
      tokenSaving: null,
      note: `bench threw: ${(err as Error)?.message || String(err)}`,
    };
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

let cache: FullGridReport | null = null;







export async function buildFullGrid(): Promise<FullGridReport> {
  if (cache) return cache;

  const cells: GridCell[] = [];




  const languages = breadthLanguages();
  const callerFixtures = await fixtureDirs('primitive-bench');
  const fixtureByBreadthKey = new Map<string, string>();
  for (const fx of callerFixtures) {
    const key = await fixtureBreadthKey(fx);
    if (key && !fixtureByBreadthKey.has(key)) fixtureByBreadthKey.set(key, fx);
  }

  const languageRows = new Set<string>(languages);
  const languageWhoCallCells = await mapLimit(languages, 8, async lang => {
    const fixtureDir = fixtureByBreadthKey.get(lang);
    if (fixtureDir) {


      return cellFromBench(lang, 'language', 'who-calls', () =>
          runCallersBench(fixtureDir, { heavyArms: true }),
      );
    }
    return {
        row: lang,
        rowKind: 'language',
        metric: 'who-calls',
        klauroF1: null,
        competitorBestF1: null,
        verdict: 'uncovered',
        armsRan: [],
        tokenSaving: null,
        note: 'no who-calls fixture',
    } satisfies GridCell;
  });
  cells.push(...languageWhoCallCells);



  const extraLanguageFixtures = [...fixtureByBreadthKey.entries()].filter(([key]) => {
    if (languageRows.has(key)) return false;
    languageRows.add(key);
    return true;
  });
  cells.push(
    ...(await mapLimit(extraLanguageFixtures, 8, async ([key, fixtureDir]) =>
      cellFromBench(key, 'language', 'who-calls', () => runCallersBench(fixtureDir, { heavyArms: true })),
    )),
  );









  const campALangs = await buildCampALangsReport();
  for (const p of campALangs.perLanguage) {
    if (!p.available) {


      cells.push({
        row: p.lang,
        rowKind: 'language',
        metric: 'structural-retrieval',
        klauroF1: null,
        competitorBestF1: null,
        verdict: 'uncovered',
        armsRan: [],
        tokenSaving: null,
        note: 'camp-a-langs: not measured (unsupported lang or no embedding arm)',
      });
      continue;
    }




    const verdict: GridVerdict = p.klauroWins ? 'win' : 'loss';
    cells.push({
      row: p.lang,
      rowKind: 'language',
      metric: 'structural-retrieval',
      klauroF1: p.klauroF1,
      competitorBestF1: p.embeddingF1,
      verdict,
      armsRan: p.embeddingModel ? [p.embeddingModel] : [],
      tokenSaving: null,
      note: p.embeddingModel ? `vs ${p.embeddingModel}` : 'klauro-only (no embedding model present)',
    });
  }




  const routeFixtures = await fixtureDirs('framework-bench');
  const routeFixtureNames = new Set(routeFixtures.map(d => path.basename(d)));



  const routeFixturesByFramework = new Map<string, string[]>();
  for (const fx of routeFixtures) {
    const base = path.basename(fx);
    const token = base.replace(/-(routes|groups|subrouter)$/, '');
    const fw = token.split('-')[0];
    const arr = routeFixturesByFramework.get(fw) || [];
    arr.push(fx);
    routeFixturesByFramework.set(fw, arr);
  }


  const FRAMEWORK_SLUG: Record<string, string> = {
    NestJS: 'nestjs',
    'Spring Boot': 'spring',
    Django: 'django',
    Flask: 'flask',
    FastAPI: 'fastapi',
    'Express.js': 'express',
    Laravel: 'laravel',
    Vapor: 'vapor',
    Mojolicious: 'mojolicious',
    GoRouter: 'gorouter',
    http4s: 'http4s',
    kemal: 'kemal',
    Genie: 'genie',
    Compojure: 'compojure',
    dream: 'dream',
    ApexREST: 'apexrest',
  };

  const FRONTEND_COMPONENT_FIXTURE: Record<string, string> = {
    React: 'react-tree',
    'Vue.js': 'vue-tree',
    Angular: 'angular-tree',
  };

  const webAnalyzers = FRAMEWORK_ANALYZERS.filter(a => a.category === 'web');
  const claimedFixtures = new Set<string>();
  const frameworkJobs: Array<() => Promise<GridCell>> = [];
  for (const a of webAnalyzers) {
    const componentFixture = FRONTEND_COMPONENT_FIXTURE[a.name];
    if (componentFixture) {
      const fixtureDir = path.join(FIXTURES, 'component-bench', componentFixture);
      frameworkJobs.push(() =>
        cellFromBench(a.name, 'framework', 'component-tree', () =>
          runComponentTreeBench(fixtureDir),
        ),
      );
      continue;
    }

    const slug = FRAMEWORK_SLUG[a.name] || a.name.toLowerCase();
    const fixturesForFw = routeFixturesByFramework.get(slug) || [];
    if (fixturesForFw.length === 0) {
      frameworkJobs.push(async () => ({
        row: a.name,
        rowKind: 'framework',
        metric: 'routes',
        klauroF1: null,
        competitorBestF1: null,
        verdict: 'uncovered',
        armsRan: [],
        tokenSaving: null,
        note: 'no route fixture',
      }));
      continue;
    }

    const primary = fixturesForFw.sort()[0];
    claimedFixtures.add(path.basename(primary));
    frameworkJobs.push(() => cellFromBench(a.name, 'framework', 'routes', () => runRouteFactsBench(primary)));
  }



  for (const fx of routeFixtures) {
    const base = path.basename(fx);
    if (claimedFixtures.has(base)) continue;
    frameworkJobs.push(() => cellFromBench(base, 'framework', 'routes', () => runRouteFactsBench(fx)));
  }
  void routeFixtureNames;
  cells.push(...(await mapLimit(frameworkJobs, 8, job => job())));





  const libraryBenches: Array<{
    group: string;
    metric: string;
    run: (dir: string) => Promise<{ arms: ArmResult[]; verdict: WinVerdict }>;
  }> = [
    { group: 'orm-bench', metric: 'orm-relations', run: runOrmRelationsBench },
    { group: 'di-bench', metric: 'di-graph', run: runDiGraphBench },
    { group: 'graphql-bench', metric: 'graphql-wiring', run: runGraphqlWiringBench },
    { group: 'messaging-bench', metric: 'messaging-wiring', run: runMessagingWiringBench },
    { group: 'component-bench', metric: 'component-tree', run: runComponentTreeBench },
    { group: 'pattern-bench', metric: 'design-pattern', run: runPatternFactsBench },
    { group: 'auth-bench', metric: 'route-auth', run: runRouteAuthBench },
    { group: 'telemetry-bench', metric: 'telemetry-correlation', run: runTelemetryCorrelationBench },
    { group: 'architecture-library-bench', metric: 'architecture-library-boundaries', run: runArchitectureLibraryBench },
  ];
  const libraryJobs: Array<() => Promise<GridCell>> = [];
  for (const lb of libraryBenches) {
    const dirs = await fixtureDirs(lb.group);
    for (const dir of dirs) {
      const row = path.basename(dir);
      libraryJobs.push(() => cellFromBench(row, 'library', lb.metric, () => lb.run(dir)));
    }
  }
  cells.push(...(await mapLimit(libraryJobs, 8, job => job())));


  const won = cells.filter(c => c.verdict === 'win').length;
  const ceilingTied = cells.filter(c => c.verdict === 'ceiling-tie').length;
  const uncovered = cells.filter(c => c.verdict === 'uncovered').length;
  const losses = cells.filter(c => c.verdict === 'loss');
  const total = cells.length;
  const covered = total - uncovered;
  const winRate = covered > 0 ? (won + ceilingTied) / covered : 0;
  const coverage = total > 0 ? covered / total : 0;

  const rowKindStats = (kind: RowKind) => {
    const inKind = cells.filter(c => c.rowKind === kind);
    return {
      total: inKind.length,
      covered: inKind.filter(c => c.verdict !== 'uncovered').length,
    };
  };

  cache = {
    cells,
    aggregate: { total, won, ceilingTied, uncovered, losses: losses.length, winRate, coverage },
    rows: {
      languages: rowKindStats('language'),
      frameworks: rowKindStats('framework'),
      libraries: rowKindStats('library'),
    },
    losses,
    uncoveredList: cells
      .filter(c => c.verdict === 'uncovered')
      .map(c => ({ row: c.row, rowKind: c.rowKind, metric: c.metric })),
  };
  return cache;
}


export function resetFullGridCache(): void {
  cache = null;
}
